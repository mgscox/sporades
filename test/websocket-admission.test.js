import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

const deny = conditions => ({ id: 'private-rule', enabled: true, conditions, action: { kind: 'deny' } });
const wsPath = { kind: 'pathname', exact: '/__sporades/ws' };

async function fixture(rules, run, epilogue = '') {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ws-admission-'));
  let child, output = '', errors = '';
  try {
    const serverSource = `import { capsule, query } from 'sporades/server';
export default capsule({ name: 'ws-admission', schema: {}, queries: { ping: query(() => 'Capsule reply') } });`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({
      config: { name: 'ws-admission', admissionPolicy: { path: 'policy.json' } }, serverEnv: {}, serverSource, serverModuleSource,
      epilogue: epilogue + `\nprocess.on('message', async command => { if (command === 'rotate') database.runtimeProbeToken = 'b'.repeat(64); await admissionPolicyRuntime.reload(); process.send({ health: admissionPolicyRuntime.health() }); });
process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    }));
    await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, rules }));
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
      ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', SPORADES_CONFIG_DIR: path.join(root, 'config'),
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    let port;
    const deadline = Date.now() + 10000;
    while (!port && Date.now() < deadline) {
      port = output.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      assert.equal(child.exitCode, null, output + errors);
      if (!port) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(port, output + errors);
    const base = `http://127.0.0.1:${port}`;
    const token = (await (await fetch(base + '/__sporades/connection-token', { headers: { 'x-sporades-connection-token-request': '1' } })).json()).token;
    const reload = async value => {
      await writeFile(path.join(root, 'next.json'), typeof value === 'string' ? value : JSON.stringify({ version: 1, rules: value }));
      await rename(path.join(root, 'next.json'), path.join(root, 'policy.json'));
      const reply = once(child, 'message'); child.send('reload');
      return (await reply)[0].health;
    };
    const rotate = async () => { const reply = once(child, 'message'); child.send('rotate'); await reply; };
    await run({ base, token, root, reload, rotate, output: () => output + errors });
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}

function upgrade(base, target, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: target, method, headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers,
    } });
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode }); });
    request.on('response', response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve({ status: null }) : reject(error));
    request.setTimeout(5000, () => request.destroy(new Error('upgrade timeout'))); request.end();
  });
}

test('generated Bundle denies Capsule transport before switching protocols with the ordinary opaque HTTP result', { timeout: 20000 }, async () => {
  await fixture([deny([wsPath])], async ({ base, token, output }) => {
    const target = '/__sporades/ws?connectionToken=' + token;
    const ordinary = await fetch(base + target);
    const denied = await upgrade(base, target);
    assert.equal(denied.status, 403);
    assert.equal(denied.body, 'Forbidden\n');
    for (const name of ['cache-control', 'content-type', 'content-length', 'connection', 'x-content-type-options']) {
      assert.equal(denied.headers[name], ordinary.headers.get(name), name);
    }
    assert.equal(await ordinary.text(), denied.body);
    assert.equal(output().includes('private-rule'), false);
    assert.equal(output().includes(token), false);
  });
});

test('HTTP and upgrade admission share actual method, canonical path, raw headers and query-key semantics', { timeout: 20000 }, async () => {
  await fixture([deny([{ kind: 'method', value: 'GET' }, { kind: 'pathname', prefix: '/__sporades/ws' },
    { kind: 'header', name: 'x-mode', value: 'review' }, { kind: 'query-key', name: 'confirm' }])], async ({ base, token }) => {
    for (const [target, headers, method, denied] of [
      ['/__sporades/ws?%63onfirm=1&confirm=2', { 'X-Mode': ' review ' }, 'GET', true],
      ['/__sporades/%77s?confirm', { 'x-mode': 'review' }, 'GET', true],
      ['/__sporades/x/../ws?confirm', { 'x-mode': 'review' }, 'GET', true],
      ['/__sporades/ws?confirm', { 'x-mode': ['review', 'review'] }, 'GET', true],
      ['/__sporades/ws?confirm', { 'x-mode': 'review' }, 'POST', false],
      ['/__sporades/ws?confirm', { 'x-mode': 'other' }, 'GET', false],
      ['/__sporades/ws?other', { 'x-mode': 'review' }, 'GET', false],
      ['/__sporades/wsibling?confirm', { 'x-mode': 'review' }, 'GET', false],
      ['/__sporades/%zz?confirm', { 'x-mode': 'review' }, 'GET', true],
      ['/__sporades/%ff?confirm', { 'x-mode': 'review' }, 'GET', true],
      ['/__sporades/ws?confirm=%zz', { 'x-mode': 'other' }, 'GET', true],
      ['/__sporades/ws#fragment?confirm', { 'x-mode': 'other' }, 'GET', true],
    ]) {
      const url = target + (target.includes('?') ? '&' : '?') + 'connectionToken=' + token;
      const ordinary = await ordinaryRequest(base, url, headers, method);
      const switched = await upgrade(base, url, headers, method);
      assert.equal(ordinary.status === 403, denied, url);
      assert.equal(switched.status === 403, denied, url);
      if (denied) assert.equal(switched.body, ordinary.body);
      else assert.equal(switched.status, target.startsWith('/__sporades/ws?') ? 101 : null);
    }
  });
});

function ordinaryRequest(base, target, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: target, headers, method }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end();
  });
}

const probe = 'a'.repeat(64);
const identity = address => ({ 'x-sporades-client-address': address, 'x-sporades-client-address-token': clientAddressBoundaryToken(probe) });
const fakeHosted = `database.securitySession = 'hosted'; database.runtimeProbeToken = '${probe}';`;

test('Hosted upgrades require canonical Host-authenticated identity and resist forged, duplicate and revoked addresses', { timeout: 20000 }, async () => {
  await fixture([deny([wsPath, { kind: 'address', value: '192.0.2.0/24' }])], async ({ base, token, rotate }) => {
    const target = '/__sporades/ws?connectionToken=' + token;
    for (const [headers, expected] of [
      [identity('192.0.2.1'), 403], [identity('::ffff:192.0.2.1'), 403], [identity('198.51.100.1'), 101],
      [{}, 403], [{ forwarded: 'for=198.51.100.1', 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1' }, 403],
      [{ 'x-sporades-client-address': '198.51.100.1' }, 403],
      [{ ...identity('198.51.100.1'), 'x-sporades-client-address-token': probe }, 403],
      [{ ...identity('198.51.100.1'), 'x-sporades-client-address-token': ['bad', clientAddressBoundaryToken(probe)] }, 403],
      [{ ...identity('198.51.100.1'), 'x-sporades-client-address': ['198.51.100.1', '198.51.100.1'] }, 403],
      [identity('198.51.100.1:80'), 403],
    ]) {
      assert.equal((await ordinaryRequest(base, target, headers)).status === 403, expected === 403);
      const result = await upgrade(base, target, headers);
      assert.equal(result.status, expected);
      if (expected === 403) assert.equal(result.body, 'Forbidden\n');
    }
    await rotate();
    assert.equal((await upgrade(base, target, identity('198.51.100.1'))).status, 403);
    assert.equal((await upgrade(base, target, { ...identity('198.51.100.1'), 'x-sporades-client-address-token': clientAddressBoundaryToken('b'.repeat(64)) })).status, 101);
  }, fakeHosted);
  // Dev and local Container ignore even a valid internal capability.
  for (const session of ['dev', 'container']) await fixture([deny([wsPath, { kind: 'address', value: '192.0.2.0/24' }])], async ({ base, token }) => {
    assert.equal((await upgrade(base, '/__sporades/ws?connectionToken=' + token, identity('198.51.100.1'))).status, 403);
  }, fakeHosted + `database.securitySession = '${session}';`);
});

test('nonmatching upgrades preserve the application transport and hot generations atomically revoke admission', { timeout: 20000 }, async () => {
  await fixture([deny([{ kind: 'pathname', exact: '/other' }])], async ({ base, token, reload }) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/__sporades/ws?connectionToken=' + token);
    try {
      await once(socket, 'open');
      const reply = once(socket, 'message');
      socket.send(JSON.stringify({ id: 'ping', type: 'query.subscribe', query: 'ping', args: [] }));
      const message = JSON.parse((await reply)[0].data);
      assert.equal(message.id, 'ping'); assert.equal(message.error, null); assert.equal(message.data, 'Capsule reply');
    } finally { socket.close(); await once(socket, 'close'); }
    const target = '/__sporades/ws?connectionToken=' + token;
    const oldHealth = await reload([deny([wsPath])]);
    assert.equal((await upgrade(base, target)).status, 403);
    const badHealth = await reload('{');
    assert.equal(badHealth.state, 'degraded'); assert.equal(badHealth.digest, oldHealth.digest);
    assert.equal((await upgrade(base, target)).status, 403);
    await reload([deny([{ kind: 'pathname', exact: '/other' }])]);
    assert.equal((await upgrade(base, target)).status, 101);
    await reload([]);
    assert.equal((await upgrade(base, target)).status, 101);
  });
});

test('reserved GET controls never read generations or consume quotas, while HTTP and upgrades share Capsule buckets', { timeout: 20000 }, async () => {
  await fixture([{ id: 'quota', enabled: true, conditions: [{ kind: 'method', value: 'GET' }], action: { kind: 'rate-limit', limit: 1, windowMs: 60000 } }], async ({ base, token, output }) => {
    const headers = { ...identity('192.0.2.1'), 'x-sporades-host-probe': probe };
    for (const target of ['/__sporades/health/runtime', '/__sporades/connection-token']) {
      assert.equal((await upgrade(base, target, headers)).status, null);
    }
    const health = await (await fetch(base + '/__sporades/health/runtime', { headers })).json();
    assert.equal(health.data.runtime.admissionPolicy.rateLimit.buckets, 0);
    assert.equal(output().includes('generation-read'), false);
    const target = '/__sporades/ws?connectionToken=' + token;
    assert.equal((await upgrade(base, target, headers)).status, 101);
    const limited = await ordinaryRequest(base, target, headers);
    assert.equal(limited.status, 429); assert.equal(limited.body, 'Too Many Requests\n');
    const upgradeLimited = await upgrade(base, target, headers);
    assert.equal(upgradeLimited.status, 429); assert.equal(upgradeLimited.body, limited.body);
  }, fakeHosted + `database.admissionPolicy = { ...admissionPolicyRuntime, current: () => { console.log('generation-read'); return admissionPolicyRuntime.current(); } };`);
});

test('concurrent HTTP and upgrade requests each snapshot one complete validated generation', { timeout: 20000 }, async () => {
  const alternate = JSON.stringify({ version: 1, rules: [deny([{ kind: 'pathname', exact: '/other' }, { kind: 'header', name: 'x-mode', value: 'blue' }])] });
  await fixture([deny([wsPath, { kind: 'header', name: 'x-mode', value: 'red' }])], async ({ base, token, output }) => {
    const target = '/__sporades/ws?connectionToken=' + token;
    const headers = { 'x-mode': 'blue' };
    const results = await Promise.all(Array.from({ length: 24 }, async () => {
      const [ordinary, switched] = await Promise.all([ordinaryRequest(base, target, headers), upgrade(base, target, headers)]);
      assert.equal(ordinary.status, 404); assert.equal(switched.status, 101);
    }));
    assert.equal(results.length, 24);
    for (let i = 0; i < 100 && (output().match(/generation-read/g) ?? []).length < 48; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((output().match(/generation-read/g) ?? []).length, 48);
  }, `const a = admissionPolicyRuntime.current();
await (await import('node:fs/promises')).writeFile('alternate.json', ${JSON.stringify(alternate)});
const alternateRuntime = await openAdmissionPolicy(process.cwd(), 'alternate.json');
const b = alternateRuntime.current();
let reads = 0;
database.admissionPolicy = { ...admissionPolicyRuntime, current: () => { console.log('generation-read'); return ++reads % 2 ? a : b; } };`);
});
