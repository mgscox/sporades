import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createGateway } from '../monitoring/trace/gateway.mjs';
import { inventoryAuthorities } from '../monitoring/trace/setup.mjs';
import { validateInventory } from '../dist/cli/lifecycle-inventory.js';
import { exportHostInventory, importHostInventory, hostInventoryStatus } from '../dist/cli/host-lifecycle-inventory.js';

const host = 'host-one';
const token = 'test-inventory-token-one';
const otherToken = 'test-inventory-token-two';
const capsule = { identity: 'apps.example/notes', state: 'started', targets: ['https://notes.apps.example/'], releaseId: 'r1' };
const inventory = (revision, capsules = [capsule], authority = host) => ({ schemaVersion: 1, host: authority, revision, capsules });
const temp = async () => { await mkdir('.test-tmp', { recursive: true }); return mkdtemp(path.resolve('.test-tmp/inventory-')); };
const child = (args, input) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, SPORADES_CONFIG_DIR: path.resolve('.test-config') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', x => stdout += x); p.stderr.on('data', x => stderr += x);
  p.on('error', reject); p.on('exit', code => resolve({ code, stdout, stderr }));
  p.stdin.end(input);
});

test('gateway stores exact Host authority, canonical retries, denials, ordered revisions and durable tombstones', async () => {
  const root = await temp();
  let server;
  const start = async () => {
    server = createGateway({ inventoryHosts: { [host]: token, 'host-two': otherToken }, inventoryDirectory: path.join(root, 'central'), ingestToken: 'ingest-only', uiUser: 'operator', uiPassword: 'ui-only' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  let base = await start();
  const send = (value, credential = token, target = host) => fetch(`${base}/v1/inventory/${target}`, { method: 'PUT', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const get = (credential = token, target = host) => fetch(`${base}/v1/inventory/${target}`, { headers: { authorization: `Bearer ${credential}` } });
  try {
    const first = await send(inventory(2)); assert.equal(first.status, 200); const ack = await first.json();
    assert.equal((await send(inventory(2))).status, 200);
    assert.deepEqual(await (await send(inventory(2))).json(), ack);
    assert.equal((await send(inventory(1))).status, 409);
    assert.equal((await send(inventory(2, [{ ...capsule, state: 'stopped' }]))).status, 409);
    for (const credential of [otherToken, 'ingest-only', 'ui-only', 'unknown']) assert.equal((await send(inventory(3), credential)).status, 403);
    assert.equal((await send(inventory(3, [capsule], 'host-two'))).status, 403);
    assert.equal((await send(inventory(3), token, 'host-two')).status, 403);
    assert.equal((await get(otherToken)).status, 403);
    assert.equal((await send(inventory(3, [{ ...capsule, targets: ['https://notes.apps.example/?secret=leak'] }]))).status, 400);
    assert.equal((await send({ ...inventory(3), control: 'restart' })).status, 400);
    assert.equal((await send(inventory(3, []))).status, 409);
    assert.equal((await send(inventory(3, [{ ...capsule, state: 'stopped' }]))).status, 200);
    await stop(); base = await start();
    const stored = await (await get()).json(); assert.equal(stored.inventory.revision, 3); assert.equal(stored.inventory.capsules[0].state, 'stopped');
    assert.equal((await send(inventory(2))).status, 409);
    assert.equal((await send(inventory(4, [{ identity: capsule.identity, state: 'deleted', targets: [] }]))).status, 200);
    assert.equal((await (await get()).json()).inventory.capsules[0].state, 'deleted');
    assert.equal((await send(inventory(1, [{ ...capsule }], 'host-two'), otherToken, 'host-two')).status, 200);
    const file = await readFile(path.join(root, 'central', `${host}.json`), 'utf8');
    assert.doesNotMatch(file, /test-inventory-token/);
  } finally { await stop(); await rm(root, { recursive: true, force: true }); }
});

test('contract and authority configuration reject secret-bearing targets, duplicate identities and reused credentials', () => {
  for (const target of ['https://user:pass@notes.apps.example/', 'https://notes.apps.example/private', 'https://notes.apps.example/#key', 'file:///etc/passwd']) assert.throws(() => validateInventory(inventory(1, [{ ...capsule, targets: [target] }])));
  assert.throws(() => validateInventory(inventory(1, [capsule, capsule])));
  assert.throws(() => inventoryAuthorities(JSON.stringify({ [host]: token, 'host-two': token })));
  assert.throws(() => inventoryAuthorities(JSON.stringify({ [host]: token }), token));
  assert.throws(() => inventoryAuthorities('{secret invalid json}'));
});

test('concurrent separate senders cannot reverse central acknowledgement', async () => {
  const root = await temp();
  try {
    const script = `import {acknowledgeInventory} from './dist/cli/lifecycle-inventory.js';try { const ack=await acknowledgeInventory(process.argv[1],process.argv[2],JSON.parse(process.argv[3]));process.stdout.write(String(ack.inventory.revision)); } catch(e) {process.stdout.write(String(e.status));}`;
    const results = await Promise.all([4, 2, 3, 1, 5].map(n => child(['--input-type=module', '-e', script, path.join(root, 'central'), host, JSON.stringify(inventory(n))])));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(path.join(root, 'central', `${host}.json`))).inventory.revision, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host sender recovers latest authoritative state after outage and process restart over verified HTTPS', async () => {
  const root = await temp();
  let server;
  try {
    const cert = path.join(root, 'cert.pem'), key = path.join(root, 'key.pem');
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const tls = { cert: await readFile(cert), key: await readFile(key) };
    const gateway = () => createGateway({ inventoryHosts: { [host]: token }, inventoryDirectory: path.join(root, 'central') }, tls);
    server = gateway(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const remoteRoot = path.join(root, 'host'); const telemetry = path.join(remoteRoot, 'telemetry');
    const registry = path.join(remoteRoot, 'hosts', 'apps.example', 'registry', 'capsules');
    await mkdir(telemetry, { recursive: true, mode: 0o700 }); await mkdir(registry, { recursive: true });
    await writeFile(path.join(telemetry, 'connection.json'), JSON.stringify({ schemaVersion: 1, endpoint: `https://127.0.0.1:${port}/`, network: 'fake-network', internalEndpoint: 'http://sporades-telemetry:4318/', caConfigured: true, connectedAt: new Date().toISOString(), inventoryHost: host }), { mode: 0o600 });
    await writeFile(path.join(telemetry, 'inventory-credential.json'), JSON.stringify({ credential: token }), { mode: 0o600 });
    await writeFile(path.join(telemetry, 'ca.pem'), tls.cert, { mode: 0o644 });
    let record = { domain: 'apps.example', subname: 'notes', hostedUrl: 'https://notes.apps.example', status: 'registered', updatedAt: new Date().toISOString() };
    const save = async changes => { record = { ...record, ...changes, updatedAt: new Date(Date.now() + 5).toISOString() }; await writeFile(path.join(registry, 'notes.json'), JSON.stringify(record)); };
    await save({});
    const sync = async () => {
      const result = await child(['bin/sporades-host-helper.js', '--sync-inventory', Buffer.from(JSON.stringify({ alias: 'test', remoteRoot, domain: 'apps.example', scheme: 'https' })).toString('base64url')]);
      assert.equal(result.code, 0, result.stderr + result.stdout); const data = JSON.parse(result.stdout); assert.equal(data.ok, true, result.stdout); return data.data;
    };
    let state = await sync(); assert.equal(state.pending, false); assert.equal(state.acknowledgedRevision, 1);
    await save({ status: 'released', currentRelease: { id: 'r1' } }); await sync();
    await save({ status: 'running' }); await sync();
    const revision = (await hostInventoryStatus(remoteRoot)).desiredRevision;
    await save({ updatedAt: new Date(Date.now() + 1000).toISOString() }); await sync();
    assert.ok((await hostInventoryStatus(remoteRoot)).desiredRevision > revision);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await save({ status: 'stopped' }); state = await sync(); assert.equal(state.pending, true); assert.equal(state.delivery, 'unavailable');
    await save({ status: 'running', currentRelease: { id: 'r0' }, aliasDomains: ['notes.example'] });
    const desired = await exportHostInventory(remoteRoot); assert.equal(desired.capsules[0].releaseId, 'r0');
    await save({ telemetry: { disabled: true } }); await sync();
    server = gateway(); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    state = await sync(); assert.equal(state.pending, false); assert.equal(state.stale, false);
    const central = JSON.parse(await readFile(path.join(root, 'central', `${host}.json`)));
    assert.equal(central.inventory.capsules[0].state, 'opted-out'); assert.deepEqual(central.inventory.capsules[0].targets, ['https://notes.apps.example/', 'https://notes.example/']);
    await assert.rejects(importHostInventory(remoteRoot, inventory(999, [capsule], 'host-two')), /authority denied/);
    await assert.rejects(importHostInventory(remoteRoot, inventory(1)), /revision conflict/);
    // Lost sender state is recovered from a centrally exported snapshot, then
    // authoritative Host state supersedes it on the next reconciliation.
    await rm(path.join(telemetry, 'inventory', 'desired.json'));
    await importHostInventory(remoteRoot, central.inventory); assert.equal((await sync()).pending, false);
    await save({ status: 'unregistered' }); await sync();
    await rm(path.join(registry, 'notes.json')); await sync();
    assert.equal(JSON.parse(await readFile(path.join(root, 'central', `${host}.json`))).inventory.capsules[0].state, 'deleted');
    const before = await readFile(path.join(root, 'central', `${host}.json`), 'utf8');
    await writeFile(path.join(telemetry, 'inventory-credential.json'), JSON.stringify({ credential: otherToken }), { mode: 0o600 });
    state = await sync(); assert.equal(state.delivery, 'authority-denied'); assert.equal(await readFile(path.join(root, 'central', `${host}.json`), 'utf8'), before);
    await writeFile(path.join(telemetry, 'inventory-credential.json'), JSON.stringify({ credential: token }), { mode: 0o600 });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    server = createGateway({ inventoryHosts: { [host]: token }, inventoryDirectory: path.join(root, 'central-migrated') }, tls);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const descriptorFile = path.join(telemetry, 'connection.json');
    const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'));
    descriptor.endpoint = `https://127.0.0.1:${server.address().port}/`;
    await writeFile(descriptorFile, JSON.stringify(descriptor));
    const oldRevision = state.desiredRevision;
    await exportHostInventory(remoteRoot);
    const migrating = await hostInventoryStatus(remoteRoot);
    assert.equal(migrating.pending, true); assert.equal(migrating.acknowledgedRevision, 0); assert.ok(migrating.desiredRevision > oldRevision);
    state = await sync(); assert.equal(state.pending, false);
    assert.equal(JSON.parse(await readFile(path.join(root, 'central-migrated', `${host}.json`))).inventory.revision, state.acknowledgedRevision);
    assert.equal(await readFile(path.join(root, 'central', `${host}.json`), 'utf8'), before);
    await chmod(path.join(telemetry, 'inventory', 'desired.json'), 0o666); await assert.rejects(exportHostInventory(remoteRoot), /Unprotected/);
  } finally {
    server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});


test('shipped inventory validation matches generated gateway contract and public state union', async () => {
  const shipped = await import('../monitoring/trace/inventory.mjs');
  for (const state of ['registered', 'released', 'started', 'stopped', 'failed', 'deleted', 'opted-out']) {
    const value = inventory(1, [{ ...capsule, state, targets: state === 'deleted' ? [] : capsule.targets }]);
    assert.deepEqual(validateInventory(value), shipped.validateInventory(value));
  }
  const types = await readFile(new URL('../src/types/telemetry-inventory.d.ts', import.meta.url), 'utf8');
  assert.match(types, /"released"/); assert.match(types, /lifecycleAt\?: string/);
});

test('a killed inventory writer releases authority locking for restart recovery', async () => {
  const root = await temp();
  let holder;
  try {
    const directory = path.join(root, 'central');
    const script = `import {withInventoryLock} from './dist/cli/lifecycle-inventory.js';await withInventoryLock(process.argv[1],async()=>{process.stdout.write('holding');await new Promise(()=>{});});`;
    holder = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPORADES_CONFIG_DIR: path.resolve('.test-config') } });
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('writer exited before acquisition'))); });
    const ended = new Promise(resolve => holder.once('exit', resolve)); holder.kill('SIGKILL'); await ended;
    const writer = `import {acknowledgeInventory} from './dist/cli/lifecycle-inventory.js';process.stdout.write(JSON.stringify(await acknowledgeInventory(process.argv[1],process.argv[2],JSON.parse(process.argv[3]))));`;
    const result = await child(['--input-type=module', '-e', writer, directory, host, JSON.stringify(inventory(1))]);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).inventory.revision, 1);
  } finally { holder?.kill(); await rm(root, { recursive: true, force: true }); }
});
