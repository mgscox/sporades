import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHostRelayCollectorConfig, validateHostRelayConnection } from '../dist/cli/host-telemetry-relay.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, lstat } from 'node:fs/promises';
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
  assert.deepEqual(validateHostRelayConnection({ ...connection, tracePropagationOrigins: ['https://DEPENDENCY.example/'] }).tracePropagationOrigins, ['https://dependency.example']);
  assert.throws(() => validateHostRelayConnection({ ...connection, tracePropagationOrigins: ['https://dependency.example/private'] }));
});

test('collector config has private receiver and bounded delivery without embedding credentials', () => {
  const config = renderHostRelayCollectorConfig({ endpoint: 'https://monitor.example:4318/', caFile: false });
  assert.match(config, /endpoint: 0\.0\.0\.0:4318/);
  assert.match(config, /sizer: bytes\n      queue_size: 16777216/);
  assert.match(config, /block_on_overflow: false/);
  assert.match(config, /send_batch_max_size: 256/);
  assert.match(config, /timeout: 2s/);
  assert.match(config, /prometheus\/pipeline/);
  assert.match(config, /memory_limiter:/);
  assert.match(config, /\$\{env:SPORADES_INGEST_AUTH\}/);
  assert.doesNotMatch(config, /scope-test-token/);
});

test('shipped Host help advertises Capsule Telemetry opt-out commands', () => {
  const help = spawnSync(process.execPath, ['bin/sporades.js', 'host', '--help'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /telemetry enable\|disable <subname>/);
  assert.match(help.stdout, /telemetry connect\|migrate\|reconcile\|status\|check/);
  assert.match(help.stdout, /--query-credential-env <name>/);
});

test('installed CLI resolves a verified Host profile and redacts the scoped credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sporades-host-relay-'));
  const bin = path.join(root, 'bin');
  const capture = path.join(root, 'request.json');
  await mkdir(bin);
  // The owned TMPDIR may be inside this repository's ES-module package scope.
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, `#!/usr/bin/env node
const fs=require('node:fs');let data='';
process.stdin.on('data',x=>data+=x);
process.stdin.on('end',()=>{
  fs.writeFileSync(process.env.SPORADES_TEST_CAPTURE,data);
  const request=JSON.parse(data);
  process.stdout.write(JSON.stringify({ok:true,data:{action:request.action,endpoint:request.telemetry?.endpoint??null,relayReady:true,capsuleCoverage:'not-configured'},error:null})+'\\n');
});
`);
  await chmod(ssh, 0o755);
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_TEST_CAPTURE: capture, QUERY_OPERATOR: 'operator:private-query-secret', TRACE_INGEST_TOKEN: 'private-test-ingest-token', INVENTORY_TOKEN: 'private-test-inventory-token', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const cli = (...args) => spawnSync(process.execPath, ['bin/sporades.js', ...args], { cwd: process.cwd(), encoding: 'utf8', env });
  try {
    assert.equal(cli('host', 'add', 'remote', '--server', 'host.example', '--domain', 'capsules.example', '--json').status, 0);
    assert.equal(cli('telemetry', 'profile', 'add', 'remote', '--endpoint', 'https://monitor.example:4318', '--credential-env', 'TRACE_INGEST_TOKEN', '--inventory-credential-env', 'INVENTORY_TOKEN', '--inventory-host', 'host-east', '--trace-propagation-origin', 'https://dependency.example', '--json').status, 0);
    const connected = cli('host', 'telemetry', 'connect', '--host', 'remote', '--profile', 'remote', '--json');
    assert.equal(connected.status, 0, connected.stdout + connected.stderr);
    assert.equal(JSON.parse(connected.stdout).data.action, 'host.telemetry.connect');
    assert.doesNotMatch(connected.stdout + connected.stderr, /private-test-ingest-token/);
    const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(request.telemetry.endpoint, 'https://monitor.example:4318');
    assert.equal(request.telemetry.credential, 'private-test-ingest-token');
    assert.deepEqual(request.telemetry.tracePropagationOrigins, ['https://dependency.example']);
    assert.equal(request.telemetry.inventoryCredential, 'private-test-inventory-token');
    assert.equal(request.telemetry.inventoryHost, 'host-east');
    assert.doesNotMatch(connected.stdout + connected.stderr, /private-test-inventory-token/);
    assert.equal(request.capsule, null);
    const migrated = cli('host', 'telemetry', 'migrate', '--host', 'remote', '--profile', 'remote', '--query-credential-env', 'QUERY_OPERATOR', '--json');
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const migrationRequest = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(migrationRequest.action, 'host.telemetry.migrate');
    assert.equal(migrationRequest.diagnostics.queryCredential, 'operator:private-query-secret');
    assert.doesNotMatch(migrated.stdout + migrated.stderr, /private-query-secret/);
    const checked = cli('host', 'telemetry', 'check', '--host', 'remote', '--query-credential-env', 'QUERY_OPERATOR', '--json');
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).diagnostics.queryCredential, 'operator:private-query-secret');
    assert.notEqual(cli('host', 'telemetry', 'status', '--host', 'remote', '--query-credential-env', 'QUERY_OPERATOR', '--json').status, 0);
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
    for (const operation of ['resources-enable', 'resources-disable', 'resources-remove', 'inventory-export', 'inventory-reconcile', 'exports-disable', 'remove-agents']) {
      const result = cli('host', 'telemetry', operation, '--host', 'remote', '--json');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(await readFile(capture, 'utf8')).action, `host.telemetry.${operation}`);
      assert.equal(JSON.parse(await readFile(capture, 'utf8')).capsule, null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('UMask=0077 Host metrics publication keeps Caddy readable and state private', async t => {
  const root = await mkdtemp(path.resolve('.sporades/host-metrics-modes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin); await mkdir(path.join(root, 'caddy')); await mkdir(path.join(root, 'telemetry'), { mode: 0o700 });
  await writeFile(path.join(root, 'caddy/Caddyfile'), 'apps.example {\n respond "ok"\n}\n');
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh
if [ "$1" = network ] && [ "$2" = inspect ]; then
 echo '[{"Labels":{"com.sporades.host-metrics":"true"},"Internal":true,"IPAM":{"Config":[{"Gateway":"127.0.0.1"}]}}]'
elif [ "$1" = container ] && [ "$2" = inspect ]; then echo '[]'; fi
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'caddy'), `#!/bin/sh
if [ "$1" = adapt ]; then echo '{"apps":{"http":{"servers":{"metrics":{"listen":["127.0.0.1:20190"]}}}}}'; fi
`, { mode: 0o755 });
  // This local fake prevents the Linux-only boot-order path from writing /etc.
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const savedPath = process.env.PATH, savedUmask = process.umask(0o077);
  process.env.PATH = bin + path.delimiter + savedPath;
  try {
    const { configureHostMetrics } = await import('../dist/cli/host-metrics.js');
    for (const operation of ['enable', 'disable']) {
      await configureHostMetrics(root, 'apps.example', operation);
      for (const [file, mode] of Object.entries({ 'caddy/Caddyfile': 0o644, 'telemetry/resources.json': 0o600, 'telemetry/caddy-before-resources.conf': 0o600 })) {
        assert.equal((await lstat(path.join(root, file))).mode & 0o777, mode, `${operation}: ${file}`);
      }
    }
  } finally { process.env.PATH = savedPath; process.umask(savedUmask); }
});
