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
