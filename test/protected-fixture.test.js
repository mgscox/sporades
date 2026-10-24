import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { readHostMetrics } from '../dist/cli/host-metrics.js';
import { withFixtureUmask } from './support/fixture-umask.js';

test('Host fixture setup admits protected state under umask 0002 and still rejects writable state', async () => {
  const previous = process.umask(0o002);
  const root = await mkdtemp(path.resolve('.agent-tmp-fixture-modes-'));
  try {
    await withFixtureUmask(async () => {
      const telemetry = path.join(root, 'telemetry');
      await mkdir(telemetry);
      const file = path.join(telemetry, 'resources.json');
      const state = { host: 'fixture.example', address: '127.0.0.1', enabled: true, psi: false };
      await writeFile(file, JSON.stringify(state), { mode: 0o600 });
      assert.deepEqual(await readHostMetrics(root), state);
      await chmod(telemetry, 0o775);
      await assert.rejects(readHostMetrics(root), /Unsafe Host metrics configuration path/);
    });
    assert.equal(process.umask(), 0o002, 'restore the caller umask');
    await assert.rejects(withFixtureUmask(async () => { throw new Error('fixture setup failed'); }), /fixture setup failed/);
    assert.equal(process.umask(), 0o002, 'restore even after setup throws');
  } finally { process.umask(previous); await rm(root, { recursive: true, force: true }); }
});
