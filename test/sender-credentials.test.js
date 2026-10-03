import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promises as filesystem } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createGateway } from '../monitoring/trace/gateway.mjs';
import { setupEnvironment, parseEnvironment } from '../monitoring/trace/setup.mjs';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';

const root = path.resolve('.');
async function fixture(t) {
  const base = path.join(root, '.sporades/sender-tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'case-'));
  await writeFile(path.join(dir, '.env'), 'TRACE_TLS_MODE=proxy\nOPERATOR_SETTING=keep-$VALUE\n');
  await setupEnvironment(path.join(dir, '.env'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function command(dir, action, ...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/sporades.js'), 'monitoring', 'sender', action, '--dir', dir, ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'config') },
  });
  const envelope = JSON.parse(result.stdout);
  return { ...result, envelope };
}
function good(dir, action, ...args) {
  const result = command(dir, action, ...args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.envelope.ok, true);
  return result.envelope.data;
}
async function credentials(dir, name, filename) {
  const out = path.join(dir, filename);
  good(dir, 'export', '--sender', name, '--out', out);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  const env = parseEnvironment(await readFile(out, 'utf8'));
  return { ingest: env.get('TRACE_INGEST_TOKEN'), inventory: env.get('HOST_INVENTORY_TOKEN'), generation: Number(env.get('SPORADES_SENDER_GENERATION')) };
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
const inventory = (host, revision = 1) => ({ schemaVersion: 1, host, revision, capsules: [] });

test('installed CLI sender lifecycle preserves env, retries safely, and never emits credentials', async t => {
  const dir = await fixture(t);
  const env = await readFile(path.join(dir, '.env'), 'utf8');
  const sealed = path.join(dir, '.env.sporades.server');
  await writeFile(sealed, 'opaque Capsule sealed Server env');
  const first = good(dir, 'issue', '--sender', 'host-a', '--host', 'a.example');
  assert.equal(first.senders[0].state, 'applied');
  assert.equal(first.senders[0].generation, 1);
  assert.equal(good(dir, 'issue', '--sender', 'host-a', '--host', 'a.example').changed, false);
  const a = await credentials(dir, 'host-a', 'a.env');
  assert.notEqual(a.ingest, a.inventory);
  assert.equal(command(dir, 'issue', '--sender', 'host-b', '--host', 'a.example').status, 1);
  assert.equal(command(dir, 'issue', '--sender', 'host-a', '--host', 'b.example').status, 1);
  const pending = good(dir, 'rotate', '--sender', 'host-a');
  assert.equal(pending.senders[0].pendingGeneration, 2);
  assert.equal(good(dir, 'rotate', '--sender', 'host-a').changed, false);
  const next = await credentials(dir, 'host-a', 'next.env');
  assert.notEqual(next.ingest, a.ingest);
  const retry = await credentials(dir, 'host-a', 'retry.env');
  assert.deepEqual(retry, next);
  assert.equal(command(dir, 'commit', '--sender', 'host-a', '--generation', '3').status, 1);
  assert.equal(good(dir, 'commit', '--sender', 'host-a', '--generation', '2').senders[0].state, 'applied');
  assert.equal(good(dir, 'commit', '--sender', 'host-a', '--generation', '2').changed, false);
  good(dir, 'rotate', '--sender', 'host-a');
  assert.equal(command(dir, 'commit', '--sender', 'host-a', '--generation', '2').status, 1, 'a stale retry cannot finalize a later rotation');
  assert.equal(good(dir, 'cancel', '--sender', 'host-a').senders[0].generation, 2);
  assert.equal(good(dir, 'cancel', '--sender', 'host-a').changed, false);
  good(dir, 'rotate', '--sender', 'host-a');
  const staged = await credentials(dir, 'host-a', 'staged.env');
  assert.equal(command(dir, 'commit', '--sender', 'host-a', '--generation', '3').status, 1, 'cancelled generation numbers are never reused');
  good(dir, 'revoke', '--sender', 'host-a');
  assert.equal(good(dir, 'revoke', '--sender', 'host-a').changed, false);
  assert.equal(command(dir, 'export', '--sender', 'host-a', '--out', path.join(dir, 'denied.env')).status, 1);
  assert.equal(command(dir, 'issue', '--sender', 'host-a', '--host', 'a.example').status, 1);
  await setupEnvironment(path.join(dir, '.env'));
  assert.equal(good(dir, 'status').senders[0].state, 'revoked', 'setup cannot resurrect revoked credentials');
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), env);
  assert.equal(await readFile(sealed, 'utf8'), 'opaque Capsule sealed Server env');
  const output = JSON.stringify(first) + JSON.stringify(pending) + JSON.stringify(good(dir, 'status'));
  for (const pair of [a, next, staged]) for (const token of [pair.ingest, pair.inventory]) assert(!output.includes(token));
  good(dir, 'issue', '--sender', 'workstation');
  const ws = await credentials(dir, 'workstation', 'ws.env');
  assert.equal(ws.inventory, undefined);
  good(dir, 'legacy-revoke', '--host', 'a.example');
  good(dir, 'legacy-revoke', '--ingest');
  assert.equal(good(dir, 'legacy-revoke', '--ingest').changed, false);
  await setupEnvironment(path.join(dir, '.env'));
  assert.equal(good(dir, 'status').legacyIngestEnabled, false);
});

test('gateway reload/restart enforces real sender exports and exact inventory scope through rotation/revocation', async t => {
  const dir = await fixture(t);
  const stored = [];
  const collector = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    stored.push({ url: req.url, body: JSON.parse(body), authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const collectorUrl = await listen(collector);
  t.after(() => close(collector));
  const cfg = { ...JSON.parse(await readFile(path.join(dir, '.private/credentials.json'), 'utf8')), collectorUrl,
    senderDirectory: path.join(dir, '.private/senders'), inventoryDirectory: path.join(dir, 'inventory'),
    inventoryHosts: { 'a.example': 'legacy-a-inventory-token', 'b.example': 'legacy-b-inventory-token' } };
  let gateway = createGateway(cfg), origin = await listen(gateway);
  t.after(() => close(gateway));
  good(dir, 'issue', '--sender', 'host-a', '--host', 'a.example');
  good(dir, 'issue', '--sender', 'host-b', '--host', 'b.example');
  good(dir, 'issue', '--sender', 'laptop');
  const a = await credentials(dir, 'host-a', 'a.env'), b = await credentials(dir, 'host-b', 'b.env'), laptop = await credentials(dir, 'laptop', 'laptop.env');
  const ingest = (token, route = '/v1/traces') => fetch(origin + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  const update = (token, host, revision = 1) => fetch(`${origin}/v1/inventory/${host}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(inventory(host, revision)) });
  async function exportRuntime(token) {
    process.env.SENDER_LIFECYCLE_TEST_TOKEN = token;
    const telemetry = createHttpRequestTelemetry({ endpoint: origin, tls: { mode: 'loopback' }, credentialEnv: 'SENDER_LIFECYCLE_TEST_TOKEN', serviceName: 'credential-lifecycle-test' });
    const app = createServer((req, res) => telemetry.run(req, res, [{ method: 'GET', path: '/work' }], () => res.writeHead(200).end('ok')));
    const appOrigin = await listen(app);
    const previous = stored.length;
    try { assert.equal((await fetch(appOrigin + '/work')).status, 200); await telemetry.shutdown(); }
    finally { await telemetry.shutdown(); await close(app); delete process.env.SENDER_LIFECYCLE_TEST_TOKEN; }
    assert(stored.slice(previous).some(item => item.url === '/v1/traces' && item.body.resourceSpans?.length));
    assert(stored.slice(previous).some(item => item.url === '/v1/metrics' && item.body.resourceMetrics?.length));
    assert(stored.every(item => item.authorization === undefined), 'gateway strips sender authority before collector export');
  }
  await exportRuntime(a.ingest);
  assert.equal((await update(a.inventory, 'a.example')).status, 200);
  for (const route of ['/', '/grafana/', '/api/traces', '/grafana/api/admin/users']) {
    assert.equal((await fetch(origin + route, { headers: { authorization: `Bearer ${a.ingest}` } })).status, 401);
    assert.equal((await fetch(origin + route, { headers: { authorization: `Bearer ${a.inventory}` } })).status, 401);
  }
  assert.equal((await ingest(a.inventory)).status, 401);
  assert.equal((await update(a.ingest, 'a.example')).status, 403);
  assert.equal((await update(a.inventory, 'b.example')).status, 403);
  assert.equal((await update(laptop.ingest, 'a.example')).status, 403);
  assert.equal((await ingest(Buffer.from(`${cfg.uiUser}:${cfg.uiPassword}`).toString('base64'))).status, 401);
  good(dir, 'rotate', '--sender', 'host-a');
  const next = await credentials(dir, 'host-a', 'next.env');
  await close(gateway); gateway = createGateway(cfg); origin = await listen(gateway);
  assert.equal((await ingest(a.ingest)).status, 200, 'interrupted rotation preserves old generation after restart');
  await exportRuntime(next.ingest);
  assert.equal((await update(next.inventory, 'a.example', 2)).status, 200);
  good(dir, 'commit', '--sender', 'host-a', '--generation', '2');
  assert.equal((await ingest(a.ingest)).status, 401);
  assert.equal((await update(a.inventory, 'a.example', 3)).status, 403);
  assert.equal((await ingest(next.ingest)).status, 200);
  assert.equal((await update(next.inventory, 'a.example', 3)).status, 200);
  assert.equal((await ingest(b.ingest, '/v1/metrics')).status, 200);
  assert.equal((await update(b.inventory, 'b.example')).status, 200);
  good(dir, 'rotate', '--sender', 'host-a');
  const staged = await credentials(dir, 'host-a', 'staged.env');
  good(dir, 'cancel', '--sender', 'host-a');
  assert.equal((await ingest(staged.ingest)).status, 401);
  assert.equal((await update(staged.inventory, 'a.example')).status, 403);
  good(dir, 'rotate', '--sender', 'host-a');
  const pending = await credentials(dir, 'host-a', 'pending.env');
  good(dir, 'revoke', '--sender', 'host-a');
  await setupEnvironment(path.join(dir, '.env'));
  await close(gateway); gateway = createGateway(cfg); origin = await listen(gateway);
  for (const pair of [next, pending]) {
    assert.equal((await ingest(pair.ingest)).status, 401);
    assert.equal((await update(pair.inventory, 'a.example')).status, 403);
  }
  await exportRuntime(b.ingest);
  assert.equal((await update(b.inventory, 'b.example', 2)).status, 200);
  assert.equal((await ingest(laptop.ingest)).status, 200);
  good(dir, 'legacy-revoke', '--host', 'a.example');
  good(dir, 'legacy-revoke', '--ingest');
  assert.equal((await ingest(cfg.ingestToken)).status, 401);
  assert.equal((await update(cfg.inventoryHosts['a.example'], 'a.example')).status, 403);
  assert.equal((await update(cfg.inventoryHosts['b.example'], 'b.example', 3)).status, 200);
  assert.equal((await ingest(b.ingest)).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'inventory', (await import('node:crypto')).createHash('sha256').update('a.example').digest('hex') + '.json'), 'utf8')).inventory.revision, 3, 'revocation retains acknowledged expected targets');
  const registry = path.join(dir, '.private/senders/registry.json');
  const saved = await readFile(registry, 'utf8');
  await writeFile(registry, '{broken secret value');
  assert.equal((await ingest(b.ingest)).status, 503, 'invalid reload fails closed');
  assert.equal((await update(b.inventory, 'b.example')).status, 503);
  assert.equal((await fetch(origin + '/health')).status, 503);
  assert(!command(dir, 'status').stdout.includes('broken secret value'));
  await writeFile(registry, saved);
  assert.equal((await ingest(b.ingest)).status, 200);
  await chmod(registry, 0o644);
  assert.equal((await ingest(b.ingest)).status, 503);
});

test('gateway retries a registry replaced between open and stat without retaining retired authority', async t => {
  const dir = await fixture(t);
  good(dir, 'issue', '--sender', 'host-a', '--host', 'a.example');
  good(dir, 'issue', '--sender', 'host-b', '--host', 'b.example');
  const a = await credentials(dir, 'host-a', 'a.env'), b = await credentials(dir, 'host-b', 'b.env');
  const collector = createServer((_req, res) => res.writeHead(200).end('{}'));
  const collectorUrl = await listen(collector);
  t.after(() => close(collector));
  const gateway = createGateway({ ...JSON.parse(await readFile(path.join(dir, '.private/credentials.json'), 'utf8')),
    collectorUrl, senderDirectory: path.join(dir, '.private/senders'), inventoryDirectory: path.join(dir, 'inventory') });
  const origin = await listen(gateway);
  t.after(() => close(gateway));
  const registry = path.join(dir, '.private/senders/registry.json');
  const ingest = token => fetch(origin + '/v1/traces', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  const update = token => fetch(origin + '/v1/inventory/a.example', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(inventory('a.example')) });
  async function replaceDuringRead(action, sender, request, { phase = 'open', readNumber = 1 } = {}, ...args) {
    const original = filesystem.open;
    let replacements = 0, reads = 0;
    // Schedule a real CLI atomic replacement after the gateway opens its old
    // inode, before it can stat/read it. Other filesystem operations stay real.
    filesystem.open = async (...openArgs) => {
      const file = await original(...openArgs);
      if (openArgs[0] === registry && ++reads === readNumber) {
        const replace = () => { replacements++; good(dir, action, '--sender', sender, ...args); };
        if (phase === 'read') {
          const originalRead = file.readFile;
          file.readFile = async (...readArgs) => { const data = await originalRead.call(file, ...readArgs); replace(); return data; };
        } else {
          try { replace(); }
          catch (error) { await file.close(); throw error; }
        }
      }
      return file;
    };
    syncBuiltinESMExports();
    try { const response = await request(); assert.equal(replacements, 1); return response.status; }
    finally { filesystem.open = original; syncBuiltinESMExports(); }
  }
  good(dir, 'rotate', '--sender', 'host-a');
  const next = await credentials(dir, 'host-a', 'next.env');
  assert.equal(await replaceDuringRead('commit', 'host-a', () => ingest(a.ingest), {}, '--generation', '2'), 401);
  assert.equal((await ingest(next.ingest)).status, 200);
  assert.equal(await replaceDuringRead('rotate', 'host-b', () => ingest(next.ingest)), 200, 'unrelated sender remains available during publication');
  assert.equal(await replaceDuringRead('revoke', 'host-a', () => update(next.inventory), { phase: 'read', readNumber: 2 }), 403, 'the final authorization reread must observe replacement during its read');
  assert.equal((await ingest(b.ingest)).status, 200);
});

test('concurrent writers lock and atomically preserve both senders; protected export never overwrites operator files', async t => {
  const dir = await fixture(t);
  good(dir, 'issue', '--sender', 'laptop');
  const env = await readFile(path.join(dir, '.env'), 'utf8');
  const failed = command(dir, 'export', '--sender', 'laptop', '--out', path.join(dir, '.env'));
  assert.equal(failed.status, 1);
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), env);
  const link = path.join(dir, 'link.env');
  await symlink(path.join(dir, '.env'), link);
  assert.equal(command(dir, 'export', '--sender', 'laptop', '--out', link).status, 1);
  assert.equal(command(dir, 'export', '--sender', 'laptop', '--out', path.join(dir, '.private/senders/export.env')).status, 1);
  const lock = path.join(dir, '.private/senders/.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999999 }));
  const blocked = command(dir, 'rotate', '--sender', 'laptop');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /writer has exited/);
  assert.equal(JSON.parse(await readFile(path.join(dir, '.private/senders/registry.json'), 'utf8')).senders[0].state, 'applied');
  await rm(lock, { recursive: true });
  const run = name => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'bin/sporades.js'), 'monitoring', 'sender', 'issue', '--sender', name, '--dir', dir, '--json'], { env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, 'config') } });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.on('close', code => resolve({ code, output }));
  });
  const results = await Promise.all([run('a'), run('b')]);
  for (const [index, result] of results.entries()) {
    assert([0, 1].includes(result.code));
    if (result.code === 1) { assert.match(result.output, /locked/); good(dir, 'issue', '--sender', index === 0 ? 'a' : 'b'); }
  }
  assert.deepEqual(good(dir, 'status').senders.map(item => item.name).sort(), ['a', 'b', 'laptop']);
});


test('a full protected registry rejects issuance before replacing readable working credentials', async t => {
  const dir = await fixture(t);
  good(dir, 'issue', '--sender', 'working');
  const working = await credentials(dir, 'working', 'working.env');
  const filename = path.join(dir, '.private/senders/registry.json');
  const value = JSON.parse(await readFile(filename, 'utf8'));
  const host = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  // Simulate retained migration history near the public file-size ceiling.
  const baseBytes = Buffer.byteLength(JSON.stringify(value) + '\n');
  const itemBytes = Buffer.byteLength(JSON.stringify(host) + ',');
  value.legacyInventoryDisabled = Array(Math.floor((1024 * 1024 - 400 - baseBytes) / itemBytes)).fill(host);
  const before = JSON.stringify(value) + '\n';
  await writeFile(filename, before);
  const rejected = command(dir, 'issue', '--sender', 'z'.repeat(63), '--host', host);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /registry is full/);
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.equal((await credentials(dir, 'working', 'still-working.env')).ingest, working.ingest);
});
