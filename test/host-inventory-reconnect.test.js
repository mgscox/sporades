import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import path from 'node:path';
import { connectHostTelemetryRelay, readHostTelemetryConnection } from '../dist/cli/host-telemetry-relay.js';
import { reconcileHostInventory, hostInventoryStatus } from '../dist/cli/host-inventory.js';
import { createGateway } from '../monitoring/trace/gateway.mjs';

const scope = 'apps.example';
const oldToken = 'old-host-inventory-token';
const newToken = 'new-host-inventory-token';
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'fixture event did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t) {
  await mkdir('.sporades/reconnect-tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.sporades/reconnect-tests/case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const telemetry = path.join(root, 'telemetry');
  const bin = path.join(root, 'fake-bin');
  const registry = path.join(root, 'hosts', scope, 'registry/capsules');
  await mkdir(telemetry, { mode: 0o700 }); await mkdir(bin); await mkdir(registry, { recursive: true });
  await writeFile(path.join(registry, 'notes.json'), JSON.stringify({ domain: scope, subname: 'notes', hostedUrl: 'https://notes.apps.example', status: 'running', updatedAt: '2026-10-02T00:00:00.000Z', currentRelease: { id: 'release-1' } }));
  // Only the collector startup seam is faked; inventory uses actual verified HTTPS.
  await writeFile(path.join(bin, 'docker'), '#!/bin/sh\nif [ "$1" = inspect ]; then echo \'{"State":{"Running":true},"Config":{"Labels":{"com.sporades.host-telemetry-relay":"true"}}}\'; fi\n');
  await chmod(path.join(bin, 'docker'), 0o755);
  const env = { PATH: process.env.PATH, SPORADES_TEST_FLOCK_PATH: process.env.SPORADES_TEST_FLOCK_PATH };
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.SPORADES_TEST_FLOCK_PATH = path.resolve('test/support/exec-flock.py');
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const tls = async name => {
    const certFile = path.join(root, name + '.pem'), keyFile = path.join(root, name + '.key');
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { cert: await readFile(certFile), key: await readFile(keyFile) };
  };
  const listen = async server => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return `https://127.0.0.1:${server.address().port}/`;
  };
  const saveLegacy = async (endpoint, cert) => {
    await writeFile(path.join(telemetry, 'connection.json'), JSON.stringify({ schemaVersion: 1, endpoint, network: 'fake-network', internalEndpoint: 'http://sporades-telemetry:4318/', caConfigured: true, inventoryHost: scope }), { mode: 0o600 });
    await writeFile(path.join(telemetry, 'inventory-credential'), oldToken + '\n', { mode: 0o600 });
    await writeFile(path.join(telemetry, 'ca.pem'), cert);
    await writeFile(path.join(telemetry, 'collector.yaml'), 'old collector');
    await writeFile(path.join(telemetry, 'credential.env'), 'SPORADES_INGEST_AUTH=Bearer old-ingestion-token\n', { mode: 0o600 });
  };
  const reconnect = (endpoint, cert, credential = newToken) => connectHostTelemetryRelay(root, 'fake-network', { endpoint, credential: 'new-ingestion-token', inventoryCredential: credential, inventoryHost: scope, caPem: cert.toString() });
  return { root, telemetry, bin, tls, listen, saveLegacy, reconnect };
}

test('sender queued before reconnect captures the destination and credential from one generation', async t => {
  const f = await fixture(t);
  const tls = await f.tls('shared');
  const received = [];
  const receiver = label => createServer(tls, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ label, authorization: req.headers.authorization });
    res.end(JSON.stringify({ ok: true, data: { revision: JSON.parse(body).revision, acknowledgedAt: new Date().toISOString() } }));
  });
  const oldEndpoint = await f.listen(receiver('old'));
  const newEndpoint = await f.listen(receiver('new'));
  await f.saveLegacy(oldEndpoint, tls.cert);
  const marker = path.join(f.root, 'waiting'), release = path.join(f.root, 'release');
  const gate = path.join(f.bin, 'gate-flock.cjs');
  await writeFile(gate, `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process');let first=false;try{fs.writeFileSync(${JSON.stringify(marker)},'',{flag:'wx'});first=true}catch{};if(first){const deadline=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)process.exit(75);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}const child=cp.spawn(${JSON.stringify(path.resolve('test/support/exec-flock.py'))},process.argv.slice(2),{stdio:'inherit'});child.on('exit',code=>process.exit(code));\n`);
  await chmod(gate, 0o755);
  process.env.SPORADES_TEST_FLOCK_PATH = gate;
  const sending = reconcileHostInventory(f.root);
  await waitFor(() => readFile(marker).then(() => true, () => false));
  try { await f.reconnect(newEndpoint, tls.cert); }
  finally { await writeFile(release, ''); }
  assert.equal((await sending).pending, false);
  assert.deepEqual(received, [{ label: 'new', authorization: `Bearer ${newToken}` }], 'the old endpoint must never receive the new credential');
  assert.doesNotMatch(JSON.stringify(await readHostTelemetryConnection(f.root)), /host-inventory-token|BEGIN CERTIFICATE/);
});

test('late acknowledgement after destination, CA and credential rotation cannot settle the new generation', async t => {
  const f = await fixture(t);
  const oldTls = await f.tls('old'), newTls = await f.tls('new');
  let finish, oldAuthorization;
  const oldEndpoint = await f.listen(createServer(oldTls, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    oldAuthorization = req.headers.authorization;
    finish = () => res.end(JSON.stringify({ ok: true, data: { revision: JSON.parse(body).revision, acknowledgedAt: new Date().toISOString() } }));
  }));
  const central = createGateway({ inventoryDirectory: path.join(f.root, 'central'), inventoryHosts: { [scope]: newToken } }, newTls);
  const newEndpoint = await f.listen(central);
  await f.saveLegacy(oldEndpoint, oldTls.cert);
  const sending = reconcileHostInventory(f.root);
  await waitFor(() => finish);
  await f.reconnect(newEndpoint, newTls.cert);
  assert.equal((await hostInventoryStatus(f.root)).pending, true, 'reconnect must invalidate the old acknowledgement before the next snapshot');
  finish();
  assert.equal((await sending).pending, true, 'superseded acknowledgement must be discarded');
  assert.equal(oldAuthorization, `Bearer ${oldToken}`);
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  // Same endpoint/CA, new credential is also a new connection generation.
  central.closeAllConnections();
  await f.reconnect(newEndpoint, newTls.cert, 'revoked-host-inventory-token');
  assert.equal((await hostInventoryStatus(f.root)).pending, true);
  const denied = await reconcileHostInventory(f.root);
  assert.equal(denied.pending, true); assert.equal(denied.failure, 'auth');
  assert.equal(denied.acknowledgedRevision, null);
});


test('inventory status stays opaque and pending when protected transport authority is unavailable', async t => {
  const f = await fixture(t);
  const tls = await f.tls('missing-authority');
  await f.saveLegacy('https://monitor.example/', tls.cert);
  await rm(path.join(f.telemetry, 'inventory-credential'));
  const status = await hostInventoryStatus(f.root, true);
  assert.equal(status.host, scope);
  assert.equal(status.pending, true);
  assert.equal(status.stale, true);
  assert.equal(status.failure, 'snapshot-unavailable');
  assert.equal(status.acknowledgedRevision, null);
});

test('named sender rotation reconnects a durable Host outbox over verified HTTPS and revocation leaves it pending', async t => {
  const f = await fixture(t);
  const { setupEnvironment, parseEnvironment } = await import('../monitoring/trace/setup.mjs');
  const { manageSenderCredentials } = await import('../monitoring/trace/sender-credentials.mjs');
  const stack = path.join(f.root, 'monitoring');
  await mkdir(stack);
  const envPath = path.join(stack, '.env');
  await writeFile(envPath, 'TRACE_TLS_MODE=proxy\nOPERATOR_SETTING=preserved\n');
  await setupEnvironment(envPath);
  const before = await readFile(envPath, 'utf8');
  const senderDirectory = path.join(stack, '.private/senders');
  const tls = await f.tls('sender-lifecycle');
  const central = createGateway({ senderDirectory, inventoryDirectory: path.join(stack, 'inventory') }, tls);
  const endpoint = await f.listen(central);
  const change = (action, options = {}) => manageSenderCredentials(senderDirectory, action, { sender: 'named-host', ...options });
  const connectExport = async filename => {
    const out = path.join(f.root, filename);
    await change('export', { out });
    const env = parseEnvironment(await readFile(out, 'utf8'));
    await connectHostTelemetryRelay(f.root, 'fake-network', {
      endpoint, credential: env.get('TRACE_INGEST_TOKEN'), inventoryCredential: env.get('HOST_INVENTORY_TOKEN'),
      inventoryHost: scope, caPem: tls.cert.toString(),
    });
    return env;
  };
  await change('issue', { host: scope });
  const first = await connectExport('first.env');
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  const initial = await hostInventoryStatus(f.root);
  assert.equal(initial.acknowledgedRevision, initial.desiredRevision);
  const sealed = path.join(f.root, 'hosts', scope, 'capsules/notes/.env.sporades.server');
  await mkdir(path.dirname(sealed), { recursive: true });
  await writeFile(sealed, 'opaque sealed Capsule Server env');
  const staged = await change('rotate');
  // A saved pending generation does not prevent the old durable connection from reconciling.
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  const next = await connectExport('next.env');
  assert.notEqual(next.get('HOST_INVENTORY_TOKEN'), first.get('HOST_INVENTORY_TOKEN'));
  assert.equal((await hostInventoryStatus(f.root)).pending, true, 'reconnect requires acknowledgement of the new protected connection');
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  await change('commit', { generation: staged.senders[0].pendingGeneration });
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  await change('revoke');
  // A later authoritative lifecycle change must remain pending after denial.
  const registryFile = path.join(f.root, 'hosts', scope, 'registry/capsules/notes.json');
  const recorded = JSON.parse(await readFile(registryFile, 'utf8'));
  await writeFile(registryFile, JSON.stringify({ ...recorded, status: 'stopped', updatedAt: new Date().toISOString() }));
  // Separate invocations reread the protected saved connection, simulating sender restart.
  const denied = await reconcileHostInventory(f.root);
  assert.equal(denied.pending, true);
  assert.equal(denied.failure, 'auth');
  assert.equal((await reconcileHostInventory(f.root)).pending, true);
  assert.equal(await readFile(envPath, 'utf8'), before);
  assert.equal(await readFile(sealed, 'utf8'), 'opaque sealed Capsule Server env');
  const status = JSON.stringify(await hostInventoryStatus(f.root));
  for (const pair of [first, next]) {
    assert(!status.includes(pair.get('HOST_INVENTORY_TOKEN')));
    assert(!status.includes(pair.get('TRACE_INGEST_TOKEN')));
  }
});

async function shutdownFixture(t) {
  const f = await fixture(t);
  const tls = await f.tls('shutdown');
  await f.saveLegacy('https://127.0.0.1:59999/', tls.cert);
  await mkdir(path.join(f.root, 'caddy'));
  await writeFile(path.join(f.root, 'caddy/Caddyfile'), '{\n admin off\n}\n# BEGIN Sporades Host metrics\nhttp://127.0.0.1:20190 { metrics /metrics }\n# END Sporades Host metrics\n');
  await writeFile(path.join(f.telemetry, 'resources.json'), JSON.stringify({ host: scope, address: '127.0.0.1', enabled: true, psi: false }));
  const stateFile = path.join(f.root, 'docker-state.json');
  await writeFile(stateFile, JSON.stringify({ relay: true, exporter: true }));
  const commands = path.join(f.root, 'commands');
  const failFile = path.join(f.root, 'failure');
  await writeFile(path.join(f.bin, 'docker'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile));
fs.appendFileSync(${JSON.stringify(commands)}, args.join(' ') + '\\n');
const name = args.at(-1), relay = name === 'sporades-telemetry-relay';
const key = relay ? 'relay' : 'exporter';
const failure = fs.existsSync(${JSON.stringify(failFile)}) ? fs.readFileSync(${JSON.stringify(failFile)}, 'utf8') : '';
if (args[0] === 'inspect') console.log(JSON.stringify({ State: { Running: state.relay }, Config: { Labels: { 'com.sporades.host-telemetry-relay': 'true' } } }));
if (args[0] === 'container') console.log(JSON.stringify([{ State: { Running: state.exporter }, Config: { Labels: { 'com.sporades.host-metrics': 'true' } } }]));
if (args[0] === 'stop') { if (failure === key) process.exit(1); state[key] = false; }
if (args[0] === 'rm') state.relay = false;
if (args[0] === 'run') { state.relay = true; fs.writeFileSync(stateFile, JSON.stringify(state)); if (failure === 'start') process.exit(1); }
fs.writeFileSync(stateFile, JSON.stringify(state));
`, { mode: 0o755 });
  await writeFile(path.join(f.bin, 'caddy'), `#!/bin/sh\nif [ -f '${failFile}' ] && [ "$(cat '${failFile}')" = caddy ]; then exit 1; fi\n`, { mode: 0o755 });
  await writeFile(path.join(f.bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const disableIntent = async () => {
    const file = path.join(f.telemetry, 'connection.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file)), exportsDisabled: true }));
  };
  return { ...f, stateFile, commands, failFile, disableIntent, cert: tls.cert };
}

test('disabled reconciliation resumes interrupted shutdown and retries failed shutdown without losing authority', async t => {
  const { disableHostTelemetryExports, reconcileHostTelemetryRelay, removeHostTelemetryAgents } = await import('../dist/cli/host-telemetry-relay.js');
  for (const failure of ['interrupted', 'caddy', 'relay', 'exporter']) {
    await t.test(failure, async t => {
      const f = await shutdownFixture(t);
      const credential = await readFile(path.join(f.telemetry, 'credential.env'));
      if (failure === 'interrupted') await f.disableIntent();
      else {
        await writeFile(f.failFile, failure);
        await assert.rejects(disableHostTelemetryExports(f.root, scope));
        assert.equal((await readHostTelemetryConnection(f.root)).exportsDisabled, true);
        await assert.rejects(reconcileHostTelemetryRelay(f.root), 'failed shutdown must not report successful reconciliation');
        await rm(f.failFile);
      }
      await reconcileHostTelemetryRelay(f.root);
      await reconcileHostTelemetryRelay(f.root, scope);
      assert.deepEqual(JSON.parse(await readFile(f.stateFile)), { relay: false, exporter: false });
      assert.doesNotMatch(await readFile(f.commands, 'utf8'), /run |rm -f|network connect/);
      assert.deepEqual(await readFile(path.join(f.telemetry, 'credential.env')), credential);
      await assert.rejects(removeHostTelemetryAgents(f.root, scope), /not acknowledged/);
      assert.equal((await hostInventoryStatus(f.root)).pending, true);
      assert.equal(JSON.parse(await readFile(path.join(f.root, 'hosts', scope, 'registry/capsules/notes.json'))).status, 'running');
    });
  }
});

test('failed reconnect restores a disabled connection without restarting its relay or exporter', async t => {
  const f = await shutdownFixture(t);
  const { disableHostTelemetryExports, reconcileHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  await disableHostTelemetryExports(f.root, scope);
  const before = await Promise.all(['connection.json', 'credential.env', 'collector.yaml', 'ca.pem'].map(name => readFile(path.join(f.telemetry, name))));
  await writeFile(f.commands, '');
  await writeFile(f.failFile, 'start');
  await assert.rejects(f.reconnect('https://127.0.0.1:59998/', f.cert), /failed to start/);
  assert.deepEqual(await Promise.all(['connection.json', 'credential.env', 'collector.yaml', 'ca.pem'].map(name => readFile(path.join(f.telemetry, name)))), before);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile)), { relay: false, exporter: false });
  assert.equal((await readFile(f.commands, 'utf8')).split('\n').filter(line => line.startsWith('run ')).length, 1, 'only the explicit reconnect candidate may start');
  await reconcileHostTelemetryRelay(f.root, scope);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile)), { relay: false, exporter: false });
});

test('Host export disable reconciles deliberate opt-out; agent removal denies revoked authority and retains credentials', async t => {
  const f = await fixture(t);
  const { disableHostTelemetryExports, removeHostTelemetryAgents, reconcileHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  const tls = await f.tls('removal');
  const central = createGateway({ inventoryDirectory: path.join(f.root, 'central'), inventoryHosts: { [scope]: oldToken } }, tls);
  const endpoint = await f.listen(central);
  await f.saveLegacy(endpoint, tls.cert);
  await mkdir(path.join(f.root, 'caddy'));
  await writeFile(path.join(f.root, 'caddy/Caddyfile'), '{\n admin off\n}\n');
  const commands = path.join(f.root, 'commands');
  await writeFile(path.join(f.bin, 'docker'), `#!/bin/sh\necho "$*" >> '${commands}'\nif [ "$1" = inspect ] && [ "$4" = sporades-telemetry-relay ]; then echo '{"State":{"Running":false},"Config":{"Labels":{"com.sporades.host-telemetry-relay":"true"}}}'; elif [ \"$1\" = container ] || [ \"$1\" = inspect ]; then exit 1; fi\n`, { mode: 0o755 });
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  const credentialBefore = await readFile(path.join(f.telemetry, 'credential.env'));
  await assert.rejects(removeHostTelemetryAgents(f.root, scope), /still enabled/);
  await disableHostTelemetryExports(f.root, scope);
  assert.equal((await readHostTelemetryConnection(f.root)).exportsDisabled, true);
  const result = await reconcileHostInventory(f.root);
  assert.equal(result.pending, false);
  const saved = JSON.parse(await readFile(path.join(f.telemetry, 'inventory.json')));
  assert.equal(saved.desired.capsules[0].state, 'opted-out');
  assert.deepEqual(saved.desired.capsules[0].targets, []);
  // A ordinary reconcile must not resurrect either exporter or relay.
  await writeFile(commands, '');
  await reconcileHostTelemetryRelay(f.root, scope);
  assert.doesNotMatch(await readFile(commands, 'utf8'), /run |network connect/);
  // Revoked inventory authority cannot be mistaken for acknowledged deliberate removal.
  await writeFile(path.join(f.telemetry, 'inventory-credential'), 'revoked-inventory-token\n', { mode: 0o600 });
  await assert.rejects(removeHostTelemetryAgents(f.root, scope), /not acknowledged/);
  assert.doesNotMatch(await readFile(commands, 'utf8'), /rm -f/);
  await writeFile(path.join(f.telemetry, 'inventory-credential'), oldToken + '\n', { mode: 0o600 });
  await removeHostTelemetryAgents(f.root, scope);
  assert.match(await readFile(commands, 'utf8'), /rm -f sporades-telemetry-relay/);
  assert.deepEqual(await readFile(path.join(f.telemetry, 'credential.env')), credentialBefore);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'hosts', scope, 'registry/capsules/notes.json'))).status, 'running');
});
