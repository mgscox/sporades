import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { parseAdmissionPolicy, matchExactAdmissionRule } from '../dist/admission-policy.js';
import { routeHttpAdmission, routeConnectionToken, routeRuntimeHealth } from '../dist/http-runtime.js';

const rule = (id, exact, enabled = true) => ({ id, enabled, conditions: [{ kind: 'pathname', exact }], action: { kind: 'deny' } });
const generation = rules => parseAdmissionPolicy(Buffer.from(JSON.stringify({ version: 1, rules })));
async function serve(database, fn, application) {
  let calls = 0;
  const server = createServer((request, response) => {
    if (routeHttpAdmission(database, request, response)) return;
    calls++;
    if (application) { application(request, response); return; }
    response.writeHead(201, { 'content-type': 'text/plain', 'cache-control': 'max-age=17' });
    response.end(request.url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, () => calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('exact-path denial returns constant opaque bytes before invoking application code', async () => {
  const active = generation([rule('private-rule-name', '/blocked')]);
  await serve({ admissionPolicy: { current: () => active }, log: { emit: () => assert.fail('denial must not log policy details') } }, async (base, calls) => {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${base}/blocked?credential=never-disclose`, {
        method, headers: { 'x-test-secret': 'never-disclose' }, ...(method === 'POST' ? { body: 'private body' } : {}),
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('content-length'), '10');
      assert.equal(await response.text(), 'Forbidden\n');
      assert.equal(calls(), 0);
    }
  });
});

test('nonmatching requests retain response bytes, status and headers; disabled rules and AND conditions are skipped', async () => {
  const contradictory = { ...rule('contradictory', '/allowed'), conditions: [{ kind: 'pathname', exact: '/allowed' }, { kind: 'pathname', exact: '/different' }] };
  const active = generation([rule('disabled', '/allowed', false), contradictory, rule('enabled', '/blocked')]);
  await serve({ admissionPolicy: { current: () => active } }, async (base, calls) => {
    const response = await fetch(`${base}/allowed?key=one&key=two`, { method: 'POST', body: 'unchanged bytes' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'max-age=17');
    assert.equal(await response.text(), '/allowed?key=one&key=two');
    assert.equal(calls(), 1);
  });
});

test('pass-through preserves the original method, query, headers and body stream', async () => {
  const expected = { method: 'POST', url: '/allowed?x=one&x=two', header: 'original', body: 'untouched body bytes' };
  await serve({ admissionPolicy: { current: () => generation([rule('deny', '/blocked')]) } }, async base => {
    const response = await fetch(base + expected.url, { method: expected.method, headers: { 'x-fixture': expected.header }, body: expected.body });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), expected);
  }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ method: request.method, url: request.url, header: request.headers['x-fixture'], body: Buffer.concat(chunks).toString() }));
  });
});

const rawResponse = (base, path) => new Promise((resolve, reject) => {
  const url = new URL(base);
  const request = httpRequest({ hostname: url.hostname, port: url.port, path }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  request.on('error', reject); request.end();
});

test('the first matching enabled immutable rule decides; later rules cannot override it', () => {
  const active = generation([rule('disabled', '/blocked', false), rule('elsewhere', '/elsewhere'), rule('first', '/blocked'), rule('second', '/blocked')]);
  assert.equal(matchExactAdmissionRule(active, '/blocked'), active.policy.rules[2]);
  assert.equal(matchExactAdmissionRule(active, '/unmatched'), null);
});

test('canonical path matching ignores queries, decodes once and normalizes dot segments without rewriting requests', async () => {
  await serve({ admissionPolicy: { current: () => generation([rule('canonical', '/blocked')]) } }, async (base, calls) => {
    for (const path of ['/blocked?x=1', '/%62locked', '/parent/../blocked', '/parent/%2e%2e/blocked', 'http://untrusted.example/blocked?x=1']) {
      const response = await rawResponse(base, path);
      assert.equal(response.status, 403, path);
      assert.equal(response.body, 'Forbidden\n');
    }
    for (const path of ['/Blocked', '/blocked/', '/blocked-extra', '//blocked', '/blocked%3Fnot-a-query']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 201, path);
      assert.equal(await response.text(), path);
    }
    assert.equal(calls(), 5);
  });
});

test('malformed, ambiguous and unsupported enabled admission inputs fail closed with identical opaque bytes', async () => {
  for (const active of [
    generation([{ ...rule('future-condition', '/blocked'), conditions: [{ kind: 'method', value: 'GET' }] }]),
    generation([{ ...rule('future-action', '/blocked'), action: { kind: 'rate-limit', limit: 3, windowMs: 1000 } }]),
    generation([rule('ordinary', '/blocked')]),
  ]) {
    await serve({ admissionPolicy: { current: () => active } }, async (base, calls) => {
      for (const path of ['/blocked', '/%FF', '/%2fblocked', '/%252fblocked']) {
        const response = await fetch(base + path);
        assert.equal(response.status, 403);
        assert.equal(await response.text(), 'Forbidden\n');
      }
      assert.equal(calls(), 0);
    });
  }
});

test('one generation snapshot per request takes effect immediately after replacement and authorized removal', async () => {
  let active = generation([rule('original', '/blocked')]);
  let reads = 0;
  await serve({ admissionPolicy: { current: () => { reads++; return active; } } }, async (base, calls) => {
    assert.equal((await fetch(base + '/blocked')).status, 403);
    active = generation([rule('replaced', '/different')]);
    assert.equal((await fetch(base + '/blocked')).status, 201);
    assert.equal((await fetch(base + '/different')).status, 403);
    active = null;
    assert.equal((await fetch(base + '/different')).status, 201);
    assert.equal(reads, 4);
    assert.equal(calls(), 2);
  });
});

test('reserved control targets are rejected during generation validation even in disabled or compound rules', () => {
  for (const exact of ['/__sporades/health/runtime', '/__sporades/connection-token']) {
    for (const enabled of [true, false]) {
      const target = rule('reserved', exact, enabled);
      target.conditions.push({ kind: 'method', value: 'GET' });
      assert.throws(() => generation([target]), /^Error: Invalid admission policy\.$/);
    }
  }
  for (const prefix of ['/', '/__sporades', '/__sporades/health', '/__sporades/connection-token']) {
    assert.throws(() => generation([{ ...rule('reserved-prefix', '/ignored'), conditions: [{ kind: 'pathname', prefix }] }]), /Invalid admission policy/);
  }
});

test('genuine health and connection-token controls authenticate and complete without consulting admission', async () => {
  let evaluations = 0;
  const database = { adapter: { checkHealth: async () => ({ ok: true }) }, fileStorage: { checkHealth: async () => ({ ok: true }) }, runtimeProbeToken: 'a'.repeat(64), admissionPolicy: { current: () => { evaluations++; throw Error('must not enter admission'); }, health: () => ({ state: 'healthy', digest: 'b'.repeat(64) }) } };
  const server = createServer(async (request, response) => {
    if (routeConnectionToken(request, response, () => 'fresh-token')) return;
    if (await routeRuntimeHealth(database, request, response)) return;
    if (routeHttpAdmission(database, request, response)) return;
    response.end('application');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = await fetch(base + '/__sporades/connection-token', { headers: { 'x-sporades-connection-token-request': '1' } });
    assert.equal(token.status, 200);
    assert.deepEqual(await token.json(), { token: 'fresh-token' });
    assert.equal((await fetch(base + '/__sporades/connection-token')).status, 403);
    assert.equal((await fetch(base + '/__sporades/health/runtime')).status, 404);
    assert.equal((await fetch(base + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': 'a'.repeat(64) } })).status, 200);
    assert.equal(evaluations, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('absent, empty and removed policies touch no request, response or log surface and stay within a 1us gate budget', t => {
  const untouched = new Proxy({}, { get() { assert.fail('no-policy gate touched the request/response'); } });
  for (const database of [{}, { admissionPolicy: { current: () => null } }, { admissionPolicy: { current: () => generation([]) } }]) {
    assert.equal(routeHttpAdmission(database, untouched, untouched), false);
  }
  const database = {};
  const iterations = 200000;
  for (let i = 0; i < iterations; i++) routeHttpAdmission(database, untouched, untouched);
  const samples = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) assert.equal(routeHttpAdmission(database, untouched, untouched), false);
    samples.push((performance.now() - start) * 1000 / iterations);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(`no-policy gate median=${samples[3].toFixed(4)}us budget=1us (7 x ${iterations} calls; loop/assertion included)`);
  assert.ok(samples[3] < 1, `no-policy gate exceeded 1us: ${samples[3]}`);
});
