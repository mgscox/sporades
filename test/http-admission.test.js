import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parseAdmissionPolicy, matchExactAdmissionRule } from '../dist/admission-policy.js';
import { routeHttpAdmission, routeConnectionToken, routeRuntimeHealth } from '../dist/http-runtime.js';
import { createAdmissionRateLimiter } from '../dist/admission-rate-limit.js';

const rule = (id, exact, enabled = true) => ({ id, enabled, conditions: [{ kind: 'pathname', exact }], action: { kind: 'deny' } });
const generation = rules => parseAdmissionPolicy(Buffer.from(JSON.stringify({ version: 1, rules })));
const probeToken = 'a'.repeat(64);
const addressToken = createHash('sha256').update('sporades-client-address\0').update(probeToken).digest('hex');
const hostedHeaders = address => ({ 'x-sporades-client-address': address, 'x-sporades-client-address-token': addressToken });
const addressRule = value => ({ id: 'address', enabled: true, conditions: [{ kind: 'pathname', exact: '/blocked' }, { kind: 'address', value }], action: { kind: 'deny' } });

test('real HTTP quotas preserve under-quota body streams and return opaque 429/HEAD without application work', async () => {
  let now = 0;
  const active = generation([{ ...rule('private-quota', '/limited'), action: { kind: 'rate-limit', limit: 1, windowMs: 2000 } }]);
  const runtime = { current: () => active, rateLimiter: createAdmissionRateLimiter({ now: () => now }) };
  await serve({ securitySession: 'hosted', runtimeProbeToken: probeToken, admissionPolicy: runtime }, async (base, calls) => {
    const first = await fetch(base + '/limited?secret=untouched', { method: 'POST', headers: { ...hostedHeaders('192.0.2.1'), 'x-original': 'retained' }, body: 'original body bytes' });
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { url: '/limited?secret=untouched', header: 'retained', body: 'original body bytes' });
    now = 999;
    for (const method of ['POST', 'HEAD']) {
      const response = await fetch(base + '/limited?secret=opaque', { method, headers: hostedHeaders('::ffff:192.0.2.1'), ...(method === 'POST' ? { body: 'never read' } : {}) });
      assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '2');
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('content-length'), '18');
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'Too Many Requests\n');
    }
    assert.equal(calls(), 1);
    now = 2000;
    assert.equal((await fetch(base + '/limited', { headers: hostedHeaders('192.0.2.1') })).status, 201);
    assert.equal(calls(), 2);
  }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: request.url, header: request.headers['x-original'], body: Buffer.concat(chunks).toString() }));
  });
});

test('Hosted address denial matches exact IPv4, canonical IPv6 and CIDRs at the authenticated Host boundary', async () => {
  for (const [value, matched, unmatched] of [
    ['192.0.2.10', '192.0.2.10', '192.0.2.11'],
    ['192.0.2.0/24', '::ffff:192.0.2.10', '192.0.3.10'],
    ['2001:db8::a', '2001:0DB8:0:0:0:0:0:A', '2001:db8::b'],
    ['2001:db8::/32', '2001:db8:1234::1', '2001:db9::1'],
  ]) {
    await serve({ securitySession: 'hosted', runtimeProbeToken: probeToken, admissionPolicy: { current: () => generation([addressRule(value)]) } }, async (base, calls) => {
      assert.equal((await fetch(base + '/blocked', { headers: hostedHeaders(matched) })).status, 403, value);
      assert.equal((await fetch(base + '/blocked', { headers: hostedHeaders(unmatched) })).status, 201, value);
      assert.equal(calls(), 1);
    });
  }
});

test('missing, forged, invalid and duplicate Hosted identity fails closed without calling Capsule code', async () => {
  await serve({ securitySession: 'hosted', runtimeProbeToken: probeToken, admissionPolicy: { current: () => generation([addressRule('192.0.2.0/24')]) } }, async (base, calls) => {
    for (const headers of [
      {}, { forwarded: 'for=198.51.100.1', 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1' },
      { 'x-sporades-client-address': '198.51.100.1' },
      { ...hostedHeaders('198.51.100.1'), 'x-sporades-client-address-token': probeToken },
      { ...hostedHeaders('198.51.100.1'), 'x-sporades-client-address-token': 'b'.repeat(64) },
      ...['', 'invalid', '999.1.1.1', '192.000.2.1', '198.51.100.1:80', '[2001:db8::1]', 'fe80::1%eth0', '198.51.100.1, 192.0.2.1'].map(hostedHeaders),
      { ...hostedHeaders('198.51.100.1'), 'x-sporades-client-address': ['198.51.100.1', '198.51.100.1'] },
      { ...hostedHeaders('198.51.100.1'), 'x-sporades-client-address-token': [addressToken, addressToken] },
    ]) {
      const response = await rawHeadersResponse(base, '/blocked', headers);
      assert.deepEqual(response, { status: 403, body: 'Forbidden\n', cache: 'no-store' });
    }
    assert.equal(calls(), 0);
    // An unrelated exact path does not require identity.
    assert.equal((await fetch(base + '/unmatched')).status, 201);
  });
});

test('Dev and local Container ignore all identity headers while non-address rules continue to operate', async () => {
  for (const securitySession of ['dev', 'public-dev', 'container']) {
    const active = generation([rule('disabled', '/unmatched', false), addressRule('192.0.2.0/24'), rule('path', '/path')]);
    await serve({ securitySession, runtimeProbeToken: probeToken, admissionPolicy: { current: () => active } }, async base => {
      const headers = { ...hostedHeaders('198.51.100.1'), forwarded: 'for=198.51.100.1', 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1' };
      assert.equal((await fetch(base + '/blocked', { headers })).status, 403);
      assert.equal((await fetch(base + '/path', { headers })).status, 403);
      assert.equal((await fetch(base + '/unmatched', { headers })).status, 201);
    });
  }
});

test('address matching handles family boundaries, mapped CIDRs, prefix endpoints and rejects malformed networks', () => {
  for (const [network, address, match] of [
    ['192.0.2.10/32', '192.0.2.10', true], ['192.0.2.10/32', '192.0.2.11', false],
    ['192.0.2.129/25', '192.0.2.128', true], ['192.0.2.129/25', '192.0.2.127', false],
    ['0.0.0.0/0', '255.255.255.255', true], ['0.0.0.0/0', '2001:db8::1', false],
    ['::/0', '2001:db8::1', true], ['::/0', '::ffff:192.0.2.1', false],
    ['2001:db8::/127', '2001:db8::1', true], ['2001:db8::/127', '2001:db8::2', false],
    ['::1/128', '0:0:0:0:0:0:0:1', true], ['::1/128', '::2', false],
    ['::ffff:192.0.2.0/120', '192.0.2.255', true], ['::ffff:192.0.2.0/120', '192.0.3.1', false],
    ['::ffff:c000:0201', '192.0.2.1', true], ['::ffff:0:0/96', '192.0.2.1', true],
    ['::192.0.2.1', '192.0.2.1', false],
  ]) assert.equal(!!matchExactAdmissionRule(generation([addressRule(network)]), '/blocked', address), match, network + ' ' + address);
  for (const value of ['192.0.2.1/', '192.0.2.1/01', '192.0.2.1/-1', '192.0.2.1/33', '::1/129', '::1/64/1', '::ffff:192.0.2.1/95', '::ffff:192.0.2.1/24', 'fe80::1%eth0', '[::1]', ' 192.0.2.1', '192.0.2.1,192.0.2.2']) {
    assert.throws(() => generation([addressRule(value)]), /^Error: Invalid admission policy\.$/, value);
  }
});

test('Host capability rotation revokes prior identity and disabled address rules require no identity', async () => {
  const database = { securitySession: 'hosted', runtimeProbeToken: probeToken, admissionPolicy: { current: () => generation([addressRule('192.0.2.0/24')]) } };
  await serve(database, async base => {
    assert.equal((await fetch(base + '/blocked',{headers:hostedHeaders('198.51.100.1')})).status,201);
    database.runtimeProbeToken = 'c'.repeat(64);
    assert.equal((await fetch(base + '/blocked',{headers:hostedHeaders('198.51.100.1')})).status,403);
    const token = createHash('sha256').update('sporades-client-address\0').update(database.runtimeProbeToken).digest('hex');
    assert.equal((await fetch(base + '/blocked',{headers:{...hostedHeaders('198.51.100.1'),'x-sporades-client-address-token':token}})).status,201);
    database.admissionPolicy.current = () => generation([{...addressRule('192.0.2.0/24'),enabled:false}]);
    assert.equal((await fetch(base + '/blocked')).status,201);
  });
});

const rawHeadersResponse = (base, path, headers) => new Promise((resolve, reject) => {
  const url = new URL(base);
  const request = httpRequest({ hostname: url.hostname, port: url.port, path, headers }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), cache: response.headers['cache-control'] }));
  });
  request.on('error', reject); request.end();
});
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
