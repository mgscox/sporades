import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createTlsServer } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, stat, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createGateway } from '../monitoring/trace/gateway.mjs';
import { validateInventory } from '../dist/cli/inventory-contract.js';
import { queueHostInventory, exportHostInventory } from '../dist/cli/host-inventory.js';
import { inspectEnvironment, setupEnvironment } from '../monitoring/trace/setup.mjs';
import { connectHostTelemetryRelay } from '../dist/cli/host-telemetry-relay.js';

const scope = 'apps.example';
const token = 'host-only-inventory-token';
const otherToken = 'other-host-inventory-token';
const config = { ingestToken: 'ingestion-only-token', uiUser: 'operator', uiPassword: 'ui-only-password', inventoryHosts: { [scope]: token, 'other.example': otherToken } };
const capsule = (state = 'running') => ({ id: `${scope}/notes`, state, changedAt: '2026-10-02T00:00:00.000Z', release: 'release-1', targets: ['https://notes.apps.example/'] });
const inventory = (revision, state = 'running') => ({ schemaVersion: 1, host: scope, revision, capsules: [{ ...capsule(state), ...(state === 'stopped' ? { targets: [] } : {}) }] });
async function fixture(t) {
  const base = path.resolve('.sporades/inventory-tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'case-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('gateway inventory is exact Host-scoped, versioned, sanitized and durable after restart', async t => {
  const dir = await fixture(t);
  const inventoryDirectory = path.join(dir, 'central');
  const longestHost = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  const scopedConfig = { ...config, inventoryHosts: { ...config.inventoryHosts, [longestHost]: 'long-scope-inventory-token' }, inventoryDirectory };
  let gateway = createGateway(scopedConfig);
  let port = await listen(gateway);
  t.after(() => close(gateway));
  const update = (value, credential = token, host = scope) => fetch(`http://127.0.0.1:${port}/v1/inventory/${host}`, { method: 'PUT', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await update(inventory(1), config.ingestToken)).status, 403);
  assert.equal((await update({ schemaVersion: 1, host: longestHost, revision: 1, capsules: [] }, 'long-scope-inventory-token', longestHost)).status, 200, 'valid 253-character identities fit hashed storage filenames');
  assert.equal((await update(inventory(1), otherToken)).status, 403);
  assert.equal((await update({ ...inventory(1), host: 'other.example' })).status, 403);
  assert.equal((await update({ ...inventory(1), credential: 'must-not-store' })).status, 400);
  for (const target of ['https://notes.apps.example/?token=secret', 'https://user:secret@notes.apps.example/', 'https://notes.apps.example/__sporades/health', 'file:///etc/passwd', 'https://notes.apps.example:1234/']) {
    assert.equal((await update({ ...inventory(1), capsules: [{ ...capsule(), targets: [target] }] })).status, 400);
  }
  const first = await update(inventory(2));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.revision, 2);
  assert.equal((await update(inventory(2))).status, 200);
  assert.equal((await update({ ...inventory(2), capsules: inventory(2).capsules.map(({ targets, release, changedAt, state, id }) => ({ targets, release, changedAt, state, id })) })).status, 200, 'JSON field order cannot create a duplicate conflict');
  assert.equal((await update(inventory(1))).status, 409);
  assert.equal((await update(inventory(2, 'stopped'))).status, 409);
  assert.equal((await update({ ...inventory(3), capsules: [] })).status, 409, 'omission cannot erase an acknowledged expected Capsule');
  // Reordered concurrent requests never roll state back.
  const results = await Promise.all([update(inventory(4)), update(inventory(3, 'stopped'))]);
  assert.equal(results[0].status, 200);
  assert.ok([200, 409].includes(results[1].status));
  await close(gateway);
  gateway = createGateway(scopedConfig);
  port = await listen(gateway);
  const stored = await fetch(`http://127.0.0.1:${port}/v1/inventory/${scope}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.equal(stored.data.inventory.revision, 4);
  assert.equal(stored.data.inventory.capsules[0].state, 'running', 'disconnection and gateway restart retain expectations');
  const storageFile = path.join(inventoryDirectory, createHash('sha256').update(scope).digest('hex') + '.json');
  assert.equal((await stat(storageFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(storageFile, 'utf8'), /inventory-token|password|secret/);
  assert.equal((await update(inventory(5, 'stopped'))).status, 200);
  assert.equal((await update({ ...inventory(6), capsules: [{ ...capsule('deleted'), targets: [] }] })).status, 200);
});

test('configuration refuses reused scope tokens without exposing secrets and ships identical validation', async t => {
  const dir = await fixture(t);
  const env = `TRACE_TLS_MODE=proxy\nINVENTORY_HOSTS='{"apps.example":"${token}","other.example":"${token}"}'\n`;
  assert.throws(() => inspectEnvironment(env), /Invalid INVENTORY_HOSTS/);
  await writeFile(path.join(dir, '.env'), env);
  await assert.rejects(setupEnvironment(path.join(dir, '.env')), /Invalid INVENTORY_HOSTS/);
  await assert.rejects(readFile(path.join(dir, '.private/credentials.json')), /ENOENT/);
  const generated = await import('../monitoring/trace/inventory-contract.mjs');
  const tooManyTargets = { ...inventory(1), capsules: [{ ...capsule(), targets: Array.from({ length: 22 }, (_, i) => `https://alias-${i}.example/`) }] };
  assert.throws(() => validateInventory(tooManyTargets));
  assert.throws(() => generated.validateInventory(tooManyTargets));
  assert.deepEqual(generated.validateInventory(inventory(1)), validateInventory(inventory(1)));
  for (const value of [null, { ...inventory(1), revision: 0 }, { ...inventory(1), capsules: [capsule(), capsule()] }]) {
    assert.throws(() => validateInventory(value)); assert.throws(() => generated.validateInventory(value));
  }
});

test('reconnect cannot replace saved exact Host identity or mutate connection authority', async t => {
  const dir = await fixture(t);
  const telemetry = path.join(dir, 'telemetry');
  const fakeBin = path.join(dir, 'fake-bin');
  await mkdir(telemetry, { mode: 0o700 }); await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(fakeBin, 'docker'), 0o755);
  const descriptor = JSON.stringify({ schemaVersion: 1, endpoint: 'https://monitor.example/', network: 'fake-network', internalEndpoint: 'http://sporades-telemetry:4318/', caConfigured: false, inventoryHost: 'saved-host' });
  await writeFile(path.join(telemetry, 'connection.json'), descriptor, { mode: 0o600 });
  const oldPath = process.env.PATH;
  const oldFlock = process.env.SPORADES_TEST_FLOCK_PATH;
  process.env.SPORADES_TEST_FLOCK_PATH = path.resolve("test/support/exec-flock.py");
  process.env.PATH = fakeBin + path.delimiter + oldPath;
  try {
    await assert.rejects(connectHostTelemetryRelay(dir, 'fake-network', { endpoint: 'https://monitor.example/', credential: 'test-ingestion-token', inventoryHost: 'other-host' }), /identity cannot change/);
    assert.equal(await readFile(path.join(telemetry, 'connection.json'), 'utf8'), descriptor);
    await assert.rejects(readFile(path.join(telemetry, 'credential.env')), /ENOENT/);
  } finally { process.env.PATH = oldPath; if (oldFlock === undefined) delete process.env.SPORADES_TEST_FLOCK_PATH; else process.env.SPORADES_TEST_FLOCK_PATH = oldFlock; }
});

async function runHelper(args, env, input, expectedCode = 0) {
  const child = spawn(process.execPath, ['bin/sporades-host-helper.js', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.stdin.end(input ? JSON.stringify(input) : undefined);
  const [code] = await once(child, 'exit');
  assert.equal(code, expectedCode, stdout + stderr);
  return JSON.parse(stdout);
}
function sendTls(port, cert, method, credential, value) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`https://127.0.0.1:${port}/v1/inventory/${scope}`, { ca: cert, method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end(value ? JSON.stringify(value) : undefined);
  });
}

test('Host outbox catches up after TLS outage, helper restarts, lifecycle changes and deletion', async t => {
  const dir = await fixture(t);
  const hostRoot = path.join(dir, 'host');
  const telemetry = path.join(hostRoot, 'telemetry');
  const registry = path.join(hostRoot, 'hosts', scope, 'registry/capsules');
  await mkdir(telemetry, { recursive: true, mode: 0o700 });
  await mkdir(registry, { recursive: true });
  const neighborRegistry = path.join(hostRoot, 'hosts', 'z-other.example', 'registry/capsules');
  await mkdir(neighborRegistry, { recursive: true });
  await writeFile(path.join(neighborRegistry, 'neighbor.json'), JSON.stringify({ domain: 'z-other.example', subname: 'neighbor', hostedUrl: 'https://neighbor.z-other.example', status: 'running', updatedAt: '2026-10-02T00:00:00.000Z', currentRelease: { id: 'neighbor-release' } }));
  const certPath = path.join(dir, 'cert.pem'), keyPath = path.join(dir, 'key.pem');
  const certCommand = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(certCommand.status, 0, certCommand.stderr);
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const inventoryDirectory = path.join(dir, 'central');
  let gateway = createGateway({ ...config, inventoryDirectory }, { cert, key });
  const port = await listen(gateway);
  t.after(() => close(gateway));
  await writeFile(path.join(telemetry, 'connection.json'), JSON.stringify({ schemaVersion: 1, endpoint: `https://127.0.0.1:${port}/`, network: 'fake-network', internalEndpoint: 'http://sporades-telemetry:4318/', caConfigured: true, inventoryHost: scope }), { mode: 0o600 });
  await writeFile(path.join(telemetry, 'inventory-credential'), token + '\n', { mode: 0o600 });
  await writeFile(path.join(telemetry, 'ca.pem'), cert);
  const recordPath = path.join(registry, 'notes.json');
  let record = { domain: scope, subname: 'notes', hostedUrl: 'https://notes.apps.example', status: 'registered', aliasDomains: Array.from({ length: 20 }, (_, i) => `alias-${i}.example`), updatedAt: '2026-10-02T00:00:00.000Z', currentRelease: null };
  const persist = async () => { const temporary = recordPath + '.tmp'; await writeFile(temporary, JSON.stringify(record)); await rename(temporary, recordPath); };
  await persist();
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'config'), SPORADES_TEST_FLOCK_PATH: path.resolve('test/support/exec-flock.py') };
  const worker = () => runHelper(['--reconcile-inventory', Buffer.from(hostRoot).toString('base64url')], env);
  const first = await worker();
  assert.equal(first.data.pending, false);
  assert.equal(first.data.acknowledgedRevision, 1);
  const boundary = await sendTls(port, cert, 'GET', token);
  assert.equal(boundary.body.data.inventory.capsules[0].targets.length, 21, 'canonical origin plus all 20 supported aliases are queued and centrally acknowledged');
  await close(gateway);
  record = { ...record, status: 'released', currentRelease: { id: 'release-2' }, updatedAt: '2026-10-02T00:01:00.000Z' }; await persist();
  const disconnected = await worker();
  assert.equal(disconnected.data.pending, true);
  assert.equal(disconnected.data.acknowledgedRevision, 1);
  const firstOutbox = JSON.parse(await readFile(path.join(telemetry, 'inventory.json'), 'utf8'));
  assert.equal(firstOutbox.desired.capsules[0].release, 'release-2');
  record = { ...record, status: 'running', updatedAt: '2026-10-02T00:02:00.000Z', aliasDomains: ['changed.example'] }; await persist();
  await worker(); // fresh helper process; saved revision/ack survive.
  gateway = createGateway({ ...config, inventoryDirectory }, { cert, key });
  gateway.listen(port, '127.0.0.1'); await once(gateway, 'listening');
  const reconnected = await worker();
  assert.equal(reconnected.data.pending, false);
  assert.equal(reconnected.data.acknowledgedRevision, 3);
  const stored = await sendTls(port, cert, 'GET', token);
  assert.equal(stored.body.data.inventory.capsules[0].state, 'running');
  assert.deepEqual(stored.body.data.inventory.capsules[0].targets, ['https://changed.example/', 'https://notes.apps.example/']);
  assert.equal((await sendTls(port, cert, 'PUT', otherToken, inventory(100))).status, 403);
  assert.equal((await sendTls(port, cert, 'PUT', token, inventory(1))).status, 409);
  // Exercise the shipped mutation dispatch rather than just changing a fixture.
  const disabled = await runHelper([], env, { action: 'host.telemetry.disable', host: { alias: 'local-fake', domain: scope, remoteRoot: hostRoot, scheme: 'https' }, capsule: { subname: 'notes' } });
  assert.equal(disabled.ok, true);
  assert.equal(JSON.parse(await readFile(path.join(telemetry, 'inventory.json'), 'utf8')).desired.capsules[0].state, 'opted-out');
  await worker();
  record = { ...record, status: 'stopped', updatedAt: '2026-10-02T00:03:00.000Z' }; await persist(); await worker();
  await rm(recordPath); await worker();
  const deleted = await sendTls(port, cert, 'GET', token);
  assert.equal(deleted.body.data.inventory.capsules[0].state, 'deleted');
  assert.equal(deleted.body.data.inventory.capsules[1].state, 'running', 'other Hosted domains remain expected through neighbor opt-out/deletion');
  assert.deepEqual(deleted.body.data.inventory.capsules[0].targets, []);
  assert.equal((await stat(path.join(telemetry, 'inventory.json'))).mode & 0o777, 0o600);
  // Exercise the packaged recovery utility with the same TLS/scope/version rules.
  const recoveryDirectory = path.join(dir, 'recovery');
  await mkdir(recoveryDirectory);
  for (const name of ['inventory.mjs', 'inventory-contract.mjs', 'setup.mjs']) await copyFile(path.join('monitoring/trace', name), path.join(recoveryDirectory, name));
  await writeFile(path.join(recoveryDirectory, '.env'), `INVENTORY_HOSTS='${JSON.stringify({ [scope]: token })}'\n`, { mode: 0o600 });
  const recovery = async (operation, filename) => {
    const child = spawn(process.execPath, [path.join(recoveryDirectory, 'inventory.mjs'), operation, `https://127.0.0.1:${port}`, scope, filename, certPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
    const [code] = await once(child, 'exit');
    assert.doesNotMatch(output, new RegExp(token));
    return { code, output };
  };
  const recoveryFile = path.join(dir, 'recovered.json');
  assert.equal((await recovery('export', recoveryFile)).code, 0);
  assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600);
  assert.equal((await recovery('import', recoveryFile)).code, 0);
  assert.notEqual((await recovery('export', recoveryFile)).code, 0, 'recovery export refuses overwrites');
  await writeFile(recoveryFile, JSON.stringify(inventory(1)));
  assert.notEqual((await recovery('import', recoveryFile)).code, 0, 'recovery cannot undo a newer acknowledgement');
  await writeFile(recoveryFile, JSON.stringify({ ...deleted.body.data.inventory, host: 'other.example' }));
  assert.notEqual((await recovery('import', recoveryFile)).code, 0, 'recovery enforces exact scope before delivery');
  // Recovery export uses the same strict validation, never includes sealed env or tokens.
  process.env.SPORADES_TEST_FLOCK_PATH = env.SPORADES_TEST_FLOCK_PATH;
  try {
    const exported = await exportHostInventory(hostRoot);
    assert.deepEqual(exported, deleted.body.data.inventory);
    assert.doesNotMatch(JSON.stringify(exported), /inventory-token|sealedServerEnv|credential/);
    // Concurrent snapshots allocate one revision; incomplete/corrupt registry cannot erase expectations.
    const states = await Promise.all([queueHostInventory(hostRoot), queueHostInventory(hostRoot)]);
    assert.equal(states[0].desired.revision, states[1].desired.revision);
    await writeFile(recordPath, '{"credential":"private-validation-secret", BAD}');
    const malformed = await runHelper(['--reconcile-inventory', Buffer.from(hostRoot).toString('base64url')], env, undefined, 1);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.message, 'Invalid Host registry record.');
    assert.doesNotMatch(JSON.stringify(malformed), /private-validation-secret/);
    await rm(recordPath);
    const broken = createTlsServer({ cert, key }, (req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":true,'); setImmediate(() => res.destroy()); });
    });
    const brokenPort = await listen(broken);
    const connectionFile = path.join(telemetry, 'connection.json');
    const originalConnection = JSON.parse(await readFile(connectionFile, 'utf8'));
    try {
      await writeFile(connectionFile, JSON.stringify({ ...originalConnection, endpoint: `https://127.0.0.1:${brokenPort}/` }));
      const interrupted = await worker();
      assert.equal(interrupted.data.pending, true);
      assert.equal(interrupted.data.failure, 'network-or-tls', 'a partial HTTPS acknowledgement is a bounded retryable failure');
    } finally { await close(broken); await writeFile(connectionFile, JSON.stringify(originalConnection)); }
    assert.equal((await worker()).data.pending, false);
    await rename(path.join(hostRoot, 'hosts', scope), path.join(hostRoot, 'missing-domain'));
    await assert.rejects(queueHostInventory(hostRoot), /registry disappeared/);
  } finally { delete process.env.SPORADES_TEST_FLOCK_PATH; }
});
