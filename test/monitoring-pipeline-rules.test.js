import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('provisioned Prometheus rules detect disconnected Capsule sources', {
  skip: process.env.SPORADES_REAL_PROMTOOL !== '1' && !process.env.SPORADES_PROMTOOL_BIN
    ? 'Set SPORADES_REAL_PROMTOOL=1 for pinned Docker promtool or SPORADES_PROMTOOL_BIN for local promtool.' : false,
  timeout: 120_000,
}, async () => {
  const compose = await readFile(new URL('../monitoring/trace/compose.yaml', import.meta.url), 'utf8');
  const image = compose.match(/image: (prom\/prometheus:\S+)/)?.[1];
  assert.ok(image, 'use the provisioned Prometheus version');
  for (const args of [
    ['check', 'rules', 'monitoring/trace/pipeline-rules.yaml'],
    ['test', 'rules', 'test/fixtures/monitoring-pipeline-rules.yaml'],
  ]) {
    const local = process.env.SPORADES_PROMTOOL_BIN;
    const containerName = `sporades-dennis-promtool-${process.pid}`;
    const result = spawnSync(local || 'docker', local ? args : [
      'run', '--rm', '--name', containerName,
      '--network', 'none', '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
      '--workdir', '/workspace', '--entrypoint', '/bin/promtool', image, ...args,
    ], { cwd: root, encoding: 'utf8', timeout: 50_000 });
    if (!local && result.error) {
      spawnSync('docker', ['rm', '--force', containerName], { encoding: 'utf8', timeout: 5_000 });
    }
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  }
});
