import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { routeRuntimeHealth } from '../dist/http-runtime.js';

test('public application probe is uncached and discloses no protected readiness details', async t => {
  const app = createServer(async (req, res) => {
    if (!await routeRuntimeHealth({ runtimeProbeToken: 'a'.repeat(64) }, req, res)) res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const origin = `http://127.0.0.1:${app.address().port}`;
  for (const nonce of ['1234567890123456', 'abcdef1234567890']) {
    const response = await fetch(`${origin}/__sporades/probe?nonce=${nonce}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), `sporades-application-probe-v1:${nonce}\n`);
  }
  assert.equal((await fetch(`${origin}/__sporades/probe?nonce=bad`)).status, 404);
  assert.equal((await fetch(`${origin}/__sporades/health/runtime`)).status, 404);
});

test('acknowledged expectations survive Host loss and restart, and cease only after explicit lifecycle acknowledgement', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { createInventoryStore } = await import('../monitoring/trace/inventory-store.mjs');
  const { createAvailabilityServer } = await import('../monitoring/trace/availability.mjs');
  const directory = await mkdtemp(new URL('../.sporades/issue-120/inventory-', import.meta.url).pathname);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { schemaVersion: 1, host: 'host-one', revision: 1, capsules: [{ id: 'apps.example/demo', state: 'running', changedAt: '2026-10-03T00:00:00.000Z', release: 'r1', targets: ['https://demo.apps.example/'] }] };
  const store = createInventoryStore(directory);
  await store.update(value);
  // No credentials/sender connection is needed to retain centrally stored state.
  const server = createAvailabilityServer({ inventoryDirectory: directory }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await (await fetch(origin + '/targets')).json();
  assert.equal(first.length, 1);
  assert.equal(first[0].targets[0], 'https://demo.apps.example/__sporades/probe');
  assert.deepEqual(first[0].labels, { host: 'host-one', service_name: 'apps.example/demo', target: 'https://demo.apps.example/' });
  const metrics = await (await fetch(origin + '/metrics')).text();
  assert.match(metrics, /sporades_expected_host\{host="host-one"\} 1/);
  assert.match(metrics, /sporades_expected_capsule\{host="host-one",service_name="apps.example\/demo"\} 1/);
  assert.match(metrics, /sporades_inventory_acknowledged_seconds/);
  assert.doesNotMatch(metrics, /nonce|r1/);
  assert.equal((await createInventoryStore(directory).read('host-one')).inventory.revision, 1);
  for (const [index, state] of ['stopped', 'deleted', 'opted-out'].entries()) {
    assert.equal((await store.update({ ...value, revision: index + 2, capsules: [{ ...value.capsules[0], state, targets: [] }] })).status, 200);
    assert.deepEqual(await (await fetch(origin + '/targets')).json(), []);
    assert.doesNotMatch(await (await fetch(origin + '/metrics')).text(), /sporades_expected_(host|capsule).* 1/);
  }
  assert.equal((await fetch(origin + '/v1/inventory/host-one', { method: 'PUT' })).status, 404);
});

test('notification configuration preserves operator values and keeps webhook secrets out of Compose and diagnostics', async t => {
  const { setupEnvironment, inspectEnvironment } = await import('../monitoring/trace/setup.mjs');
  const { mkdtemp, writeFile, readFile, stat, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(new URL('../.sporades/issue-120/notify-', import.meta.url).pathname);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = directory + '/.env';
  const source = 'TRACE_TLS_MODE=proxy\nALERT_WEBHOOK_URL=https://notify.example/secret-channel\nALERT_WEBHOOK_TOKEN=private-channel-token\nMONITORING_PUBLIC_URL=https://monitor.example\nOPERATOR_EXTRA=keep\n';
  await writeFile(file, source);
  assert.deepEqual((await setupEnvironment(file)).missing, []);
  assert((await readFile(file, 'utf8')).startsWith(source));
  const config = await readFile(directory + '/.private/alertmanager.yaml', 'utf8');
  assert.match(config, /send_resolved: true/);
  assert.match(config, /https:\/\/notify.example\/secret-channel/);
  assert.match(config, /private-channel-token/);
  assert.match(config, /group_wait: 5s/);
  assert.equal((await stat(directory + '/.private/alertmanager.yaml')).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(directory + '/.compose.env', 'utf8'), /secret-channel|private-channel-token/);
  assert.throws(() => inspectEnvironment('TRACE_TLS_MODE=proxy\nALERT_WEBHOOK_URL=http://notify.example/secret\n'), /Invalid ALERT_WEBHOOK_URL/);
  assert.deepEqual(inspectEnvironment('TRACE_TLS_MODE=proxy\nALERT_WEBHOOK_URL=https://notify.example/test\n').missing, ['MONITORING_PUBLIC_URL']);
});

test('Host worker reports only readiness booleans through the relay and cannot export its probe token', async t => {
  const { reportHostAvailability } = await import('../dist/cli/host-availability.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const directory = await mkdtemp(new URL('../.sporades/issue-120/host-', import.meta.url).pathname);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relayBodies = [];
  const relay = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; relayBodies.push(JSON.parse(body)); res.writeHead(200).end('{}'); }).listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const bin = directory + '/bin'; await mkdir(bin);
  const calls = directory + '/calls';
  await writeFile(bin + '/docker', `#!/usr/bin/env node
if(process.argv[2]==='inspect') {
  process.stdout.write(JSON.stringify({Config:{Labels:{'com.sporades.host-telemetry-relay':'true'}},NetworkSettings:{Networks:{private:{IPAddress:'127.0.0.1'}}}}));
} else process.stdout.write('1');
`, { mode: 0o755 });
  const originalPath = process.env.PATH; process.env.PATH = bin + ':' + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  // Test the public worker seam with a task-owned relay origin; production port
  // remains private 4318. The adapter never accepts a remote reporting URL.
  await reportHostAvailability({ host: 'host-one', network: 'private', capsules: [{ id: 'apps.example/demo', state: 'running' }, { id: 'apps.example/stopped', state: 'stopped' }] }, relay.address().port);
  assert.equal(relayBodies.length, 1);
  const text = JSON.stringify(relayBodies[0]);
  assert.doesNotMatch(text, /token|SPORADES_RUNTIME_PROBE|sqlite|fileStorage/);
  assert.match(text, /sporades.host.relay.contact/);
  assert.match(text, /sporades.capsule.local.ready/);
  const metrics = relayBodies[0].resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics[1].gauge.dataPoints[0].asInt, '1');
  assert.equal(metrics[1].gauge.dataPoints.length, 1);
});

test('Blackbox refresh requires a fresh nonce while retaining stable Prometheus scrape targets', async t => {
  const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
  const { createInventoryStore } = await import('../monitoring/trace/inventory-store.mjs');
  const { createAvailabilityServer } = await import('../monitoring/trace/availability.mjs');
  const directory = await mkdtemp(new URL('../.sporades/issue-120/nonce-', import.meta.url).pathname);
  const config = directory + '/blackbox'; await mkdir(config);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reloads = 0;
  const blackbox = createServer((req, res) => { assert.equal(req.url, '/-/reload'); reloads++; res.writeHead(200).end(); }).listen(0, '127.0.0.1');
  await once(blackbox, 'listening');
  t.after(() => { blackbox.closeAllConnections(); blackbox.close(); });
  await createInventoryStore(directory).update({ schemaVersion: 1, host: 'host-one', revision: 1, capsules: [{ id: 'apps.example/demo', state: 'running', changedAt: '2026-10-03T00:00:00.000Z', release: null, targets: ['https://demo.apps.example/'] }] });
  const app = createAvailabilityServer({ inventoryDirectory: directory, blackboxDirectory: config, blackboxReloadUrl: `http://127.0.0.1:${blackbox.address().port}/-/reload` }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const groups = await (await fetch(`http://127.0.0.1:${app.address().port}/targets`)).json();
  assert.equal(reloads, 1);
  assert.equal(groups[0].labels.__param_module, 'sporades_application');
  const generated = await readFile(config + '/blackbox.yaml', 'utf8');
  const nonce = generated.match(/X-Sporades-Probe-Nonce: ([a-f0-9]{32})/)[1];
  assert.match(await readFile(config + '/blackbox.yaml', 'utf8'), new RegExp(`\\^sporades-application-probe-v1:${nonce}`));
  const next = await (await fetch(`http://127.0.0.1:${app.address().port}/targets`)).json();
  assert.equal(next[0].targets[0], groups[0].targets[0]);
  assert.equal(reloads, 1);
});
