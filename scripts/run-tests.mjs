import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createConnection } from 'node:net';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { testHarnessArgs } from './test-harness-args.mjs';
import { processes, systemMemory, descendants } from './test-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// testHarnessArgs passes the reporter as a file: URL: --test-reporter is loaded
// through the ESM loader, which on Windows rejects bare drive-letter paths.
const reporter = fileURLToPath(new URL('./test-reporter.mjs', import.meta.url));
const args = process.argv.slice(2);
const qa = args.includes('--qa');
const option = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const deadlineMs = Number(option('timeout-ms', qa ? 7200000 : 3600000));
const workerCap = Number(process.env.SPORADES_TEST_MAX_WORKERS ?? (qa ? 4 : 16));
const concurrency = Math.min(workerCap, Number(option('concurrency', Math.min(qa ? 4 : 16, workerCap, availableParallelism()))));
// Measured: the six largest measured trees peak at 3.3 GiB together against the
// 6,144 MiB cap, so the memory lane runs two at a time by default and the RSS
// watchdog (not a fixed concurrency of one) is what bounds it. Serialising this
// lane was 70% of the gate's wall time.
const heavyConcurrency = Math.min(workerCap, Number(option('heavy-concurrency', process.env.SPORADES_TEST_HEAVY_CONCURRENCY ?? 2)));
const memoryLimitMb = Number(option('memory-limit-mb', process.env.SPORADES_TEST_MEMORY_LIMIT_MB ?? (qa ? 6144 : Infinity)));
const freeFloorMb = Number(option('free-memory-floor-mb', process.env.SPORADES_TEST_FREE_MEMORY_FLOOR_MB ?? (qa ? 1536 : 0)));
const report = option('report', null);
const started = performance.now();
const completed = new Map();
const partial = new Map();
const skippedLanes = new Set();
const children = new Map();
const measurements = new Map();
const pendingTests = new Map();
const pressureCancellations = new Map();
const failuresBeforePressure = new Map();
const laneMeasurements = [];
const initialMemory = systemMemory();
const memory = { initialSwapFreeMb: initialMemory.swapFreeMb, minSwapFreeMb: initialMemory.swapFreeMb, limitMb: Number.isFinite(memoryLimitMb) ? memoryLimitMb : null, freeFloorMb, peakRssMb: 0, initialFreeMb: initialMemory.freeMb, minFreeMb: initialMemory.freeMb, freeMb: initialMemory.freeMb, swapFreeMb: initialMemory.swapFreeMb };
let resourceExhaustion = false, resourceReason, runningAtExhaustion = [], memoryTimer, currentLane;
function exhausted(reason) {
  if (resourceExhaustion || timedOut || interrupted) return;
  resourceExhaustion = true;
  resourceReason = reason;
  sampleMemoryEvidence();
  runningAtExhaustion = [...children.values()].map(c => c.file ? path.relative(root, c.file) : c.label);
  for (const state of children.values()) if (state.file) {
    pressureCancellations.set(state.file, Math.max(1, pendingTests.get(state.file) ?? 0));
    failuresBeforePressure.set(state.file, (partial.get(state.file) ?? completed.get(state.file))?.failed ?? 0);
  }
  console.error('RESOURCE PRESSURE ' + JSON.stringify({ reason, runningFiles: runningAtExhaustion, ...memory }));
  stop();
}
function sampleMemoryEvidence() {
  const system = systemMemory();
  memory.minFreeMb = Math.min(memory.minFreeMb, system.freeMb);
  memory.freeMb = system.freeMb;
  memory.swapFreeMb = system.swapFreeMb;
  if (system.swapFreeMb !== null) memory.minSwapFreeMb = Math.min(memory.minSwapFreeMb ?? Infinity, system.swapFreeMb);
}
function sampleMemory() {
  const snapshot = processes();
  const system = systemMemory();
  let rssMb = snapshot.find(p => p.pid === process.pid)?.rssMb ?? 0;
  for (const [child, state] of children) {
    const owned = descendants(snapshot, child.pid, state.owned);
    for (const p of owned) state.owned.set(p.pid, p.birth);
    const usage = owned.reduce((sum, p) => sum + p.rssMb, 0);
    state.peakRssMb = Math.max(state.peakRssMb, usage);
    rssMb += usage;
  }
  memory.peakRssMb = Math.max(memory.peakRssMb, rssMb);
  memory.minFreeMb = Math.min(memory.minFreeMb, system.freeMb);
  memory.freeMb = system.freeMb;
  memory.swapFreeMb = system.swapFreeMb;
  if (system.swapFreeMb !== null) memory.minSwapFreeMb = Math.min(memory.minSwapFreeMb ?? Infinity, system.swapFreeMb);
  if (currentLane) currentLane.peakRssMb = Math.max(currentLane.peakRssMb, rssMb);
  if (rssMb >= memoryLimitMb) exhausted('process-tree RSS cap crossed');
  else if (system.freeMb < freeFloorMb) exhausted('free-memory floor crossed');
  else if (system.oomKills > initialMemory.oomKills) exhausted('cgroup OOM kill observed');
}
function resourceError(text, state) {
  state.memoryText = ((state.memoryText ?? '') + (text ?? '')).slice(-4096);
  if (/FATAL ERROR:.*(?:heap|memory)|(?:Error|error):[^\n]*\bENOMEM\b/.test(state.memoryText)) state.memoryDiagnostic = true;
}
let timedOut = false, interrupted = false, infrastructureFailures = 0, selected = [], timer, socketAliases;
const helperCap = value => String(Math.max(1, Math.min(workerCap, 2, Math.floor(Number(value)) || 2)));
const env = {
  ...process.env,
  GOMAXPROCS: qa ? helperCap(process.env.GOMAXPROCS) : process.env.GOMAXPROCS || '2',
  ...(qa ? {
    UV_THREADPOOL_SIZE: helperCap(process.env.UV_THREADPOOL_SIZE),
    RAYON_NUM_THREADS: helperCap(process.env.RAYON_NUM_THREADS),
  } : {}),
  SPORADES_CONFIG_DIR: path.join(root, '.tmp/qa-config'),
  SPORADES_TEST_QA: qa ? '1' : '0',
  SPORADES_TEST_MAX_WORKERS: String(concurrency),
};
// A gate can itself be exercised by node --test without inheriting its IPC context.
delete env.NODE_TEST_CONTEXT;
const postgresVariables = ['SPORADES_POSTGRES_TEST_URL', 'SPORADES_TELEMETRY_POSTGRES_TEST_URL', 'SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL'];
// Measured >=512 MiB trees run alone; retain Capsule lifecycle/parser isolation.
// Calibration and all per-file measurements: docs/agents/qa-test-lanes.md.
const memoryHeavyFiles = new Set([
  "admission-evidence-lifecycle.test.js",
  "admission-lifecycle-proof.test.js",
  "collection-tunnel.test.js",
  "container-services-bundle.test.js",
  "container-services-lifecycle.test.js",
  "deploy-part-2.test.js",
  "deploy.test.js",
  "dev-part-2.test.js",
  "dev-part-3.test.js",
  "dev-part-4.test.js",
  "dev-part-5.test.js",
  "dev-part-6.test.js",
  "dev-stripe-origin.test.js",
  "dev.test.js",
  "doctor.test.js",
  "file-ingress.test.js",
  "host-db-inspection.test.js",
  "host-part-2.test.js",
  "host-part-3.test.js",
  "host.test.js",
  "html-document-injection.test.js",
  "human-identity-termination.test.js",
  "job-operator-inspection.test.js",
  "log-payload-config.test.js",
  "mail.test.js",
  "mcp-bridge.test.js",
  "monitoring-release-verifier.test.js",
  "password-reset-transport.test.js",
  "prerender-fragment.test.js",
  "prerender-placement.test.js",
  "public-assets.test.js",
  "public-origin-bundle.test.js",
  "public-origin-cli.test.js",
  "qa-runner.test.js",
  "require-auth.test.js",
  "required-server-env.test.js",
  "schedule-cli-inspection.test.js",
  "sealed-env.test.js",
  "server-bundle-module-graph.test.js",
  "stripe-team-billing-fake.test.js",
  "telemetry-jobs-bundle.test.js",
  "user-preferences.test.js",
  "websocket-admission-dev.test.js",
  "websocket-admission.test.js",
]);

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, killSignal: 'SIGKILL', stdio: 'ignore' });
    else {
      const snapshot = processes();
      const known = children.get(child)?.owned;
      const rootProcess = snapshot.find(p => p.pid === child.pid);
      const recycled = rootProcess && known?.has(child.pid) && known.get(child.pid) !== rootProcess.birth;
      const owned = descendants(snapshot, child.pid, known);
      for (const { pid } of owned.reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
      }
      try { if (!recycled) process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function stop() {
  for (const [child, state] of children) {
    kill(child);
    // A killed process may leave an inherited pipe open. The deadline must not
    // depend on that pipe's close event to reach the final summary.
    state.finish(1);
  }
}
function command(command, commandArgs, { structured = false, quiet = false, timeoutMs, file } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', structured ? 'pipe' : quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'pipe'] });
    let settled = false, commandTimer;
    const state = { file, label: commandArgs.join(' '), owned: new Map(), peakRssMb: 0, started: performance.now() };
    const newborn = processes().find(p => p.pid === child.pid);
    if (newborn) { state.owned.set(newborn.pid, newborn.birth); state.peakRssMb = newborn.rssMb; }
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      const remaining = descendants(processes(), child.pid, state.owned).filter(p => p.pid !== child.pid && p.rssMb > 0);
      for (const p of remaining) { try { process.kill(p.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); } }
      if (file) {
        const measurement = { peakRssMb: state.peakRssMb, wallMs: performance.now() - state.started, cleanedProcesses: remaining.map(p => p.pid), lane: currentLane?.name };
        measurements.set(file, measurement);
        if (report) console.log('QA_FILE ' + JSON.stringify({ file: path.relative(root, file), ...measurement }));
      }
      if (remaining.length && file) console.error(`CLEANUP ${path.relative(root, file)}: reaped ${remaining.length} surviving owned processes`);
      children.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(code ?? 1);
    };
    state.finish = finish;
    children.set(child, state);
    if (timeoutMs) commandTimer = setTimeout(() => { kill(child); finish(1); }, timeoutMs);
    if (structured) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try { progress(JSON.parse(line), state); }
        catch (error) { console.error('Invalid test progress:', error.message); infrastructureFailures++; }
      });
    }
    child.stderr?.on('data', chunk => { resourceError(chunk.toString(), state); process.stderr.write(chunk); });
    child.on('error', error => { if (error.code === 'ENOMEM') exhausted('child spawn ENOMEM'); if (!quiet) console.error(error.message); });
    child.on('close', (code, signal) => {
      if (!settled && signal === 'SIGKILL') exhausted('harness received SIGKILL');
      if (!settled && state.memoryDiagnostic && (signal === 'SIGABRT' || (!structured && code))) exhausted('child heap or allocation exhaustion');
      if (!settled) finish(code);
    });
  });
}
function progress({ type, data }, state) {
  if (type === 'test:stdout' || type === 'test:stderr') {
    resourceError(data.message, state);
    (type === 'test:stderr' ? process.stderr : process.stdout).write(data.message);
    return;
  }
  if (type === 'test:diagnostic') { console.log(data.message); return; }
  const file = data.entryFile ?? data.file;
  // The native file wrapper is not an additional registered test.
  const entry = state.file ?? file;
  if (type === 'test:enqueue' && data.entryFile && data.type !== 'suite') pendingTests.set(entry, (pendingTests.get(entry) ?? 0) + 1);
  if (type === 'test:complete') {
    if (data.details.resourceFailure || (data.details.resourceSignal === 'SIGABRT' && !data.details.capturedStderr && state.memoryDiagnostic)) exhausted('child memory allocation failure or SIGKILL');
    if (data.entryFile && data.details.type !== 'suite') pendingTests.set(entry, Math.max(0, (pendingTests.get(entry) ?? 0) - 1));
  }
  if (type === 'test:complete' && !resourceExhaustion && !data.details.passed && !data.skip && !data.todo) {
    console.error(`FAIL ${path.relative(root, data.file ?? root)}: ${data.name}\n${data.details.error ?? ''}`);
  }
  if (type === 'test:summary' && file) {
    if (resourceExhaustion) {
      const failed = failuresBeforePressure.get(file) ?? data.counts.failed;
      data.counts = { ...data.counts, failed, cancelled: data.counts.cancelled + Math.max(0, data.counts.failed - failed) };
    }
    const previous = completed.get(file);
    completed.set(file, { file: path.relative(root, file), ...data.counts, durationMs: previous?.durationMs ?? data.duration_ms });
    partial.delete(file);
    if (!previous) console.log(`${resourceExhaustion ? 'CANCELLED' : data.success ? 'PASS' : 'FAIL'} ${path.relative(root, file)} ${(data.duration_ms / 1000).toFixed(2)}s pass=${data.counts.passed} fail=${data.counts.failed} skip=${data.counts.skipped}`);
  } else if (type === 'test:complete' && !data.entryFile && file) {
    // Per-file summaries can be definition-ordered behind a hung earlier file.
    // File completion is immediate and establishes which files really finished.
    const counts = partial.get(file) ?? completed.get(file) ?? { passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
    if (!data.details.passed && !counts.failed && !counts.cancelled) { if (resourceExhaustion) counts.cancelled++; else counts.failed++; }
    completed.set(file, { ...counts, file: path.relative(root, file), durationMs: data.details.duration_ms });
    partial.delete(file);
  } else if (type === 'test:complete' && data.entryFile && data.details.type !== 'suite') {
    const counts = partial.get(file) ?? { passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
    if (data.skip) { counts.skipped++; skippedLanes.add(typeof data.skip === 'string' ? data.skip : `Opt-in test: ${data.name}`); }
    else if (data.todo) counts.todo++;
    else if (data.details.passed) counts.passed++;
    else if (resourceExhaustion) counts.cancelled++;
    else if (/cancelledByParent/.test(data.details.error ?? '')) counts.cancelled++;
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
  if (timedOut || interrupted || resourceExhaustion) return false;
  return await command(executable, commandArgs, { quiet: true, timeoutMs: 5000 }) === 0;
}

process.once('SIGINT', () => { interrupted = true; stop(); });
process.once('SIGTERM', () => { interrupted = true; stop(); });
try {
  if (!(memoryLimitMb > 0) || !Number.isFinite(freeFloorMb) || freeFloorMb < 0 || !Number.isInteger(workerCap) || workerCap < 1) throw Error('Positive memory limit, nonnegative floor and integer worker cap required');
  sampleMemory();
  memoryTimer = setInterval(sampleMemory, 100);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isInteger(concurrency) || concurrency < 1) throw Error('Positive timeout-ms and integer concurrency required');
  if (!Number.isInteger(heavyConcurrency) || heavyConcurrency < 1) throw Error('Positive integer heavy-concurrency required');
  timer = setTimeout(() => {
    sampleMemory();
    if (resourceExhaustion) return;
    timedOut = true;
    console.error(`Regression gate exceeded ${deadlineMs}ms`);
    stop();
  }, deadlineMs);
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
    if (timedOut || interrupted || resourceExhaustion) break;
    if (env[key] && !await databaseAvailable(env[key])) {
      delete env[key];
      skippedLanes.add(`${key}: PostgreSQL unavailable (3s loopback probe)`);
    }
  }
  const pythonFiles = new Set(['host.test.js', 'host-locks.test.js', 'host-part-2.test.js', 'host-part-3.test.js', 'host-backups.test.js', 'host-observability.test.js', 'host-observability-mail.test.js', 'host-inventory-reconnect.test.js', 'lifecycle-inventory.test.js']);
  if (!timedOut && !interrupted && !resourceExhaustion && !await available('python3', ['-c', 'import fcntl'])) {
    selected = selected.filter(file => {
      if (!pythonFiles.has(path.basename(file))) return true;
      const reason = `${path.basename(file)}: Python 3 with fcntl missing (Host lock emulator)`;
      skippedLanes.add(reason);
      completed.set(file, { file: path.relative(root, file), durationMs: 0, passed: 0, failed: 0, skipped: 1, cancelled: 0, todo: 0 });
      console.log(`SKIP ${reason}`);
      return false;
    });
  }
  if (!args.includes('--no-build') && !timedOut && !interrupted && !resourceExhaustion) {
    const buildCode = env.npm_execpath
      ? await command(process.execPath, [env.npm_execpath, 'run', 'build'])
      : process.platform === 'win32'
        ? await command('cmd.exe', ['/d', '/s', '/c', 'npm run build'])
        : await command('npm', ['run', 'build']);
    if (buildCode !== 0) {
      if (!resourceExhaustion) throw Error('Build failed');
    }
    if (timedOut || interrupted || resourceExhaustion) throw Error('Build interrupted');
    if (await command(process.execPath, ['scripts/check-generated-bin.mjs']) !== 0) throw Error('Generated CLI parity failed');
  }
  if (!timedOut && !interrupted && !resourceExhaustion) {
    const serial = [], parallel = [], heavy = [];
    for (const file of selected) {
      const source = await readFile(file, 'utf8');
      // PostgreSQL conformance files reset common public tables. Real service
      // acceptance can share image tags/ports and also runs alone.
      const sharedDatabase = postgresVariables.some(key => env[key]) && /postgres|database-adapter-(?:engines|conformance)/i.test(source);
      const realService = Object.entries(env).some(([key, value]) => value && source.includes(key) && /^SPORADES_.*(?:REAL_|DOCKER|ACCEPTANCE|STACK_DIRECTORY|TEST_ROOT|LEGACY_CLI_PATH)/.test(key));
      (sharedDatabase || realService || ["dev-watch.test.js", "container-services-dev.test.js", "oauth-provider-deadline.test.js", "facebook-oauth.test.js", "host-locks.test.js", "telemetry-websocket-bundle.test.js", "file-ingress-deadline.test.js"].includes(path.basename(file)) ? serial : qa && memoryHeavyFiles.has(path.basename(file)) ? heavy : parallel).push(file);
    }
    // Start the longest measured files together, so large late-alphabet
    // files do not extend the tail of the desk gate.
    const slow = [
      "collection-tunnel.test.js",
      "file-ingress.test.js",
      "job-scheduling.test.js",
      "host-part-2.test.js",
      "deploy-part-2.test.js",
      "deploy.test.js",
      "host-part-3.test.js",
      "dev-part-2.test.js",
      "database-adapter-conformance-coverage.test.js",
      "dev.test.js",
      "dev-part-3.test.js",
      "resource-transactions.test.js",
      "dev-part-5.test.js",
      "dev-part-6.test.js",
      "database-adapter.test.js",
      "host.test.js",
      "dev-part-4.test.js",
      "database-adapter-conformance-auth-storage.test.js",
      "team-destructive-policy.test.js",
      "monitoring-release-verifier.test.js",
      "stripe-webhook.test.js",
      "postgres-emitted-sql-quoting.test.js",
      "server-bundle-module-graph.test.js",
      "teams-runtime.test.js",
      "mail.test.js",
      "notification-intents.test.js",
      "teams.test.js",
      "oauth-provider.test.js",
      "monitoring-maintenance.test.js",
      "email-events.test.js",
      "table-acl.test.js",
      "job-retry-cancel.test.js",
      "user-journey-expiry.test.js",
      "telemetry-jobs-bundle.test.js",
      "stripe-job-retention.test.js",
      "public-assets.test.js",
      "team-create-admission.test.js",
      "password-reset.test.js",
      "resource-process.test.js",
      "human-identity-termination.test.js",
      "telemetry-websocket-bundle.test.js",
      "job-queue.test.js",
      "server-files.test.js",
      "job-time-domain.test.js",
      "public-origin-bundle.test.js",
      "team-billing-checkout-concurrency.test.js",
      "file-policy.test.js",
      "password-reset-transport.test.js",
      "facebook-oauth.test.js",
      "email-signup-transition.test.js",
    ];
    const priority = file => { const i = slow.indexOf(path.basename(file)); return i < 0 ? slow.length : i; };
    parallel.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const [name, files, limit] of [['parallel', parallel, concurrency], ['memory-heavy', heavy, heavyConcurrency], ['serial shared-service', serial, 1]]) {
      if (!files.length || timedOut || interrupted || resourceExhaustion) continue;
      console.log(`LANE ${name}: ${files.length} files; concurrency=${limit}`);
      currentLane = { name, concurrency: limit, peakRssMb: 0, started: performance.now() };
      laneMeasurements.push(currentLane);
      let next = 0;
      // Separate harnesses keep Node 22's ordered reporter from hiding progress
      // in another file when one hangs. The pool bounds independent files.
      await Promise.all(Array.from({ length: Math.min(limit, files.length) }, async () => {
        while (next < files.length && !timedOut && !interrupted && !resourceExhaustion) {
          const file = files[next++];
          const code = await command(process.execPath, testHarnessArgs({ reporter, file }), { structured: true, file });
          if (code && !resourceExhaustion && !completed.get(file)?.failed && !partial.get(file)?.failed) infrastructureFailures++;
        }
      }));
      currentLane.wallMs = performance.now() - currentLane.started;
      delete currentLane.started;
      currentLane = undefined;
    }
  }
} catch (error) {
  if (!resourceExhaustion) { console.error(error.stack); infrastructureFailures++; }
} finally {
  clearTimeout(timer);
  clearInterval(memoryTimer);
  stop();
  if (socketAliases) {
    try { await rm(socketAliases, { recursive: true, force: true }); }
    catch (error) { console.error(error.message); infrastructureFailures++; }
  }
  sampleMemoryEvidence();
  const totals = [...completed.values(), ...partial.values()].reduce((sum, c) => ({ pass: sum.pass + c.passed, fail: sum.fail + c.failed, cancelled: sum.cancelled + c.cancelled, skip: sum.skip + c.skipped, todo: sum.todo + c.todo }), { pass: 0, fail: 0, cancelled: 0, skip: 0, todo: 0 });
  const unfinishedFiles = selected.filter(file => !completed.has(file)).length;
  const cancelledByPressure = [...pressureCancellations].reduce((sum, [file, count]) => sum + Math.max(0, count - ((partial.get(file) ?? completed.get(file))?.cancelled ?? 0)), 0);
  const summary = {
    ...totals,
    fail: totals.fail + (resourceExhaustion ? 0 : totals.cancelled + infrastructureFailures + Number(timedOut || interrupted)),
    cancelled: totals.cancelled + cancelledByPressure,
    resourceExhaustion,
    failureKind: resourceExhaustion ? 'environment' : undefined,
    memory, resourceReason, runningAtExhaustion,
    unfinishedFiles, timedOut, interrupted,
    durationSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    skippedLanes: [...skippedLanes].sort(),
  };
  if (report) {
    try { await writeFile(report, JSON.stringify({ summary, lanes: laneMeasurements, files: selected.map(file => ({ file: path.relative(root, file), ...completed.get(file), ...measurements.get(file) })) }, null, 2) + '\n'); }
    catch (error) { console.error(error.message); summary.fail++; }
  }
  console.log('QA_SUMMARY ' + JSON.stringify(summary));
  if (resourceExhaustion) console.log('RESOURCE EXHAUSTION ' + JSON.stringify({ ...summary, peakMemoryMb: memory.peakRssMb, freeMemoryMb: memory.freeMb, swapFreeMb: memory.swapFreeMb }));
  process.exitCode = resourceExhaustion ? 75 : summary.fail || unfinishedFiles ? 1 : 0;
}
