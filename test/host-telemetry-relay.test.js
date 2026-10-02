import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHostRelayCollectorConfig, validateHostRelayConnection } from '../dist/cli/host-telemetry-relay.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Host relay accepts only a scoped verified HTTPS destination', () => {
  const connection = validateHostRelayConnection({ endpoint: 'https://monitor.example:4318/', credential: 'scope-test-token' });
  assert.equal(connection.endpoint, 'https://monitor.example:4318/');
  for (const endpoint of ['http://127.0.0.1:4318/', 'https://user:pass@monitor.example/', 'https://monitor.example/path', 'https://monitor.example/?key=secret']) {
    assert.throws(() => validateHostRelayConnection({ endpoint, credential: 'scope-test-token' }));
  }
  assert.throws(() => validateHostRelayConnection({ endpoint: connection.endpoint, credential: 'bad\nTOKEN=leak' }));
  assert.equal(validateHostRelayConnection({ endpoint: connection.endpoint, credential: 'scope-test-token', metricsIntervalMs: 5000, eventLoopDelayResolutionMs: 20 }).metricsIntervalMs, 5000);
  assert.throws(() => validateHostRelayConnection({ endpoint: connection.endpoint, credential: 'scope-test-token', metricsIntervalMs: 100 }));
});

test('collector config has private receiver and bounded delivery without embedding credentials', () => {
  const config = renderHostRelayCollectorConfig({ endpoint: 'https://monitor.example:4318/', caFile: false });
  assert.match(config, /endpoint: 0\.0\.0\.0:4318/);
  assert.match(config, /queue_size: 1000/);
  assert.match(config, /memory_limiter:/);
  assert.match(config, /\$\{env:SPORADES_INGEST_AUTH\}/);
  assert.doesNotMatch(config, /scope-test-token/);
});

test('shipped Host help advertises Capsule Telemetry opt-out commands', () => {
  const help = spawnSync(process.execPath, ['bin/sporades.js', 'host', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /telemetry enable\|disable <subname>/);
});

test('installed CLI resolves a verified Host profile and redacts the scoped credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sporades-host-relay-'));
  const bin = path.join(root, 'bin');
  const capture = path.join(root, 'request.json');
  await mkdir(bin);
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, `#!/usr/bin/env node\nconst fs=require('node:fs');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{fs.writeFileSync(process.env.SPORADES_TEST_CAPTURE,data);const request=JSON.parse(data);process.stdout.write(JSON.stringify({ok:true,data:{action:request.action,endpoint:request.telemetry?.endpoint??null,relayReady:true,capsuleCoverage:'not-configured'},error:null})+'\\n')});\n`);
  await chmod(ssh, 0o755);
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_TEST_CAPTURE: capture, TRACE_INGEST_TOKEN: 'private-test-ingest-token', INVENTORY_TOKEN: 'private-test-inventory-token', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const cli = (...args) => spawnSync(process.execPath, ['bin/sporades.js', ...args], { cwd: process.cwd(), encoding: 'utf8', env });
  try {
    assert.equal(cli('host', 'add', 'remote', '--server', 'host.example', '--domain', 'capsules.example', '--json').status, 0);
    assert.equal(cli('telemetry', 'profile', 'add', 'remote', '--endpoint', 'https://monitor.example:4318', '--credential-env', 'TRACE_INGEST_TOKEN', '--inventory-host', 'host-one', '--inventory-credential-env', 'INVENTORY_TOKEN', '--json').status, 0);
    const connected = cli('host', 'telemetry', 'connect', '--host', 'remote', '--profile', 'remote', '--json');
    assert.equal(connected.status, 0, connected.stderr);
    assert.equal(JSON.parse(connected.stdout).data.action, 'host.telemetry.connect');
    assert.doesNotMatch(connected.stdout + connected.stderr, /private-test-ingest-token/);
    const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(request.telemetry.endpoint, 'https://monitor.example:4318');
    assert.equal(request.telemetry.credential, 'private-test-ingest-token');
    assert.equal(request.telemetry.inventoryHost, 'host-one');
    assert.equal(request.telemetry.inventoryCredential, 'private-test-inventory-token');
    assert.doesNotMatch(connected.stdout + connected.stderr, /private-test-inventory-token/);
    assert.equal(request.capsule, null);
    const status = cli('host', 'telemetry', 'status', '--host', 'remote', '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).telemetry, undefined);
    const disabled = cli('host', 'telemetry', 'disable', 'tickets', '--host', 'remote', '--json');
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).action, 'host.telemetry.disable');
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).capsule.subname, 'tickets');
    const enabled = cli('host', 'telemetry', 'enable', 'tickets', '--host', 'remote', '--json');
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).action, 'host.telemetry.enable');
    assert.notEqual(cli('host', 'telemetry', 'disable', '--host', 'remote', '--json').status, 0);
    for (const operation of ['resources-enable', 'resources-disable', 'resources-remove']) {
      const result = cli('host', 'telemetry', operation, '--host', 'remote', '--json');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(await readFile(capture, 'utf8')).action, `host.telemetry.${operation}`);
      assert.equal(JSON.parse(await readFile(capture, 'utf8')).capsule, null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
