import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readFile, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

async function fixture(t, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qa-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.test.js');
  await writeFile(file, source);
  return { dir, file };
}
function run(args, { qa = true, env = {}, build = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-tests.mjs', ...(qa ? ['--qa'] : []), ...(build ? [] : ['--no-build']), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', code => {
      const line = output.split('\n').find(line => line.startsWith('QA_SUMMARY '));
      resolve({ code, output, summary: line && JSON.parse(line.slice(11)) });
    });
  });
}
test('QA gate reports real passing, failing and skipped tests and exits unsuccessfully', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('passes', () => {});
    test('skips', { skip: 'fixture tool missing' }, () => {});
    test('fails', () => { throw Error('regression sentinel'); });`);
  const result = await run([file]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.summary.skip, 1);
  assert.match(result.output, /regression sentinel/);
  assert.ok(result.summary.skippedLanes.includes('fixture tool missing'));
});

for (const detached of [false, true]) test(`QA timeout prints partial totals and kills ${detached ? 'detached' : 'ordinary'} descendants`, { timeout: 15000 }, async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test';
    import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
    test('finished', () => {});
    test('hung', async () => {
      spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), 4000); setInterval(() => {}, 1000)")}, ${JSON.stringify('PLACEHOLDER')}], { detached: ${detached}, stdio: 'inherit' });
      await new Promise(() => {});
    });`);
  const marker = path.join(dir, 'leak');
  await writeFile(file, (await readFile(file, 'utf8')).replace('PLACEHOLDER', marker));
  const result = await run(['--timeout-ms=2000', file]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.timedOut, true);
  assert.equal(result.summary.pass, 1);
  assert.ok(result.summary.fail >= 1);
  assert.equal(result.summary.unfinishedFiles, 1);
  await new Promise(resolve => setTimeout(resolve, 4500));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});


test('full gate skips an explicitly selected Docker lane when Docker is missing', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test';
    test('Docker lane', { skip: !process.env.SPORADES_REAL_BASE_IMAGE && 'Docker unavailable' }, () => { throw Error('must not run'); });`);
  const result = await run([file], { qa: false, env: { PATH: dir, SPORADES_REAL_BASE_IMAGE: '1' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.skip, 1);
  assert.ok(result.summary.skippedLanes.some(reason => reason.includes('Docker daemon unavailable')));
});


test('QA overall deadline includes the build step', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test'; test('never reached', () => {});`);
  const marker = path.join(dir, 'build-started');
  const buildScript = path.join(dir, 'fake-npm.mjs');
  await writeFile(buildScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`);
  const result = await run(['--timeout-ms=2000', file], { build: true, env: { npm_execpath: buildScript } });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.timedOut, true);
  assert.equal(result.summary.pass, 0);
  assert.equal(result.summary.unfinishedFiles, 1);
  assert.equal(await readFile(marker, 'utf8'), 'started');
});


test('missing Python skips the named Host lock-emulator file', async t => {
  const { dir, file } = await fixture(t, `throw Error('Host fixture must not run without Python');`);
  const hostFile = path.join(dir, 'host-observability-mail.test.js');
  await rename(file, hostFile);
  const result = await run([hostFile], { env: { PATH: dir } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.skip, 1);
  assert.ok(result.summary.skippedLanes.some(reason => reason.includes('host-observability-mail.test.js: Python 3')));
});

test('explicitly selected shared-service files run serially', async t => {
  const { dir, file } = await fixture(t, '');
  const lock = path.join(dir, 'exclusive');
  const source = `import test from 'node:test';
    import { open, unlink } from 'node:fs/promises';
    // SPORADES_REAL_BASE_IMAGE selects the shared-service lane.
    test('holds shared state exclusively', async () => {
      const fd = await open(${JSON.stringify(lock)}, 'wx');
      try { await new Promise(resolve => setTimeout(resolve, 200)); }
      finally { await fd.close(); await unlink(${JSON.stringify(lock)}); }
    });`;
  await writeFile(file, source);
  const second = path.join(dir, 'second.test.js');
  await writeFile(second, source);
  const docker = path.join(dir, 'docker');
  await writeFile(docker, '#!/bin/sh\nexit 0\n');
  await chmod(docker, 0o755);
  const result = await run([file, second], { qa: false, env: { PATH: dir + path.delimiter + process.env.PATH, SPORADES_REAL_BASE_IMAGE: '1' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 2);
  assert.match(result.output, /LANE serial shared-service: 2 files; concurrency=1/);
});


test('QA overall deadline includes a prerequisite probe that ignores SIGTERM', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test'; test('never reached', () => {});`);
  const python = path.join(dir, 'python3');
  await writeFile(python, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  await chmod(python, 0o755);
  const result = await run(['--timeout-ms=500', file], { env: { PATH: dir } });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.timedOut, true);
  assert.equal(result.summary.pass, 0);
  assert.ok(result.summary.durationSeconds < 3, result.output);
});


test('a completed later file is counted when an earlier file hangs', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test'; test('hung', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });`);
  const second = path.join(dir, 'second.test.js');
  await writeFile(second, `import test from 'node:test'; test('done', () => {});`);
  const result = await run(['--timeout-ms=1000', '--concurrency=2', file, second]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.timedOut, true);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.unfinishedFiles, 1);
});


test('PostgreSQL selections serialize uppercase URL users and imported conformance surfaces', async t => {
  const { dir, file } = await fixture(t, '');
  const probe = createServer(socket => socket.end());
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  t.after(() => new Promise(resolve => probe.close(resolve)));
  const lock = path.join(dir, 'exclusive');
  const source = `import test from 'node:test';
    import { open, unlink } from 'node:fs/promises';
    test('holds shared database state exclusively', async () => {
      const fd = await open(${JSON.stringify(lock)}, 'wx');
      try { await new Promise(resolve => setTimeout(resolve, 200)); }
      finally { await fd.close(); await unlink(${JSON.stringify(lock)}); }
    });`;
  await writeFile(file, `if (!process.env.SPORADES_POSTGRES_TEST_URL) throw Error('database selection missing');\n` + source);
  const second = path.join(dir, 'second.test.js');
  await writeFile(path.join(dir, 'database-adapter-conformance.js'), 'export const fixture = true;');
  await writeFile(second, `import './database-adapter-conformance.js';\n` + source);
  const result = await run([file, second], { qa: false, env: { SPORADES_POSTGRES_TEST_URL: `postgres://fixture:fixture@127.0.0.1:${probe.address().port}/disposable` } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 2);
  assert.match(result.output, /LANE serial shared-service: 2 files; concurrency=1/);
});


test('QA Host smoke boundary ignores real-Host selections before invoking SSH', async t => {
  const { dir } = await fixture(t, '');
  const marker = path.join(dir, 'ssh-called');
  const ssh = path.join(dir, 'ssh');
  await writeFile(ssh, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(99);`);
  await chmod(ssh, 0o755);
  const result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^sporades host (bootstrap|register|list|logs|push) can .*real', 'test/host.test.js'], {
    timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, PATH: dir + path.delimiter + process.env.PATH, SPORADES_TEST_QA: '1', SPORADES_REAL_HOST: '1',
      SPORADES_HOST_SMOKE_SSH_TARGET: 'synthetic.invalid', SPORADES_HOST_SMOKE_DOMAIN: 'synthetic.invalid', SPORADES_HOST_SMOKE_REMOTE_ROOT: '/synthetic',
      SPORADES_HOST_SMOKE_SUBNAME: 'fixture', SPORADES_HOST_SMOKE_PUBLIC_URL: 'http://127.0.0.1:9', SPORADES_HOST_SMOKE_EXPECTED_TEXT: 'fixture',
      SPORADES_HOST_LOGS_SMOKE_SSH_TARGET: 'synthetic.invalid', SPORADES_HOST_LOGS_SMOKE_DOMAIN: 'synthetic.invalid', SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT: '/synthetic', SPORADES_HOST_LOGS_SMOKE_SUBNAME: 'fixture' },
  });
  assert.match(result.stdout, /SPORADES_REAL_HOST=1 on a disposable Host/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});


test('QA removes ambient integration paths, PostgreSQL variants, and service credentials', async t => {
  const variables = ['SPORADES_LEGACY_CLI_PATH', 'SPORADES_COMPOSE_TEST_BINARY', 'SPORADES_PROMTOOL_BIN', 'SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL', 'SPORADES_SERVICE_DATABASE_URL'];
  const { file } = await fixture(t, `import assert from 'node:assert/strict'; import test from 'node:test';
    test('isolated environment', () => { for (const key of ${JSON.stringify(variables)}) assert.equal(process.env[key], undefined, key); });`);
  const result = await run([file], { env: Object.fromEntries(variables.map(key => [key, 'synthetic-unavailable-selection'])) });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 1);
});

test('an expired overall deadline does not launch another prerequisite command', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test'; test('never reached', () => {});`);
  const marker = path.join(dir, 'python-started');
  await writeFile(path.join(dir, 'docker'), `#!${process.execPath}\nsetInterval(() => {}, 1000);`, { mode: 0o755 });
  await writeFile(path.join(dir, 'python3'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`, { mode: 0o755 });
  const result = await run(['--timeout-ms=500', file], { qa: false, env: { PATH: dir, SPORADES_REAL_VITE_CONTAINER: '1' } });
  assert.equal(result.summary.timedOut, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('the gate retains test diagnostics and stdout/stderr context', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('context', t => { t.diagnostic('diagnostic-canary'); console.log('stdout-canary'); console.error('stderr-canary'); });`);
  const result = await run([file]);
  assert.equal(result.code, 0, result.output);
  for (const message of ['diagnostic-canary', 'stdout-canary', 'stderr-canary']) assert.match(result.output, new RegExp(message));
});

test('the gate bounds Go helper parallelism and preserves an explicit override', async t => {
  const { file } = await fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('helper budget', () => assert.equal(process.env.GOMAXPROCS, process.env.EXPECTED_GO_BUDGET));`);
  for (const [configured, expected] of [[undefined, '2'], ['3', '3']]) {
    const result = await run([file], { env: { GOMAXPROCS: configured, EXPECTED_GO_BUDGET: expected } });
    assert.equal(result.code, 0, result.output);
  }
});
