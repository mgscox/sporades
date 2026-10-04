// Isolated local Docker runtime proof. This never SSHs, loads a Host profile,
// publishes a release or creates provider resources. Caddy acceptance is separate.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lifecycleOwnership } from '../test/support/admission-lifecycle-proof.js';

const exec = promisify(execFile);
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceBase = path.resolve(process.env.SPORADES_ADMISSION_RUN_ROOT || path.join(repo, '.sporades/issue-73/evidence'));
if (!evidenceBase.startsWith(repo + path.sep)) throw new Error('Proof evidence must remain inside the worktree');
const config = path.join(repo, '.sporades/issue-73/config');
const driver = process.argv.includes('--driver-check');
if (process.argv.slice(2).some(arg => arg !== '--driver-check')) throw new Error('Usage: node scripts/verify-admission-lifecycle.mjs [--driver-check]');
const id = randomBytes(6).toString('hex');
const evidenceRoot = path.join(evidenceBase, `run-${id}`);
await Promise.all([evidenceRoot, config].map(dir => mkdir(dir, {recursive:true})));
const container = `sporades-proof-runner-${id}`;
const toolsImage = `sporades-proof-tools-${id}`;
const baseImage = `sporades-proof-base-${id}`;
const report = { mode: driver ? 'native-driver-check' : 'isolated-local-docker', status: 'incomplete',
  commit: (await exec('git', ['rev-parse', 'HEAD'], {cwd:repo})).stdout.trim(),
  manifestDigest: createHash('sha256').update(await readFile(path.join(repo, 'dist/generated-source-manifest.json'))).digest('hex'),
  scenarioDigest: createHash('sha256').update(await readFile(path.join(repo, 'test/admission-lifecycle.acceptance.test.js'))).digest('hex'),
  workingTreeDirty: Boolean((await exec('git', ['status', '--porcelain'], {cwd:repo})).stdout.trim()),
  pending: ['actual Host lifecycle/Caddy publication, socket-derived Hosted identity, File response streaming and operator drill'],
  cleanup: [],
  evidenceRoot,
};
const ownership = lifecycleOwnership(path.join(evidenceRoot, 'ownership.json'));
const interrupted = new AbortController();
let stage, activeChild, stopRunner;
const onSignal = signal => {
  report.interruption = signal;
  report.status = 'interrupted'; report.error = `Lifecycle runner interrupted by ${signal}`;
  process.exitCode = 1; interrupted.abort(new Error(report.error));
  const child = activeChild;
  if (child) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000); timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
};
const signalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => onSignal(signal)]));
for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);
const log = path.join(evidenceRoot, driver ? 'driver-run.log' : 'docker-run.log');
await writeFile(log, '');
async function run(command, args, options = {}) {
  interrupted.signal.throwIfAborted();
  const child = spawn(command, args, { cwd: options.cwd ?? repo,
    env: { ...process.env, SPORADES_CONFIG_DIR:config, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  const { appendFile } = await import('node:fs/promises');
  // Serialize writes so the retained log includes all output before the exit record.
  let writing = Promise.resolve();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    process.stdout.write(chunk); writing = writing.then(() => appendFile(log, chunk));
  });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, options.timeout ?? 600000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({code,signal}));
    });
    await writing;
    if (expired || result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}${expired ? ' (timeout)' : ''}; see ${log}`);
  } finally { clearTimeout(timer); activeChild = undefined; }
}
async function removeDocker(kind, name) {
  try { await exec('docker', kind === 'container' ? ['inspect',name] : ['image','inspect',name], {timeout:15000}); }
  catch (error) {
    if (error.code === 1 && /No such (image|object|container)/i.test(error.stderr || '')) return;
    throw error;
  }
  await exec('docker', [kind === 'container' ? 'rm' : 'image', ...(kind === 'container' ? ['-f'] : ['rm']), name], {timeout:15000});
}
try {
  if (driver) {
    // Direct node:test execution keeps signal handling in the process that owns
    // the fixture children, rather than terminating a --test coordinator first.
    await run(process.execPath, ['test/admission-lifecycle.acceptance.test.js'],
      {env:{SPORADES_ADMISSION_DRIVER_CHECK:'1',SPORADES_ADMISSION_PROOF_ROOT:path.join(evidenceRoot,'fixtures')},timeout:480000});
    interrupted.signal.throwIfAborted();
    report.status = 'driver-check-passed';
    report.pending.push('all deployed Docker/mount/Host helper proof');
  } else {
    const host = process.env.DOCKER_HOST;
    if (host && !host.startsWith('unix://')) throw new Error('Remote Docker endpoints are prohibited');
    const context = (await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {timeout:5000,signal:interrupted.signal})).stdout.trim();
    if (!context.startsWith('unix://')) throw new Error('Only a local Unix Docker context is supported');
    const socket = (host || context).slice('unix://'.length);
    report.dockerVersion = (await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {timeout:12000,signal:interrupted.signal})).stdout.trim();
    if (report.workingTreeDirty) throw new Error('Commit the proof checkout before running Docker acceptance; the runner archives a pinned commit');
    stage = await mkdtemp(path.join(repo, '.sporades/issue-73/linux-'));
    const source = path.join(stage, 'source'); await mkdir(source);
    const archive = path.join(stage, 'source.tar');
    await exec('git', ['archive', '--format=tar', '--output', archive, report.commit], {cwd:repo});
    await exec('tar', ['-xf', archive, '-C', source]);
    report.scenarioDigest = createHash('sha256').update(await readFile(path.join(source,'test/admission-lifecycle.acceptance.test.js'))).digest('hex');
    report.manifestDigest = createHash('sha256').update(await readFile(path.join(source,'dist/generated-source-manifest.json'))).digest('hex');
    // Preserve the host absolute path: child Capsule bind sources resolve through
    // the Docker daemon, rather than inside the runner's mount namespace.
    const buildContext = path.join(stage, 'tools'); await mkdir(buildContext);
    await writeFile(path.join(buildContext, 'Dockerfile'), 'FROM node:24.19.0-alpine\nRUN apk add --no-cache docker-cli python3 util-linux\n');
    await ownership.register('image', toolsImage, () => removeDocker('image', toolsImage), {stage});
    await run('docker', ['build', '--tag', toolsImage, buildContext]);
    await ownership.register('image', baseImage, () => removeDocker('image', baseImage), {stage});
    stopRunner = await ownership.register('container', container, () => removeDocker('container', container), {stage});
    const program = `
set -eu
npm ci --no-audit --no-fund
npm run build
docker build --tag '${baseImage}' --file Dockerfile.base .
SPORADES_REAL_ADMISSION_LIFECYCLE=1 SPORADES_ADMISSION_PROOF_BASE_IMAGE='${baseImage}' node --test --test-concurrency=1 test/admission-lifecycle.acceptance.test.js
`;
    const mountedSocket = process.platform === 'darwin' ? '/var/run/docker.sock' : socket;
    const {stat} = await import('node:fs/promises');
    const socketGroup = process.platform === 'darwin' ? 0 : (await stat(socket)).gid;
    await run('docker', ['run', '--init', '--name', container, '--user', `${process.getuid()}:${process.getgid()}`, '--group-add', String(socketGroup),
      '--volume', `${mountedSocket}:/var/run/docker.sock`, '--volume', `${source}:${source}`, '--workdir', source,
      '--env', 'DOCKER_HOST=unix:///var/run/docker.sock', '--env', `NPM_CONFIG_CACHE=${source}/.npm-cache`,
      '--env', `SPORADES_CONFIG_DIR=${source}/.sporades/config`, toolsImage, 'sh', '-c', program], {timeout:900000});
    for (const session of ['container','hosted']) await writeFile(path.join(evidenceRoot, `lifecycle-${session}-docker.json`),
      await readFile(path.join(source, `.sporades/issue-73/evidence/lifecycle-${session}-docker.json`)));
    interrupted.signal.throwIfAborted(); report.status = 'runtime-boundary-passed';
  }
} catch (error) {
  report.error = error.message;
  if (!interrupted.signal.aborted && report.dockerVersion === undefined && !driver) report.status = 'docker-prerequisite-failed';
  process.exitCode = 1;
} finally {
  // The writer must be gone before the authoritative inventory. In particular,
  // a failed first removal may leave it creating children during the retry.
  let runnerTerminated = !stopRunner;
  if (stopRunner) {
    for (let attempt = 0; !runnerTerminated && attempt < 2; attempt++) {
      try { await stopRunner(); runnerTerminated = true; }
      catch (error) { report.runnerTerminationError = error.message; }
    }
    report.runnerTermination = { name: container, confirmed: runnerTerminated };
  }
  let childCleanupFailed = !runnerTerminated;
  report.childOwnershipScan = runnerTerminated ? 'complete' : 'blocked-runner-termination';
  report.childOwnership = [];
  if (!runnerTerminated) report.pending.push('Child ownership inventory/recovery after confirmed runner termination');
  const proofRoot = driver ? path.join(evidenceRoot,'fixtures') : stage && path.join(stage,'source/.sporades/issue-73');
  if (proofRoot && runnerTerminated) {
    try {
      for (const directory of (await readdir(proofRoot)).filter(name => name.startsWith('lifecycle-'))) {
        try {
          const records = JSON.parse(await readFile(path.join(proofRoot,directory,'ownership.json'),'utf8'));
          report.childOwnership.push(...records);
          if (records.some(record => record.journalErrors?.length)) childCleanupFailed = true;
          for (const record of records) {
            if (record.removed) {
              report.cleanup.push({...record,source:'child-journal'});
              continue;
            }
            if (record.kind === 'container' && /^sporades-lifecycle-(container|hosted)-[a-f0-9]{12}$/.test(record.name)) {
              try { await ownership.register('container',record.name,() => removeDocker('container',record.name), {stage}); }
              catch (error) { report.cleanup.push({kind:'ownership',name:record.name,removed:false,error:error.message}); }
            } else {
              childCleanupFailed = true;
              report.cleanup.push({kind:record.kind,name:record.name,removed:false,error:'Child ownership requires manual recovery'});
            }
          }
        } catch (error) {
          // Before registration a fixture may exist without a journal, but no
          // resource can have launched. Other unreadable journals require recovery.
          if (error.code !== 'ENOENT') {
            childCleanupFailed = true;
            report.childOwnershipScan = 'failed';
            report.cleanup.push({kind:'ownership',fixture:path.join(proofRoot,directory),removed:false,error:error.message});
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { childCleanupFailed = true; report.childOwnershipScan = 'failed'; report.cleanup.push({kind:'ownership',removed:false,error:error.message}); }
    }
  }
  if (stage) for (const session of ['container','hosted']) {
    try { await writeFile(path.join(evidenceRoot, `lifecycle-${session}-docker.json`),
      await readFile(path.join(stage, `source/.sporades/issue-73/evidence/lifecycle-${session}-docker.json`))); }
    catch (error) { if (error.code !== 'ENOENT') report.cleanup.push({kind:'evidence',session,removed:false,error:error.message}); }
  }
  // Never retry the writer after the inventory. An uncertain writer stays owned
  // for manual recovery; a confirmed one already has its removal receipt.
  report.cleanup.push(...await ownership.cleanup(2, record => !stopRunner || record.name !== container));
  if (childCleanupFailed || report.cleanup.some(item => !item.removed || item.journalErrors?.length)) {
    process.exitCode = 1;
    report.status = 'cleanup-failed';
    if (stage) report.retainedStage = stage;
    // Retain the stage whenever termination, inventory or removal is incomplete.
  } else if (stage) await rm(stage, {recursive:true,force:true});
  for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  await writeFile(path.join(evidenceRoot, driver ? 'driver-report.json' : 'docker-report.json'), JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
