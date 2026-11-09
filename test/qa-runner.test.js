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
    const child = spawn(process.execPath, ['scripts/run-tests.mjs', ...(qa ? ['--qa'] : []), ...(build ? [] : ['--no-build']), ...(args.some(a => a.startsWith('--timeout-ms=')) ? [] : ['--timeout-ms=15000']), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const result = await run(['--timeout-ms=1000', '--concurrency=2', file, second], { env: { SPORADES_TEST_MAX_WORKERS: '2' } });
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
    const result = await run([file], { qa: false, env: { GOMAXPROCS: configured, EXPECTED_GO_BUDGET: expected } });
    assert.equal(result.code, 0, result.output);
  }
});

test('QA memory cap stops owned work with an environment result and resource evidence', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test';
    import { spawn } from 'node:child_process';
    test('memory-heavy child', async () => {
      spawn(process.execPath, ['-e', 'const held = []; setInterval(() => held.push(Buffer.alloc(8 * 1024 * 1024, 1)), 30)'], { stdio: 'inherit' });
      await new Promise(() => {});
    });
    test('queued second', () => {});
    test('queued third', () => {});`);
  const result = await run(['--memory-limit-mb=400', '--timeout-ms=15000', `--report=${path.join(dir, 'report.json')}`, file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.failureKind, 'environment');
  assert.equal(result.summary.resourceExhaustion, true);
  assert.equal(result.summary.timedOut, false);
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.cancelled, 3);
  assert.ok(result.summary.memory.peakRssMb >= 400);
  assert.ok(result.summary.memory.minFreeMb > 0);
  assert.equal(typeof result.summary.memory.swapFreeMb, 'number');
  assert.match(result.output, /RESOURCE EXHAUSTION.*fixture.test.js/);
  assert.ok(result.output.trim().split('\n').at(-1).startsWith('RESOURCE EXHAUSTION '));
  const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
  assert.ok(report.files.some(f => f.file.endsWith('fixture.test.js') && f.peakRssMb > 0));
});

test('QA SIGKILL is an environment failure, while assertion failures remain test failures', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('killed worker', () => process.kill(process.pid, 'SIGKILL'));`);
  const result = await run([file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceExhaustion, true);
  assert.equal(result.summary.fail, 0);
  assert.doesNotMatch(result.output, /^(?:FAIL |fail [1-9])/m);
  assert.equal(result.summary.timedOut, false);
  assert.ok(result.summary.cancelled >= 1);
});

test('QA free-memory floor stops before launching tests and names the pressure reason', async t => {
  const { file } = await fixture(t, `throw Error('must not launch');`);
  const result = await run(['--free-memory-floor-mb=999999999', file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceReason, 'free-memory floor crossed');
  assert.equal(result.summary.timedOut, false);
  assert.equal(result.summary.fail, 0);
  assert.doesNotMatch(result.output, /must not launch/);
});

test('a worker ceiling bounds file parallelism even with a larger command-line selection', async t => {
  const { dir, file } = await fixture(t, '');
  const lock = path.join(dir, 'worker-slot');
  const source = `import test from 'node:test'; import { open, unlink } from 'node:fs/promises';
    test('one slot', async () => {
      const handle = await open(${JSON.stringify(lock)}, 'wx');
      try { await new Promise(resolve => setTimeout(resolve, 150)); }
      finally { await handle.close(); await unlink(${JSON.stringify(lock)}); }
    });`;
  await writeFile(file, source);
  const second = path.join(dir, 'second.test.js');
  await writeFile(second, source);
  const result = await run(['--concurrency=16', file, second], { env: { SPORADES_TEST_MAX_WORKERS: '1' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 2);
  assert.match(result.output, /concurrency=1/);
});

test('QA caps inherited compiler and native worker pools', async t => {
  const { file } = await fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('bounded helpers', () => {
      assert.equal(process.env.GOMAXPROCS, '2');
      assert.equal(process.env.UV_THREADPOOL_SIZE, '2');
      assert.equal(process.env.RAYON_NUM_THREADS, '2');
    });`);
  const result = await run([file], { env: { GOMAXPROCS: '64', UV_THREADPOOL_SIZE: '64', RAYON_NUM_THREADS: '64', SPORADES_TEST_MAX_WORKERS: '2' } });
  assert.equal(result.code, 0, result.output);
});

test('QA reports and reaps a detached helper surviving a completed file', async t => {
  const { dir, file } = await fixture(t, '');
  const marker = path.join(dir, 'leaked');
  await writeFile(file, `import test from 'node:test'; import { spawn } from 'node:child_process';
    test('leaking fixture', async () => {
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1500); setInterval(() => {}, 1000);`)}], { detached: true, stdio: 'ignore' });
      child.unref();
      await new Promise(resolve => setTimeout(resolve, 400));
    });`);
  const report = path.join(dir, 'report.json');
  const result = await run([`--report=${report}`, file]);
  assert.equal(result.code, 0, result.output);
  assert.ok(JSON.parse(await readFile(report, 'utf8')).files[0].cleanedProcesses.length > 0);
  assert.match(result.output, /CLEANUP .*fixture.test.js/);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('QA ENOMEM identifies resource exhaustion without an RSS floor crossing', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('allocation refused', () => { throw Object.assign(Error('allocation refused'), { code: 'ENOMEM' }); });
    test('already completed two', () => {});
    test('already completed three', () => {});`);
  const result = await run([file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.failureKind, 'environment');
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
  assert.equal(result.summary.pass + result.summary.cancelled, 3, result.output);
});

test('test cancellation without memory evidence remains a test failure', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('unresolved', { timeout: 20 }, async () => { setTimeout(() => {}, 200); await new Promise(() => {}); });`);
  const result = await run([file]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.resourceExhaustion, false);
  assert.equal(result.summary.timedOut, false);
  assert.ok(result.summary.cancelled > 0);
});

test('memory terminology in passing output or an assertion does not hide a regression', async t => {
  const { file } = await fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('mentions memory', () => console.log('Error: ENOMEM is expected; FATAL ERROR: heap out of memory is fixture text'));
    test('assertion', () => assert.equal('ENOMEM', 'SIGKILL'));`);
  const result = await run([file]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.resourceExhaustion, false);
  assert.equal(result.summary.fail, 1);
});

test('a resource interruption preserves a regression completed before pressure', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('actual regression', () => { throw Error('regression before memory pressure'); });
    test('allocation refused', () => { throw Object.assign(Error('allocation refused'), { code: 'ENOMEM' }); });`);
  const result = await run([file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.failureKind, 'environment');
  assert.equal(result.summary.fail, 1);
  assert.equal(result.summary.cancelled, 1);
});

test('QA honors a tighter ancestor cgroup budget and a disabled swap allowance', { skip: process.platform !== 'linux' }, async t => {
  const { dir, file } = await fixture(t, `throw Error('must not launch below ancestor floor');`);
  const preload = path.join(dir, 'memory-preload.mjs');
  await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (file === '/proc/self/cgroup') return '0::/parent/child\\n';
      if (file === '/proc/meminfo') return 'MemAvailable: 10000000 kB\\nSwapFree: 2000000 kB\\n';
      if (typeof file === 'string' && file.startsWith('/sys/fs/cgroup/')) {
        if (file === '/sys/fs/cgroup/parent/memory.max') return String(2000 * 1024 * 1024);
        if (file === '/sys/fs/cgroup/parent/memory.current') return String(1000 * 1024 * 1024);
        if (file.endsWith('/memory.max')) return 'max';
        if (file.endsWith('/memory.swap.max')) return '0';
        return '0';
      }
      return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();`);
  const result = await run([file], { env: { NODE_OPTIONS: '--import=' + preload } });
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceReason, 'free-memory floor crossed');
  assert.equal(result.summary.memory.minFreeMb, 1000);
  assert.equal(result.summary.memory.swapFreeMb, 0);
});

test('QA recognizes heap exhaustion diagnostics split across stream writes', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('heap exhausted', async () => {
      process.stderr.write('FATAL ER');
      await new Promise(resolve => setTimeout(resolve, 50));
      process.stderr.write('ROR: Reached heap limit\\n');
      throw Object.assign(Error('worker aborted'), { signal: 'SIGABRT' });
    });`);
  const result = await run([file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceExhaustion, true);
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
});

test('QA requires an unsuccessful build before classifying its memory diagnostics', async t => {
  const { dir, file } = await fixture(t, `import test from 'node:test'; test('built', () => {});`);
  const script = path.join(dir, 'fake-npm.mjs');
  await writeFile(script, `console.error('FATAL ERROR: Reached heap limit'); process.exit(Number(process.env.FIXTURE_BUILD_EXIT));`);
  for (const [buildExit, expected] of [['0', 0], ['1', 75]]) {
    const result = await run([file], { build: true, env: { npm_execpath: script, FIXTURE_BUILD_EXIT: buildExit } });
    assert.equal(result.code, expected, result.output);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.summary.timedOut, false);
    assert.equal(result.summary.resourceExhaustion, expected === 75);
    if (expected === 75) assert.ok(result.summary.runningAtExhaustion.some(command => command.includes('fake-npm.mjs')));
  }
});

test('QA logs active files before stopping when free memory crosses the floor', { skip: process.platform !== 'linux' }, async t => {
  const { dir, file } = await fixture(t, '');
  const marker = path.join(dir, 'started');
  await writeFile(file, `import test from 'node:test'; import { writeFileSync } from 'node:fs';
    test('running at pressure', async () => {
      writeFileSync(${JSON.stringify(marker)}, 'started');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });`);
  const preload = path.join(dir, 'floor-preload.mjs');
  await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (file === '/proc/meminfo') return 'MemAvailable: ' + (fs.existsSync(${JSON.stringify(marker)}) ? 512000 : 10240000) + ' kB\\nSwapFree: 1024000 kB\\n';
      return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();`);
  const result = await run(['--timeout-ms=5000', file], { env: { NODE_OPTIONS: '--import=' + preload } });
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceReason, 'free-memory floor crossed');
  assert.equal(result.summary.memory.minFreeMb, 500);
  assert.ok(result.summary.runningAtExhaustion.some(name => name.endsWith('fixture.test.js')));
  assert.match(result.output, /RESOURCE PRESSURE .*fixture.test.js/);
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
});

test('QA bounds compiler-heavy Capsules to the memory lane width', { skip: process.platform !== 'linux' }, async t => {
  const { dir } = await fixture(t, '');
  const slots = [path.join(dir, 'capsule-slot-0'), path.join(dir, 'capsule-slot-1')];
  const source = `import test from 'node:test'; import { open, unlink } from 'node:fs/promises';
    test('one Capsule fixture', async () => {
      let handle, slot;
      for (const candidate of ${JSON.stringify(slots)}) {
        try { handle = await open(candidate, 'wx'); slot = candidate; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!handle) throw new Error('memory lane exceeded its two-file bound');
      try { await new Promise(resolve => setTimeout(resolve, 150)); }
      finally { await handle.close(); await unlink(slot); }
    });`;
  const files = ['dev.test.js', 'dev-part-2.test.js'].map(name => path.join(dir, name));
  for (const file of files) await writeFile(file, source);
  const result = await run(['--concurrency=2', ...files]);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 2);
  assert.match(result.output, /LANE memory-heavy: 2 files; concurrency=2/);
});

test('an inherited heavy-concurrency override can force the memory lane back to one file', { skip: process.platform !== 'linux' }, async t => {
  const { dir } = await fixture(t, '');
  const lock = path.join(dir, 'capsule-slot');
  const source = `import test from 'node:test'; import { open, unlink } from 'node:fs/promises';
    test('one Capsule fixture', async () => {
      const handle = await open(${JSON.stringify(lock)}, 'wx');
      try { await new Promise(resolve => setTimeout(resolve, 150)); }
      finally { await handle.close(); await unlink(${JSON.stringify(lock)}); }
    });`;
  const files = ['dev.test.js', 'dev-part-2.test.js'].map(name => path.join(dir, name));
  for (const file of files) await writeFile(file, source);
  const result = await run(['--concurrency=2', ...files], { env: { SPORADES_TEST_HEAVY_CONCURRENCY: '1' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 2);
  assert.match(result.output, /LANE memory-heavy: 2 files; concurrency=1/);
});

test('an inherited larger ceiling preserves the QA default of four files', async t => {
  const { dir } = await fixture(t, '');
  const source = `import test from 'node:test'; import { open, unlink } from 'node:fs/promises';
    test('uses at most four slots', async () => {
      if (Number(process.env.SPORADES_TEST_MAX_WORKERS) > 4) throw Error('child pool ceiling exceeds QA default');
      let handle, slot;
      for (const name of ['slot-a', 'slot-b', 'slot-c', 'slot-d']) {
        slot = ${JSON.stringify(dir)} + '/' + name;
        try { handle = await open(slot, 'wx'); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!handle) throw Error('QA exceeded its four-file default');
      try { await new Promise(resolve => setTimeout(resolve, 300)); }
      finally { await handle.close(); await unlink(slot); }
    });`;
  const files = ['one.test.js', 'two.test.js', 'three.test.js', 'four.test.js', 'five.test.js'].map(name => path.join(dir, name));
  for (const file of files) await writeFile(file, source);
  const result = await run(files, { env: { SPORADES_TEST_MAX_WORKERS: '16' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.summary.pass, 5);
  assert.match(result.output, /concurrency=[1-4]\n/);
});

test('QA recognizes a child heap abort captured in an exec error', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('captured heap abort', () => {
      throw Object.assign(Error('child failed'), { signal: 'SIGABRT', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' });
    });`);
  const result = await run([file]);
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.failureKind, 'environment');
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
});

test('a child abort without memory evidence remains a test failure', async t => {
  const { file } = await fixture(t, `import test from 'node:test';
    test('expected diagnostic', () => console.error('FATAL ERROR: Reached heap limit is expected fixture output'));
    test('ordinary child abort', () => {
      throw Object.assign(Error('child failed'), { signal: 'SIGABRT', stderr: 'assertion failed' });
    });`);
  const result = await run([file]);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.summary.resourceExhaustion, false);
  assert.equal(result.summary.fail, 1);
});

test('QA classifies an actual worker-thread heap limit as resource exhaustion', async t => {
  const { file } = await fixture(t, `import test from 'node:test'; import { Worker } from 'node:worker_threads';
    test('bounded worker heap', async () => {
      const worker = new Worker('const held=[]; while(true) held.push(new Array(100000).fill(42));', {
        eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2 },
      });
      await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
    });`);
  const result = await run([file], { env: { NODE_OPTIONS: '' } });
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.failureKind, 'environment');
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
});

test('QA detects a new cgroup OOM kill without rejecting historical counters', { skip: process.platform !== 'linux' }, async t => {
  const { dir, file } = await fixture(t, '');
  const marker = path.join(dir, 'running');
  await writeFile(file, `import test from 'node:test'; import { writeFileSync } from 'node:fs';
    test('running when OOM counter changes', async () => {
      writeFileSync(${JSON.stringify(marker)}, 'running');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });`);
  const preload = path.join(dir, 'oom-counter.mjs');
  await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && file.startsWith('/sys/fs/cgroup/') && file.endsWith('/memory.events.local')) {
        return 'oom_kill ' + (fs.existsSync(${JSON.stringify(marker)}) ? 8 : 7) + '\\n';
      }
      return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();`);
  const result = await run(['--timeout-ms=5000', file], { env: { NODE_OPTIONS: '--import=' + preload } });
  assert.equal(result.code, 75, result.output);
  assert.equal(result.summary.resourceReason, 'cgroup OOM kill observed');
  assert.ok(result.summary.runningAtExhaustion.some(name => name.endsWith('fixture.test.js')));
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.timedOut, false);
});
