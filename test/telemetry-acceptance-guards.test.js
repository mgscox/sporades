import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { telemetryAcceptancePrerequisite } from './helpers/telemetry-acceptance.js';

const run = promisify(execFile);

for (const [file, flag] of [
  ['telemetry-container-ca.acceptance.test.js', 'SPORADES_REAL_TELEMETRY_CA_CONTAINER'],
  ['telemetry-outage.acceptance.test.js', 'SPORADES_REAL_TELEMETRY_OUTAGE'],
]) {
  test(`${file} skips explicitly when opted in without Docker`, async () => {
    const env = { ...process.env, PATH: '', [flag]: '1', SPORADES_CONFIG_DIR: path.resolve('.tmp/telemetry-guards') };
    delete env.SPORADES_LEGACY_CLI_PATH;
    delete env.NODE_TEST_CONTEXT;
    // A missing executable is a prerequisite failure, before any resources start.
    const { stdout } = await run(process.execPath, ['--test', '--test-reporter=tap', `test/${file}`], { env, timeout: 15_000 });
    assert.match(stdout, /# SKIP .*Docker.*unavailable/i);
    assert.match(stdout, /# fail 0/);
    assert.match(stdout, /# pass 0/);
  });
}

test('legacy HTTP prerequisites do not require the private-CA OpenSSL tool', {
  skip: process.platform === 'win32' ? 'POSIX executable fixtures require /bin/sh.' : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'telemetry-tools-'));
  const previousPath = process.env.PATH;
  try {
    // Stub external CLI availability, without starting a Docker daemon.
    for (const executable of ['docker', 'npm']) {
      await writeFile(path.join(directory, executable), '#!/bin/sh\nprintf "linux 2\\n"\n', { mode: 0o755 });
    }
    process.env.PATH = directory;
    assert.equal(await telemetryAcceptancePrerequisite('legacy'), null);
    assert.match(await telemetryAcceptancePrerequisite('private-ca'), /OpenSSL unavailable/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
