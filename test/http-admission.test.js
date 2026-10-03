import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { parseAdmissionPolicy, matchHttpAdmissionRule, canonicalAdmissionPathname } from '../dist/admission-policy.js';
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
  assert.equal(matchHttpAdmissionRule(active, { method: 'GET', pathname: '/blocked', query: '', rawHeaders: [] }), active.policy.rules[2]);
  assert.equal(matchHttpAdmissionRule(active, { method: 'GET', pathname: '/unmatched', query: '', rawHeaders: [] }), null);
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
    generation([{ ...rule('future-condition', '/blocked'), conditions: [{ kind: 'address', value: '127.0.0.1' }] }]),
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

const compoundRule = conditions => ({ id: 'compound', enabled: true, conditions, action: { kind: 'deny' } });
const match = (conditions, input = {}) => matchHttpAdmissionRule(generation([compoundRule(conditions)]), {
  method: 'GET', pathname: '/admin', query: '', rawHeaders: [], ...input,
});

test('method, segment prefix, canonical header and query key combine with AND before application code', async () => {
  const conditions = [{ kind: 'method', value: 'POST' }, { kind: 'pathname', prefix: '/admin' },
    { kind: 'header', name: 'x-mode', value: 'blocked' }, { kind: 'query-key', name: 'flag' }];
  await serve({ admissionPolicy: { current: () => generation([compoundRule(conditions)]) } }, async (base, calls) => {
    const send = (path, method = 'POST', value = 'blocked') => fetch(base + path, { method, headers: { 'X-Mode': value } });
    for (const path of ['/admin?flag', '/admin/child?flag=one&flag=two', '/admin/?%66lag=']) {
      const denied = await send(path); assert.equal(denied.status, 403); assert.equal(await denied.text(), 'Forbidden\n');
    }
    assert.equal(calls(), 0);
    for (const response of [await send('/administrator?flag'), await send('/admin?flag', 'GET'),
      await send('/admin?flag', 'POST', 'Blocked'), await send('/admin?FLAG'), await send('/admin')]) {
      assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'max-age=17');
    }
    assert.equal(calls(), 5);
  });
});

test('canonical path has explicit percent/dot semantics, preserves slash boundaries and never double decodes', () => {
  const cases = { '/%61dmin': '/admin', '/a/%2E%2e/admin': '/admin', '/a/./admin': '/a/admin',
    '/a/..': '/', '/a/.': '/a/', '/../../admin': '/admin', '//admin': '//admin', '/a//admin': '/a//admin',
    '/admin/%E2%82%AC': '/admin/€', '/a//../admin': '/a/admin' };
  for (const [raw, expected] of Object.entries(cases)) assert.equal(canonicalAdmissionPathname(raw), expected, raw);
  for (const raw of ['/admin%2fchild', '/admin%5Cchild', '/%252e/admin', '/%FF', '/%c0%af', '/%', '/%00', '/a\\b', '/a b']) {
    assert.throws(() => canonicalAdmissionPathname(raw), undefined, raw);
  }
  for (const pathname of ['/admin', '/admin/', '/admin/child', '/%61dmin/child']) assert.ok(match([{ kind: 'pathname', prefix: '/admin' }], { pathname }));
  for (const pathname of ['/administrator', '/Admin', '//admin']) assert.equal(match([{ kind: 'pathname', prefix: '/admin' }], { pathname }), null);
  assert.equal(match([{ kind: 'pathname', prefix: '/admin/' }], { pathname: '/admin' }), null);
  assert.ok(match([{ kind: 'pathname', prefix: '/admin/' }], { pathname: '/admin/child' }));
  assert.equal(match([{ kind: 'pathname', exact: '/admin' }], { pathname: '/admin/' }), null);
});

test('method casing, extension methods, OPTIONS asterisk and malformed inputs are deterministic', () => {
  assert.ok(match([{ kind: 'method', value: 'GET' }], { method: 'gEt' }));
  assert.equal(match([{ kind: 'method', value: 'GET' }], { method: 'M-SEARCH' }), null);
  assert.ok(match([{ kind: 'method', value: 'OPTIONS' }], { method: 'OPTIONS', pathname: '*' }));
  for (const method of ['', ' GET', 'GÉT', 'GET\n']) assert.throws(() => match([{ kind: 'method', value: 'GET' }], { method }));
});

test('raw header names are case-insensitive, values trim only OWS, presence includes empty/duplicate values', async () => {
  const presence = [{ kind: 'header', name: 'x-test' }], exact = [{ kind: 'header', name: 'x-test', value: 'Value' }];
  assert.ok(match(exact, { rawHeaders: ['X-TEST', ' \tValue\t '] }));
  assert.equal(match(exact, { rawHeaders: ['X-Test', 'value'] }), null);
  assert.equal(match(exact, { rawHeaders: ['X-Test', 'Value  inside'] }), null);
  assert.ok(match([{ kind: 'header', name: 'x-test', value: '' }], { rawHeaders: ['x-test', ' \t'] }));
  assert.equal(match(presence), null);
  assert.ok(match(presence, { rawHeaders: ['X-Test', '', 'x-test', 'second'] }));
  for (const rawHeaders of [['X-Test', 'Value', 'x-test', 'other'], ['X-Test', 'Value', 'x-test', 'Value']]) {
    assert.throws(() => match(exact, { rawHeaders }), /Indeterminate/);
    for (const conditions of [[...exact, { kind: 'method', value: 'POST' }], [{ kind: 'method', value: 'POST' }, ...exact]]) {
      assert.equal(match(conditions, { rawHeaders }), null);
    }
  }
  // Real Node requests may join duplicate custom fields or discard singleton duplicates in headers.
  await serve({ admissionPolicy: { current: () => generation([compoundRule(exact)]) } }, async (base, calls) => {
    const url = new URL(base);
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: url.hostname, port: url.port, path: '/admin', headers: ['Host', url.host, 'X-Test', 'Value', 'x-test', 'other'] }, resolve);
      request.on('error', reject); request.end();
    });
    assert.equal(response.statusCode, 403); response.resume(); assert.equal(calls(), 0);
  });
});

test('query keys decode once, plus is space, repeated keys are presence, and malformed values also fail closed', () => {
  const conditions = [{ kind: 'query-key', name: 'some key' }, { kind: 'query-key', name: 'é' }];
  assert.ok(match(conditions, { query: 'some+key=one&%C3%A9&some%20key=two' }));
  assert.equal(match(conditions, { query: 'Some+key&%C3%A9' }), null);
  assert.equal(match([{ kind: 'query-key', name: 'key' }], { query: '%256bey' }), null);
  assert.ok(match([{ kind: 'query-key', name: '%6bey' }], { query: '%256bey' }));
  assert.equal(match([{ kind: 'query-key', name: 'key' }], { query: 'other=key' }), null);
  assert.ok(match([{ kind: 'query-key', name: 'a&b' }], { query: 'a%26b=value' }));
  for (const query of ['key=%', '%GG', 'key=%FF', 'key=%00', 'key=%ED%A0%80']) assert.throws(() => match([{ kind: 'query-key', name: 'key' }], { query }));
});

test('malformed request targets have opaque denial even for nonmatching rules', async () => {
  await serve({ admissionPolicy: { current: () => generation([rule('unrelated', '/unrelated')]) } }, async (base, calls) => {
    for (const path of ['/admin#fragment', '/admin?key=%', '/admin?key=%FF', 'ftp://example.test/admin', 'http://user:pass@example.test/admin', 'http:///example.test/admin', 'http:////example.test/admin']) {
      const response = await rawResponse(base, path); assert.equal(response.status, 403, path); assert.equal(response.body, 'Forbidden\n');
    }
    assert.equal(calls(), 0);
  });
});

test('first match stops before later indeterminate rules; unsupported conditions are order-independent', () => {
  const first = compoundRule([{ kind: 'method', value: 'GET' }]);
  const later = { ...compoundRule([{ kind: 'address', value: '127.0.0.1' }]), id: 'later' };
  const input = { method: 'GET', pathname: '/admin', query: '', rawHeaders: [] };
  const active = generation([first, later]); assert.equal(matchHttpAdmissionRule(active, input), active.policy.rules[0]);
  for (const conditions of [[{ kind: 'address', value: '127.0.0.1' }, { kind: 'method', value: 'POST' }],
    [{ kind: 'method', value: 'POST' }, { kind: 'address', value: '127.0.0.1' }]]) assert.equal(match(conditions), null);
});
