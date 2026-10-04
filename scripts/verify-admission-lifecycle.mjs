// Isolated local Docker runtime proof. This never SSHs, loads a Host profile,
// publishes a release or creates provider resources. Caddy acceptance is separate.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const evidenceRoot = path.join(repo, '.sporades/issue-73/evidence');
const config = path.join(repo, '.sporades/issue-73/config');
const driver = process.argv.includes('--driver-check');
if (process.argv.slice(2).some(arg => arg !== '--driver-check')) throw new Error('Usage: node scripts/verify-admission-lifecycle.mjs [--driver-check]');
await Promise.all([evidenceRoot, config].map(dir => mkdir(dir, {recursive:true})));
const id = randomBytes(6).toString('hex');
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
};
let stage, started = false, builtTools = false, builtBase = false;
const log = path.join(evidenceRoot, driver ? 'driver-run.log' : 'docker-run.log');
await writeFile(log, '');
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? repo,
    env: { ...process.env, SPORADES_CONFIG_DIR:config, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  } finally { clearTimeout(timer); }
}
try {
  if (driver) {
    await run(process.execPath, ['--test', '--test-concurrency=1', 'test/admission-lifecycle.acceptance.test.js'],
      {env:{SPORADES_ADMISSION_DRIVER_CHECK:'1'},timeout:480000});
    report.status = 'driver-check-passed';
    report.pending.push('all deployed Docker/mount/Host helper proof');
  } else {
    const host = process.env.DOCKER_HOST;
    if (host && !host.startsWith('unix://')) throw new Error('Remote Docker endpoints are prohibited');
    const context = (await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {timeout:5000})).stdout.trim();
    if (!context.startsWith('unix://')) throw new Error('Only a local Unix Docker context is supported');
    const socket = (host || context).slice('unix://'.length);
    report.dockerVersion = (await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {timeout:12000})).stdout.trim();
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
    builtTools = true;
    await run('docker', ['build', '--tag', toolsImage, buildContext]);
    builtBase = true; started = true;
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
    report.status = 'runtime-boundary-passed';
  }
} catch (error) {
  report.error = error.message;
  if (report.dockerVersion === undefined && !driver) report.status = 'docker-prerequisite-failed';
  process.exitCode = 1;
} finally {
  if (stage) for (const session of ['container','hosted']) {
    try { await writeFile(path.join(evidenceRoot, `lifecycle-${session}-docker.json`),
      await readFile(path.join(stage, `source/.sporades/issue-73/evidence/lifecycle-${session}-docker.json`))); }
    catch (error) { if (error.code !== 'ENOENT') report.cleanup.push({kind:'evidence',session,removed:false,error:error.message}); }
  }
  for (const [kind, name] of [[started && 'container',container],[builtBase && 'image',baseImage],[builtTools && 'image',toolsImage]]) {
    if (!kind) continue;
    try {
      let absent = false;
      try { await exec('docker', kind === 'container' ? ['inspect',name] : ['image','inspect',name], {timeout:15000}); }
      catch (error) {
        if (error.code === 1 && /No such (image|object|container)/i.test(error.stderr || '')) absent = true;
        else throw error;
      }
      if (!absent) await exec('docker', [kind === 'container' ? 'rm' : 'image', ...(kind === 'container' ? ['-f'] : ['rm']), name], {timeout:15000});
      report.cleanup.push({kind,name,removed:true,...(absent ? {alreadyAbsent:true} : {})});
    }
    catch (error) { report.cleanup.push({kind,name,removed:false,error:error.message}); process.exitCode = 1; }
  }
  if (stage && report.cleanup.every(item => item.removed)) await rm(stage, {recursive:true,force:true});
  await writeFile(path.join(evidenceRoot, driver ? 'driver-report.json' : 'docker-report.json'), JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
