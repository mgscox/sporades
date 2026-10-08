import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repository, 'scripts', 'verify-monitoring-release.mjs');
const preload = path.join(repository, 'test', 'fixtures', 'monitoring-release-verifier-preload.mjs');
const random = randomBytes(5).toString('hex');
const testRoot = path.join(repository, '.sporades', `monitoring-release-verifier-${process.pid}-${random}`);
const artifactDir = path.join(testRoot, 'artifacts');
const configDir = path.join(testRoot, 'config');
const npmCache = path.join(testRoot, 'npm-cache');
const tempDir = path.join(testRoot, 'tmp');
const dropCounter = path.join(testRoot, 'dropped-spans.txt');
const packageJson = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
const npmArtifact = path.join(artifactDir, `sporades-${packageJson.version}.tgz`);
const monitoringArtifact = path.join(artifactDir, `sporades-monitoring-trace-${packageJson.version}.tar.gz`);
const ownedRuns = new Set();

function reportOf(result) {
  assert.equal(result.timedOut, false, result.stderr);
  assert(result.stdout.trim(), `verifier produced no report: ${result.stderr}`);
  const report = JSON.parse(result.stdout.trim());
  const directory = path.resolve(repository, report.runDirectory);
  assert(directory.startsWith(path.join(repository, '.sporades', 'monitoring-release-verification', 'run-')));
  assert(path.basename(directory).includes(`-${result.pid}-`), 'cleanup must belong to this verifier process');
  ownedRuns.add(directory);
  return report;
}

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    SPORADES_CONFIG_DIR: configDir,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  }, extra);
  return env;
}

function run(command, args, { env, cwd = repository, timeoutMs = 30000, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hookError;
    const hook = Promise.resolve().then(() => onSpawn?.(child)).catch(error => { hookError = error; child.kill('SIGTERM'); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
      killTimer.unref();
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await hook;
      if (hookError) { reject(hookError); return; }
      resolve({ pid: child.pid, code, signal, timedOut, stdout, stderr });
    });
  });
}

before(async () => {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([mkdir(configDir), mkdir(npmCache), mkdir(tempDir)]);
  const pack = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', artifactDir], { env: isolatedEnv() });
  assert.equal(pack.code, 0, `npm pack failed: ${pack.stderr}`);
  assert.equal(pack.stdout.trim().split(/\r?\n/).at(-1), path.basename(npmArtifact));
  const release = await run(process.execPath, [path.join(repository, 'scripts', 'monitoring-stack-release.mjs'), monitoringArtifact], { env: isolatedEnv() });
  assert.equal(release.code, 0, `monitoring archive generation failed: ${release.stderr}`);
});

after(async () => {
  for (const directory of ownedRuns) await rm(directory, { recursive: true, force: true });
  await rm(testRoot, { recursive: true, force: true });
});

test('installed CLI failure spans dropped by the fixture receiver make verification fail', { timeout: 180000 }, async () => {
  const result = await run(process.execPath, ['--import', preload, verifier, npmArtifact, monitoringArtifact], {
    env: isolatedEnv({ SPORADES_OTLP_DROPPED_COUNTER: dropCounter }),
    timeoutMs: 150000,
  });
  const report = reportOf(result);
  const dropped = Number((await readFile(dropCounter, 'utf8')).trim());
  assert(dropped > 0, 'transport fault injection did not discard any failure spans');
  assert.equal(result.code, 1, `verifier credited missing failure spans\n${JSON.stringify(report, null, 2)}\n${result.stderr}`);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /SERVER trace 33333333333333333333333333333333/);
  assert.notEqual(report.privacy?.privateExceptionAbsentFromOtlp, true, 'verifier credited privateExceptionAbsentFromOtlp after the fixture receiver discarded failure spans');
});

test('required successful spans arriving seven seconds late are accepted within the deadline', { timeout: 180000 }, async () => {
  const counter = path.join(testRoot, 'delayed-spans.txt');
  const result = await run(process.execPath, ['--import', preload, verifier, npmArtifact, monitoringArtifact], {
    env: isolatedEnv({ SPORADES_OTLP_FAULT: 'delay-work', SPORADES_OTLP_DROPPED_COUNTER: counter }),
    timeoutMs: 150000,
  });
  const report = reportOf(result);
  assert(Number(await readFile(counter, 'utf8')) > 0, 'delayed-span fault did not exercise the receiver');
  assert.equal(result.code, 0, `verifier rejected valid delayed spans: ${report.error}`);
  assert.equal(report.status, 'passed');
  assert.equal(report.telemetry.failureServerSpanVerified, true);
});

for (const link of ['.sporades', '.sporades/monitoring-release-verification']) {
  test(`a symlinked ${link} cannot create evidence outside the candidate worktree`, async () => {
    const candidate = path.join(testRoot, link === '.sporades' ? 'runtime-link-candidate' : 'evidence-link-candidate');
    const outside = path.join(testRoot, `${path.basename(candidate)}-outside`);
    await mkdir(path.join(candidate, 'scripts'), { recursive: true });
    await mkdir(path.join(candidate, 'config'));
    await mkdir(outside);
    await copyFile(verifier, path.join(candidate, 'scripts', 'verify-monitoring-release.mjs'));
    if (link !== '.sporades') await mkdir(path.join(candidate, '.sporades'));
    await symlink(outside, path.join(candidate, link), 'dir');
    const result = await run(process.execPath, [path.join(candidate, 'scripts', 'verify-monitoring-release.mjs'), 'missing-package.tgz', 'missing-monitoring.tar.gz'], {
      env: isolatedEnv({ SPORADES_CONFIG_DIR: path.join(candidate, 'config') }),
      cwd: candidate,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(await readdir(outside), [], 'verifier wrote run/config/report state outside the worktree');
    assert.match(result.stderr, /inside the worktree/);
  });
}

test('complete installed-Capsule evidence credits the known failure trace', { timeout: 180000 }, async () => {
  // npm test exports this root-project setting; the verifier must not forward
  // it to the isolated installed package (npm 11 rejects project-scoped use).
  const result = await run(process.execPath, [verifier, npmArtifact, monitoringArtifact], { env: isolatedEnv({ npm_config_allow_scripts: 'true' }), timeoutMs: 150000 });
  const report = reportOf(result);
  assert.equal(result.code, 0, report.error);
  assert.equal(report.telemetry.failureTraceId, '3'.repeat(32));
  assert.equal(report.telemetry.failureServerSpanVerified, true);
  assert.equal(report.privacy.privateExceptionAbsentFromOtlp, true);
});

test('a required metric arriving seven seconds late is awaited despite other metric payloads', { timeout: 180000 }, async () => {
  const counter = path.join(testRoot, 'delayed-metrics.txt');
  const result = await run(process.execPath, ['--import', preload, verifier, npmArtifact, monitoringArtifact], {
    env: isolatedEnv({ SPORADES_OTLP_FAULT: 'delay-metric', SPORADES_OTLP_DROPPED_COUNTER: counter }), timeoutMs: 150000,
  });
  const report = reportOf(result);
  assert(Number(await readFile(counter, 'utf8')) > 0, 'required-metric delay was not injected');
  assert.equal(result.code, 0, report.error);
  assert(report.telemetry.metricNames.includes('process.memory.rss'));
});

for (const kind of ['monitoring', 'npm']) {
  test(`tampered ${kind} archive is rejected before Dev starts`, { timeout: 180000 }, async () => {
    const dir = path.join(testRoot, `tampered-${kind}`);
    await mkdir(dir);
    const source = kind === 'monitoring' ? monitoringArtifact : npmArtifact;
    const extraction = await run('tar', ['-xzf', source, '-C', dir], { env: isolatedEnv() });
    assert.equal(extraction.code, 0, extraction.stderr);
    const archiveRoot = kind === 'monitoring' ? `sporades-monitoring-trace-${packageJson.version}` : 'package';
    const altered = path.join(dir, archiveRoot, kind === 'monitoring' ? '.env.example' : 'README.md');
    await writeFile(altered, `${await readFile(altered, 'utf8')}\n# altered after packaging\n`);
    const output = path.join(testRoot, `tampered-${kind}.tar.gz`);
    const packed = await run('tar', ['-czf', output, '-C', dir, archiveRoot], { env: isolatedEnv({ COPYFILE_DISABLE: '1' }) });
    assert.equal(packed.code, 0, packed.stderr);
    const result = await run(process.execPath, [verifier, kind === 'npm' ? output : npmArtifact, kind === 'monitoring' ? output : monitoringArtifact], { env: isolatedEnv(), timeoutMs: 150000 });
    const report = reportOf(result);
    assert.equal(result.code, 1);
    assert.equal(report.status, 'failed');
    assert.match(report.error, kind === 'monitoring' ? /Monitoring archive hash mismatch: .env.example/ : /Installed package bytes differ from checkout: README.md/);
    assert.equal(report.devProcess, null);
  });
}

async function portClosed(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = closed => { socket.destroy(); resolve(closed); };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(1000, () => finish(false));
  });
}

test('SIGTERM interrupts verification and closes both owned listeners', { timeout: 180000 }, async () => {
  const result = await run(process.execPath, [verifier, npmArtifact, monitoringArtifact], {
    env: isolatedEnv(), timeoutMs: 150000,
    onSpawn: async child => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        assert(child.exitCode === null && child.signalCode === null, 'verifier exited before interruption');
        const ready = await fetch('http://127.0.0.1:5218/', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
        if (ready) { child.kill('SIGTERM'); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('owned Dev process did not become ready for interruption');
    },
  });
  const report = reportOf(result);
  assert.equal(result.code, 1);
  assert.equal(report.status, 'interrupted');
  assert.equal(report.signal, 'SIGTERM');
  assert.equal(await portClosed(5218), true);
  assert.equal(await portClosed(5219), true);
});
