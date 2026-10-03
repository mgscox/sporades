import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import path from 'node:path';
import { renderHostRelayCollectorConfig, connectHostTelemetryRelay, readHostTelemetryConnection } from '../dist/cli/host-telemetry-relay.js';
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
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
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
    await writeFile(path.join(telemetry, 'collector.yaml'), renderHostRelayCollectorConfig({ endpoint, caFile: true }));
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

test('Host diagnostics separate accepted HTTP from stored relay data and keep operator query authority ephemeral', async t => {
  const f = await fixture(t);
  const tls = await f.tls('diagnostics');
  const requests = [];
  const endpoint = await f.listen(createServer(tls, async (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.method === 'POST') {
      for await (const chunk of req) {}
      res.end('{}');
    } else {
      res.end(JSON.stringify({ ok: true, data: { queryVisible: true, recent: true } }));
    }
  }));
  await f.saveLegacy(endpoint, tls.cert);
  const { checkHostTelemetryDelivery } = await import('../dist/cli/host-telemetry-relay.js');
  const withoutQuery = await checkHostTelemetryDelivery(f.root);
  assert.equal(withoutQuery.checks.configuration.state, 'passed');
  assert.equal(withoutQuery.checks.tls.state, 'passed');
  assert.equal(withoutQuery.checks.otlpAcceptance.state, 'passed');
  assert.equal(withoutQuery.checks.recentIngestion.state, 'unavailable');
  assert.equal(withoutQuery.checks.backendQuery.state, 'unavailable');
  assert.equal(requests.length, 1);
  const withQuery = await checkHostTelemetryDelivery(f.root, 'operator:ephemeral-query-secret');
  assert.notEqual(withQuery.traceId, withQuery.relayTraceId, 'direct submission must not certify the relay path');
  assert.equal(withQuery.checks.recentIngestion.state, 'unavailable', 'fake relay accepted no diagnostic; direct query success is insufficient');
  assert.equal(withQuery.checks.backendQuery.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(withQuery), /ephemeral-query-secret|old-ingestion-token|BEGIN CERTIFICATE/);
  for (const file of ['connection.json', 'credential.env']) assert.doesNotMatch(await readFile(path.join(f.telemetry, file), 'utf8'), /ephemeral-query-secret/);
});

test('migration refuses a failed destination before changing the working saved binding', async t => {
  const f = await fixture(t);
  const tls = await f.tls('migration');
  const endpoint = await f.listen(createServer(tls, (req, res) => res.writeHead(401).end()));
  await f.saveLegacy('https://old.example/', tls.cert);
  const files = ['connection.json', 'collector.yaml', 'credential.env', 'ca.pem'];
  const oldBytes = await Promise.all(files.map(file => readFile(path.join(f.telemetry, file), 'utf8')));
  const { migrateHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  const result = await migrateHostTelemetryRelay(f.root, 'fake-network', { endpoint, credential: 'new-ingestion-token', inventoryCredential: newToken, inventoryHost: scope, caPem: tls.cert.toString() }, scope, 'operator:query-password');
  assert.equal(result.activation, 'not-applied');
  assert.equal(result.destination.checks.authentication.state, 'failed');
  assert.equal(result.rollback, 'working-binding-preserved');
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.telemetry, file), 'utf8'))), oldBytes);
});

test('failed relay activation restores the old endpoint, credential and readable inventory after migration preflight', async t => {
  const f = await fixture(t);
  const tls = await f.tls('activation');
  const endpoint = await f.listen(createServer(tls, async (req, res) => {
    for await (const part of req) {}
    res.end(req.method === 'POST' ? '{}' : JSON.stringify({ ok: true, data: req.url.startsWith('/v1/diagnostics/') ? { queryVisible: true, recent: true } : null }));
  }));
  await f.saveLegacy('https://old.example/', tls.cert);
  await writeFile(path.join(f.bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='inspect')process.stdout.write('{"State":{"Running":true},"Config":{"Labels":{"com.sporades.host-telemetry-relay":"true"}}}');
if(args[0]==='run'&&!args.includes('--rm')){const config=fs.readFileSync(${JSON.stringify(path.join(f.telemetry, 'collector.yaml'))},'utf8');if(config.includes(${JSON.stringify(endpoint)}))process.exit(1);}
`);
  const files = ['connection.json', 'collector.yaml', 'credential.env', 'ca.pem'];
  const oldBytes = await Promise.all(files.map(file => readFile(path.join(f.telemetry, file), 'utf8')));
  const { migrateHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  await assert.rejects(migrateHostTelemetryRelay(f.root, 'fake-network', { endpoint, credential: 'new-ingestion-token', inventoryCredential: newToken, inventoryHost: scope, caPem: tls.cert.toString() }, scope, 'operator:query-password'), /failed to start/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.telemetry, file), 'utf8'))), oldBytes);
  assert.equal((await readHostTelemetryConnection(f.root)).endpoint, 'https://old.example/');
});


test('interrupted relay activation reconciles the previous authority before exporting again', async t => {
  const f = await fixture(t);
  const tls = await f.tls('interrupted');
  await f.saveLegacy('https://old.example/', tls.cert);
  const marker = path.join(f.root, 'candidate-started');
  await writeFile(path.join(f.bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='inspect')process.stdout.write('{"State":{"Running":true},"Config":{"Labels":{"com.sporades.host-telemetry-relay":"true"}}}');
if(args[0]==='run')fs.writeFileSync(${JSON.stringify(marker)},'');
`);
  const script = `import {connectHostTelemetryRelay} from ${JSON.stringify(new URL('../dist/cli/host-telemetry-relay.js', import.meta.url).href)};await connectHostTelemetryRelay(${JSON.stringify(f.root)},'fake-network',${JSON.stringify({ endpoint: 'https://new.example/', credential: 'candidate-secret', inventoryCredential: newToken, inventoryHost: scope, caPem: tls.cert.toString() })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  await waitFor(() => readFile(marker).then(() => true, () => false));
  child.kill('SIGKILL'); await exited;
  const { reconcileHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  await reconcileHostTelemetryRelay(f.root);
  assert.equal((await readHostTelemetryConnection(f.root)).endpoint, 'https://old.example/');
  assert.equal(await readFile(path.join(f.telemetry, 'credential.env'), 'utf8'), 'SPORADES_INGEST_AUTH=Bearer old-ingestion-token\n');
  assert.doesNotMatch(await readFile(path.join(f.telemetry, 'collector.yaml'), 'utf8'), /new.example/);
});

test('migration verifies fresh destination storage, registers inventory anew and leaves old expectations and history intact', async t => {
  const f = await fixture(t);
  const tls = await f.tls('successful-migration');
  const { createServer: createHttpServer } = await import('node:http');
  const stored = new Map();
  const backend = createHttpServer(async (req, res) => {
    if (req.url === '/v1/traces') {
      let body = ''; for await (const part of req) body += part;
      const span = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0];
      stored.set(span.traceId, { traceID: span.traceId, spans: [{ traceID: span.traceId, operationName: span.name, startTime: Number(BigInt(span.startTimeUnixNano) / 1000n) }] });
      res.end('{}'); return;
    }
    try {
      const span = JSON.parse(await readFile(path.join(f.root, 'relay-body.json'), 'utf8')).resourceSpans[0].scopeSpans[0].spans[0];
      stored.set(span.traceId, { traceID: span.traceId, spans: [{ traceID: span.traceId, operationName: span.name, startTime: Number(BigInt(span.startTimeUnixNano) / 1000n) }] });
    } catch {}
    const trace = stored.get(req.url.split('/').at(-1));
    res.end(JSON.stringify({ data: trace ? [trace] : [] }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const base = `http://127.0.0.1:${backend.address().port}`;
  const common = { ingestToken: 'new-ingestion-token', uiUser: 'operator', uiPassword: 'query-password', collectorUrl: base, jaegerUrl: base };
  const oldDirectory = path.join(f.root, 'old-monitoring');
  const oldGateway = createGateway({ ...common, ingestToken: 'old-ingestion-token', inventoryDirectory: oldDirectory, inventoryHosts: { [scope]: oldToken } }, tls);
  const oldEndpoint = await f.listen(oldGateway);
  const newEndpoint = await f.listen(createGateway({ ...common, inventoryDirectory: path.join(f.root, 'new-monitoring'), inventoryHosts: { [scope]: newToken } }, tls));
  await f.saveLegacy(oldEndpoint, tls.cert);
  assert.equal((await reconcileHostInventory(f.root)).pending, false);
  const oldInventoryFiles = await import('node:fs/promises').then(fs => fs.readdir(oldDirectory));
  const before = await Promise.all(oldInventoryFiles.map(file => readFile(path.join(oldDirectory, file))));
  await writeFile(path.join(f.bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),https=require('node:https');const args=process.argv.slice(2);
if(args[0]==='inspect')process.stdout.write('{"State":{"Running":true},"Config":{"Labels":{"com.sporades.host-telemetry-relay":"true"}}}');
if(args[0]==='run'&&args.includes('--rm')){
 fs.writeFileSync(${JSON.stringify(path.join(f.root, 'relay-body.json'))},args.at(-1));process.stdout.write('accepted');
}
`);
  const { migrateHostTelemetryRelay, checkHostTelemetryDelivery } = await import('../dist/cli/host-telemetry-relay.js');
  const migration = await migrateHostTelemetryRelay(f.root, 'fake-network', { endpoint: newEndpoint, credential: 'new-ingestion-token', inventoryCredential: newToken, inventoryHost: scope, caPem: tls.cert.toString() }, scope, 'operator:query-password');
  assert.equal(migration.activation, 'applied');
  assert.equal(migration.oldInventory, 'operator-retirement-required');
  assert.equal((await hostInventoryStatus(f.root)).acknowledgedRevision, null);
  const registered = await reconcileHostInventory(f.root);
  assert.equal(registered.pending, false);
  assert.equal(registered.acknowledgedRevision, 2);
  const verification = await checkHostTelemetryDelivery(f.root, 'operator:query-password');
  assert.equal(verification.checks.backendQuery.state, 'passed');
  assert.equal(verification.checks.recentIngestion.state, 'passed');
  assert.equal(verification.backendStorage, 'verified-relay-trace');
  assert.notEqual(verification.traceId, verification.relayTraceId);
  assert.ok(stored.has(verification.relayTraceId));
  assert.deepEqual(await Promise.all(oldInventoryFiles.map(file => readFile(path.join(oldDirectory, file)))), before);
  assert.doesNotMatch(JSON.stringify(migration) + JSON.stringify(verification), /query-password|new-ingestion-token|host-inventory-token|BEGIN CERTIFICATE/);
  // A new invocation uses only durable Host state, independent of workstation profile selection.
  assert.equal((await readHostTelemetryConnection(f.root)).endpoint, newEndpoint);
});

test('sender stages distinguish TLS denial, partial OTLP rejection and malformed protected configuration', async t => {
  const f = await fixture(t);
  const trusted = await f.tls('trusted'), foreign = await f.tls('foreign');
  const endpoint = await f.listen(createServer(foreign, async (req, res) => {
    for await (const part of req) {}
    res.end('{"partialSuccess":{"rejectedSpans":"1","errorMessage":"private-backend-detail"}}');
  }));
  const { checkHostTelemetryDelivery } = await import('../dist/cli/host-telemetry-relay.js');
  await f.saveLegacy(endpoint, trusted.cert);
  const tlsDenied = await checkHostTelemetryDelivery(f.root);
  assert.equal(tlsDenied.checks.tls.state, 'failed');
  assert.equal(tlsDenied.checks.authentication.state, 'unavailable');
  assert.equal(tlsDenied.accepted, false);
  await f.saveLegacy(endpoint, foreign.cert);
  const partial = await checkHostTelemetryDelivery(f.root);
  assert.equal(partial.checks.tls.state, 'passed');
  assert.equal(partial.checks.otlpAcceptance.state, 'failed');
  assert.equal(partial.stage, 'partial-rejection');
  assert.doesNotMatch(JSON.stringify(partial), /private-backend-detail/);
  await writeFile(path.join(f.telemetry, 'connection.json'), 'null');
  const malformed = await checkHostTelemetryDelivery(f.root);
  assert.equal(malformed.checks.configuration.state, 'failed');
  assert.equal(malformed.backendStorage, 'verification-unavailable');
});

test('a binding changed during verification cannot be overwritten by a stale migration', async t => {
  const f = await fixture(t);
  const tls = await f.tls('racing-migration');
  let finish;
  const endpoint = await f.listen(createServer(tls, async (req, res) => {
    for await (const part of req) {}
    if (req.url.startsWith('/v1/diagnostics/')) finish = () => res.end('{"ok":true,"data":{"queryVisible":true,"recent":true}}');
    else res.end(req.method === 'POST' ? '{}' : '{"ok":true,"data":null}');
  }));
  await f.saveLegacy('https://old.example/', tls.cert);
  const { migrateHostTelemetryRelay } = await import('../dist/cli/host-telemetry-relay.js');
  const migrating = migrateHostTelemetryRelay(f.root, 'fake-network', { endpoint, credential: 'new-ingestion-token', inventoryCredential: newToken, inventoryHost: scope, caPem: tls.cert.toString() }, scope, 'operator:query-password');
  const rejected = assert.rejects(migrating, /binding changed/);
  await waitFor(() => Boolean(finish));
  await f.reconnect('https://replacement.example/', tls.cert);
  finish(); await rejected;
  assert.equal((await readHostTelemetryConnection(f.root)).endpoint, 'https://replacement.example/');
});

test('configuration diagnostics reject drift from the saved destination and mark unavailable probe tools explicitly', async t => {
  const f = await fixture(t);
  const tls = await f.tls('configuration-drift');
  const endpoint = await f.listen(createServer(tls, async (req, res) => { for await (const part of req) {} res.end('{}'); }));
  await f.saveLegacy(endpoint, tls.cert);
  const { checkHostTelemetryDelivery, renderHostRelayCollectorConfig } = await import('../dist/cli/host-telemetry-relay.js');
  await writeFile(path.join(f.telemetry, 'collector.yaml'), renderHostRelayCollectorConfig({ endpoint: 'https://wrong.example/', caFile: true }));
  const drift = await checkHostTelemetryDelivery(f.root);
  assert.equal(drift.checks.configuration.state, 'failed');
  await writeFile(path.join(f.telemetry, 'collector.yaml'), renderHostRelayCollectorConfig({ endpoint, caFile: true }));
  const probe = await checkHostTelemetryDelivery(f.root);
  assert.equal(probe.checks.configuration.state, 'passed');
  assert.equal(probe.checks.relayAcceptance.state, 'unavailable');
  assert.equal(probe.backendStorage, 'verification-unavailable');
});
