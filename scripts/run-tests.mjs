import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createConnection } from 'node:net';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reporter = fileURLToPath(new URL('./test-reporter.mjs', import.meta.url));
const args = process.argv.slice(2);
const qa = args.includes('--qa');
const option = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const deadlineMs = Number(option('timeout-ms', qa ? 890000 : 3600000));
const concurrency = Number(option('concurrency', Math.min(16, availableParallelism())));
const report = option('report', null);
const started = performance.now();
const completed = new Map();
const partial = new Map();
const skippedLanes = new Set();
const children = new Map();
let timedOut = false, interrupted = false, infrastructureFailures = 0, selected = [], timer, socketAliases;
const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, '.tmp/qa-config'), SPORADES_TEST_QA: qa ? '1' : '0' };
// A gate can itself be exercised by node --test without inheriting its IPC context.
delete env.NODE_TEST_CONTEXT;
const postgresVariables = ['SPORADES_POSTGRES_TEST_URL', 'SPORADES_TELEMETRY_POSTGRES_TEST_URL', 'SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL'];

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, killSignal: 'SIGKILL', stdio: 'ignore' });
    else {
      // Host fixtures deliberately detach helpers. Snapshot actual descendants
      // before killing their parent, so those helpers cannot escape cleanup.
      const descendants = new Set([child.pid]);
      const parents = process.platform === 'linux' ? readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
          const fields = readFileSync(`/proc/${name}/stat`, 'utf8').split(') ').at(-1).split(' ');
          return [[Number(name), Number(fields[1])]];
        } catch { return []; }
      }) : (spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' }).stdout ?? '').trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
      let size;
      do {
        size = descendants.size;
        for (const [pid, parent] of parents) if (descendants.has(parent)) descendants.add(pid);
      } while (descendants.size !== size);
      for (const pid of [...descendants].reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function stop() {
  for (const [child, finish] of children) {
    kill(child);
    // A killed process may leave an inherited pipe open. The deadline must not
    // depend on that pipe's close event to reach the final summary.
    finish(1);
  }
}
function command(command, commandArgs, { structured = false, quiet = false, timeoutMs } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', structured ? 'pipe' : quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'] });
    let settled = false, commandTimer;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      children.delete(child);
      child.stdout?.destroy();
      child.unref();
      resolve(code ?? 1);
    };
    children.set(child, finish);
    if (timeoutMs) commandTimer = setTimeout(() => { kill(child); finish(1); }, timeoutMs);
    if (structured) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try { progress(JSON.parse(line)); }
        catch (error) { console.error('Invalid test progress:', error.message); infrastructureFailures++; }
      });
    }
    child.on('error', error => { if (!quiet) console.error(error.message); });
    child.on('close', code => {
      if (!settled) { kill(child); finish(code); }
    });
  });
}
function progress({ type, data }) {
  if (type === 'test:stdout' || type === 'test:stderr') {
    (type === 'test:stderr' ? process.stderr : process.stdout).write(data.message);
    return;
  }
  if (type === 'test:diagnostic') { console.log(data.message); return; }
  const file = data.entryFile ?? data.file;
  if (type === 'test:complete' && !data.details.passed && !data.skip && !data.todo) {
    console.error(`FAIL ${path.relative(root, data.file ?? root)}: ${data.name}\n${data.details.error ?? ''}`);
  }
  if (type === 'test:summary' && file) {
    const previous = completed.get(file);
    completed.set(file, { file: path.relative(root, file), ...data.counts, durationMs: previous?.durationMs ?? data.duration_ms });
    partial.delete(file);
    if (!previous) console.log(`${data.success ? 'PASS' : 'FAIL'} ${path.relative(root, file)} ${(data.duration_ms / 1000).toFixed(2)}s pass=${data.counts.passed} fail=${data.counts.failed} skip=${data.counts.skipped}`);
  } else if (type === 'test:complete' && !data.entryFile && file) {
    // Per-file summaries can be definition-ordered behind a hung earlier file.
    // File completion is immediate and establishes which files really finished.
    const counts = partial.get(file) ?? completed.get(file) ?? { passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
    if (!data.details.passed && !counts.failed && !counts.cancelled) counts.failed++;
    completed.set(file, { ...counts, file: path.relative(root, file), durationMs: data.details.duration_ms });
    partial.delete(file);
  } else if (type === 'test:complete' && data.entryFile && data.details.type !== 'suite') {
    const counts = partial.get(file) ?? { passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
    if (data.skip) { counts.skipped++; skippedLanes.add(typeof data.skip === 'string' ? data.skip : `Opt-in test: ${data.name}`); }
    else if (data.todo) counts.todo++;
    else if (data.details.passed) counts.passed++;
    else counts.failed++;
    partial.set(file, counts);
  }
}
async function databaseAvailable(url) {
  const target = new URL(url);
  return await new Promise(resolve => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    const finish = ok => { clearTimeout(timeout); socket.destroy(); resolve(ok); };
    const timeout = setTimeout(() => finish(false), 3000);
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}
async function available(executable, commandArgs) {
  if (timedOut || interrupted) return false;
  return await command(executable, commandArgs, { quiet: true, timeoutMs: 5000 }) === 0;
}

process.once('SIGINT', () => { interrupted = true; stop(); });
process.once('SIGTERM', () => { interrupted = true; stop(); });
try {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isInteger(concurrency) || concurrency < 1) throw Error('Positive timeout-ms and integer concurrency required');
  timer = setTimeout(() => { timedOut = true; console.error(`Regression gate exceeded ${deadlineMs}ms`); stop(); }, deadlineMs);
  await mkdir(env.SPORADES_CONFIG_DIR, { recursive: true });
  socketAliases = await mkdtemp(path.join(root, ".tmp/qa-sockets-"));
  env.SPORADES_TEST_SOCKET_ALIASES = socketAliases;
  selected = args.filter(a => !a.startsWith('--'));
  if (!selected.length) selected = (await readdir(path.join(root, 'test'))).filter(f => f.endsWith('.test.js')).map(f => `test/${f}`);
  selected = selected.map(f => path.resolve(f));
  // QA always uses disposable emulators. Explicit real-service selections belong
  // to the full/acceptance lanes, never ambient workstation credentials.
  if (qa) {
    for (const key of Object.keys(env)) {
      if (/^SPORADES_.*(?:REAL_|DOCKER|TEST_URL|TEST_ROOT|STACK_DIRECTORY|ACCEPTANCE|PROMTOOL_BIN|COMPOSE_TEST_BINARY|LEGACY_CLI_PATH)/.test(key) || /^SPORADES_(?:SERVICE_|.*POSTGRES)/.test(key) || /^SPORADES_(?:HOST_(?:LOGS_)?SMOKE_|ADMISSION_(?:DRIVER_CHECK|PROOF_ROOT))/.test(key) || /^(?:MJ_APIKEY_|MAILJET_SMTP_SMOKE_)/.test(key)) delete env[key];
    }
    skippedLanes.add('Real Docker/Host/provider/browser acceptance: opt-in; run documented acceptance commands separately');
    skippedLanes.add('PostgreSQL: no disposable SPORADES_POSTGRES_TEST_URL selected in QA');
  }
  const dockerFlags = Object.keys(env).filter(key => /^(?:SPORADES_REAL_|SPORADES_.*_DOCKER$|SPORADES_ACCESS_KEY_ACCEPTANCE$|SPORADES_FETCH_DOCKER$)/.test(key) && env[key] === '1' && !/BROWSER|REAL_HOST$/.test(key));
  if (env.SPORADES_LEGACY_CLI_PATH) dockerFlags.push('SPORADES_LEGACY_CLI_PATH');
  if (env.SPORADES_PROMTOOL_BIN) {
    const index = dockerFlags.indexOf('SPORADES_REAL_PROMTOOL');
    if (index !== -1) dockerFlags.splice(index, 1);
  }
  if (dockerFlags.length && !await available('docker', ['info', '--format', '{{.ServerVersion}}'])) {
    for (const key of dockerFlags) {
      delete env[key];
      skippedLanes.add(`${key}: Docker daemon unavailable (5s probe)`);
    }
  }
  for (const key of postgresVariables) {
    if (timedOut || interrupted) break;
    if (env[key] && !await databaseAvailable(env[key])) {
      delete env[key];
      skippedLanes.add(`${key}: PostgreSQL unavailable (3s loopback probe)`);
    }
  }
  const pythonFiles = new Set(['host.test.js', 'host-part-2.test.js', 'host-part-3.test.js', 'host-backups.test.js', 'host-observability.test.js', 'host-observability-mail.test.js', 'host-inventory-reconnect.test.js', 'lifecycle-inventory.test.js']);
  if (!await available('python3', ['-c', 'import fcntl'])) {
    selected = selected.filter(file => {
      if (!pythonFiles.has(path.basename(file))) return true;
      const reason = `${path.basename(file)}: Python 3 with fcntl missing (Host lock emulator)`;
      skippedLanes.add(reason);
      completed.set(file, { file: path.relative(root, file), durationMs: 0, passed: 0, failed: 0, skipped: 1, cancelled: 0, todo: 0 });
      console.log(`SKIP ${reason}`);
      return false;
    });
  }
  if (!args.includes('--no-build') && !timedOut && !interrupted) {
    const buildCode = env.npm_execpath
      ? await command(process.execPath, [env.npm_execpath, 'run', 'build'])
      : process.platform === 'win32'
        ? await command('cmd.exe', ['/d', '/s', '/c', 'npm run build'])
        : await command('npm', ['run', 'build']);
    if (buildCode !== 0) {
      throw Error('Build failed');
    }
    if (timedOut || interrupted) throw Error('Build interrupted');
    if (await command(process.execPath, ['scripts/check-generated-bin.mjs']) !== 0) throw Error('Generated CLI parity failed');
  }
  if (!timedOut && !interrupted) {
    const serial = [], parallel = [];
    for (const file of selected) {
      const source = await readFile(file, 'utf8');
      // PostgreSQL conformance files reset common public tables. Real service
      // acceptance can share image tags/ports and also runs alone.
      const sharedDatabase = postgresVariables.some(key => env[key]) && /postgres|database-adapter-(?:engines|conformance)/i.test(source);
      const realService = Object.entries(env).some(([key, value]) => value && source.includes(key) && /^SPORADES_.*(?:REAL_|DOCKER|ACCEPTANCE|STACK_DIRECTORY|TEST_ROOT|LEGACY_CLI_PATH)/.test(key));
      (sharedDatabase || realService || ["dev-watch.test.js", "container-services-dev.test.js", "oauth-provider-deadline.test.js", "facebook-oauth.test.js"].includes(path.basename(file)) ? serial : parallel).push(file);
    }
    // These files dominate the measured serial run. Start them together so a
    // large late-alphabet file does not extend the tail of the desk gate.
    const slow = [
      "host.test.js",
      "host-part-2.test.js",
      "host-part-3.test.js",
      "deploy.test.js",
      "deploy-part-2.test.js",
      "job-scheduling.test.js",
      "file-ingress.test.js",
      "collection-tunnel.test.js",
      "dev-part-2.test.js",
      "dev.test.js",
      "dev-part-3.test.js",
      "resource-transactions.test.js",
      "dev-part-6.test.js",
      "dev-part-5.test.js",
      "database-adapter-conformance-coverage.test.js",
      "dev-part-4.test.js",
      "monitoring-release-verifier.test.js",
      "postgres-emitted-sql-quoting.test.js",
      "database-adapter.test.js",
      "notification-intents.test.js",
      "mail.test.js",
      "team-destructive-policy.test.js",
      "stripe-webhook.test.js"
];
    const priority = file => { const i = slow.indexOf(path.basename(file)); return i < 0 ? slow.length : i; };
    parallel.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const [name, files, limit] of [['parallel', parallel, concurrency], ['serial shared-service', serial, 1]]) {
      if (!files.length || timedOut || interrupted) continue;
      console.log(`LANE ${name}: ${files.length} files; concurrency=${limit}`);
      let next = 0;
      // Separate harnesses keep Node 22's ordered reporter from hiding progress
      // in another file when one hangs. The pool bounds independent files.
      await Promise.all(Array.from({ length: Math.min(limit, files.length) }, async () => {
        while (next < files.length && !timedOut && !interrupted) {
          const file = files[next++];
          const code = await command(process.execPath, ['--test', `--test-concurrency=${limit}`, `--test-reporter=${reporter}`, file], { structured: true });
          if (code && !completed.get(file)?.failed && !partial.get(file)?.failed) infrastructureFailures++;
        }
      }));
    }
  }
} catch (error) {
  console.error(error.stack);
  infrastructureFailures++;
} finally {
  clearTimeout(timer);
  stop();
  if (socketAliases) {
    try { await rm(socketAliases, { recursive: true, force: true }); }
    catch (error) { console.error(error.message); infrastructureFailures++; }
  }
  const totals = [...completed.values(), ...partial.values()].reduce((sum, c) => ({ pass: sum.pass + c.passed, fail: sum.fail + c.failed + c.cancelled, skip: sum.skip + c.skipped, todo: sum.todo + c.todo }), { pass: 0, fail: 0, skip: 0, todo: 0 });
  const unfinishedFiles = selected.filter(file => !completed.has(file)).length;
  const summary = { ...totals, fail: totals.fail + infrastructureFailures + Number(timedOut || interrupted), unfinishedFiles, timedOut, interrupted, durationSeconds: Number(((performance.now() - started) / 1000).toFixed(2)), skippedLanes: [...skippedLanes].sort() };
  if (report) {
    try { await writeFile(report, JSON.stringify({ summary, files: [...completed.values()] }, null, 2) + '\n'); }
    catch (error) { console.error(error.message); summary.fail++; }
  }
  console.log('QA_SUMMARY ' + JSON.stringify(summary));
  process.exitCode = summary.fail || unfinishedFiles ? 1 : 0;
}
