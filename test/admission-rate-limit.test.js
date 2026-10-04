import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAdmissionRateLimiter } from '../dist/admission-rate-limit.js';
import { createBoundedFixedWindow } from '../dist/bounded-fixed-window.js';
import { parseAdmissionPolicy, openAdmissionPolicy } from '../dist/admission-policy.js';
import { routeHttpAdmission } from '../dist/http-runtime.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';
import { resolveAccessKeyCredential, createAccessKeySecret } from '../dist/access-keys-runtime.js';

const quota = (id = 'quota', limit = 2, windowMs = 2000, exact = '/limited') => ({ id, enabled: true, conditions: [{ kind: 'pathname', exact }], action: { kind: 'rate-limit', limit, windowMs } });
const generation = rules => parseAdmissionPolicy(Buffer.from(JSON.stringify({ version: 1, rules })));
const probe = 'a'.repeat(64);
const headers = address => ({ 'x-sporades-client-address': address, 'x-sporades-client-address-token': clientAddressBoundaryToken(probe) });
function fixture(rules, bounds) {
  let now = 0, active = generation(rules);
  const limiter = createAdmissionRateLimiter({ now: () => now, ...bounds });
  const database = { securitySession: 'hosted', runtimeProbeToken: probe, admissionPolicy: { current: () => active, rateLimiter: limiter } };
  function request(address = '192.0.2.1', url = '/limited', supplied = headers(address)) {
    const result = { status: 201, headers: {}, body: 'app bytes', calls: 0 };
    const response = { writeHead: (status, fields) => { result.status = status; result.headers = fields; }, end: body => { result.body = body; } };
    if (!routeHttpAdmission(database, { url, method: 'POST', headers: supplied, rawHeaders: Object.entries(supplied).flat() }, response)) result.calls++;
    return result;
  }
  return { request, limiter, database, time: value => { now = value; }, reload: rules => { active = rules === null ? null : generation(rules); limiter.reconcile(active); } };
}

test('monotonic fixed windows count exact boundaries and round Retry-After up; boundary bursts are allowed', () => {
  const f = fixture([quota()]);
  assert.equal(f.request().status, 201);
  f.time(1999);
  assert.equal(f.request('::ffff:192.0.2.1').status, 201);
  assert.deepEqual(f.request(), { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8', 'content-length': '18', connection: 'close' }, body: 'Too Many Requests\n', calls: 0 });
  f.time(2000);
  assert.equal(f.request().status, 201);
  assert.equal(f.request().status, 201);
  assert.equal(f.request().headers['retry-after'], '2');
  f.time(2999); assert.equal(f.request().headers['retry-after'], '2');
  f.time(3000); assert.equal(f.request().headers['retry-after'], '1');
  f.time(4000); assert.equal(f.request().status, 201);
  // A late quota followed by the next window's quota can burst at the boundary.
  const burst = fixture([quota('burst', 2, 1000)]);
  burst.request(); burst.time(999); assert.equal(burst.request().status, 201);
  burst.time(1000); assert.equal(burst.request().status, 201); assert.equal(burst.request().status, 201);
  // Changing the database's wall clock has no effect on the elapsed-time clock.
  f.database.clock = { now: () => new Date('2100-01-01') };
  assert.equal(f.request().status, 201); assert.equal(f.request().status, 429);
});

test('first-match ordering counts only the deciding quota and isolates stable rule IDs and canonical addresses', () => {
  const f = fixture([{ ...quota('deny'), action: { kind: 'deny' } }, quota('later', 1)]);
  assert.equal(f.request().status, 403); assert.equal(f.limiter.stats().buckets, 0);
  f.reload([quota('later', 1), quota('unreached', 1)]);
  assert.equal(f.request().calls, 1); assert.equal(f.limiter.stats().buckets, 1);
  assert.equal(f.request().status, 429);
  assert.equal(f.request('192.0.2.2').status, 201);
  f.reload([quota('other', 1, 2000, '/other'), quota('later', 1)]);
  assert.equal(f.request('192.0.2.1', '/other').status, 201);
  assert.equal(f.request().status, 429);
});

test('quotas fail closed on missing/untrusted identity without consuming state or accepting forwarding headers', () => {
  const f = fixture([quota('quota', 1)]);
  for (const supplied of [{}, { forwarded: 'for=192.0.2.1', 'x-forwarded-for': '192.0.2.1', 'cf-connecting-ip': '192.0.2.1' },
    { ...headers('192.0.2.1'), 'x-sporades-client-address-token': probe }, headers('192.0.2.1,192.0.2.2'),
    { ...headers('192.0.2.1'), 'x-sporades-client-address': ['192.0.2.1', '192.0.2.1'] }]) {
    const denied = f.request('192.0.2.1', '/limited', supplied);
    assert.equal(denied.status, 403); assert.equal(denied.body, 'Forbidden\n'); assert.equal(denied.headers['cache-control'], 'no-store');
  }
  for (const mode of ['dev', 'public-dev', 'container']) {
    f.database.securitySession = mode; assert.equal(f.request().status, 403);
  }
  assert.equal(f.limiter.stats().buckets, 0);
  assert.equal(f.request('192.0.2.1', '/unrelated', {}).status, 201);
  f.reload([{ ...quota(), enabled: false }]); assert.equal(f.request('192.0.2.1', '/limited', {}).status, 201);
});

test('global bucket bound evicts deterministically under address/rule churn and expires old windows', () => {
  const f = fixture([quota('quota', 1), quota('other', 1, 2000, '/other')], { maxBuckets: 3 });
  f.request('192.0.2.1'); f.request('192.0.2.2'); f.request('192.0.2.3');
  assert.equal(f.request('192.0.2.1').status, 429); // refreshed LRU position
  f.request('192.0.2.4', '/other');
  assert.deepEqual(f.limiter.stats(), { buckets: 3, maxBuckets: 3, evictions: 1 });
  assert.equal(f.request('192.0.2.1').status, 429);
  assert.equal(f.request('192.0.2.2').status, 201); // deterministically evicted
  for (let i = 0; i < 500; i++) f.request(`2001:db8::${(i + 1).toString(16)}`);
  assert.deepEqual(f.limiter.stats(), { buckets: 3, maxBuckets: 3, evictions: 502 });
  f.time(2000); assert.equal(f.request().status, 201);
  assert.deepEqual(f.limiter.stats(), { buckets: 1, maxBuckets: 3, evictions: 502 });
  assert.equal(JSON.stringify(f.limiter.stats()).includes('192.0.2'), false);
});

test('the default runtime cap holds across more than 10000 adversarial canonical identities', () => {
  const f = fixture([quota('quota', 1)]);
  for (let i = 1; i <= 10005; i++) f.request(`2001:db8::${i.toString(16)}`);
  assert.deepEqual(f.limiter.stats(), { buckets: 10000, maxBuckets: 10000, evictions: 5 });
});

test('reload keeps only compatible enabled IDs/parameters and restart resets buckets', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-rate-'));
  const filename = path.join(root, 'policy.json');
  const write = rules => writeFile(filename, JSON.stringify({ version: 1, rules }));
  await write([quota('quota', 1)]);
  let runtime = await openAdmissionPolicy(root, 'policy.json', undefined, { now: () => 0, maxBuckets: 3 });
  const consume = () => runtime.rateLimiter.consume('quota', '192.0.2.1', runtime.current().policy.rules[0].action.limit, runtime.current().policy.rules[0].action.windowMs);
  try {
    assert.equal(consume(), 0); assert.equal(consume(), 2);
    await write([{ ...quota('quota', 1), conditions: [{ kind: 'pathname', exact: '/changed' }] }]); await runtime.reload();
    assert.equal(consume(), 2); // matcher-only edits retain the bucket
    await writeFile(filename, '{'); await runtime.reload();
    assert.equal(runtime.health().state, 'degraded'); assert.equal(consume(), 2);
    for (const changed of [quota('quota', 2), quota('quota', 2, 3000)]) {
      await write([changed]); await runtime.reload(); assert.equal(consume(), 0);
    }
    await write([quota('new-id', 2, 3000)]); await runtime.reload(); assert.equal(runtime.health().rateLimit.buckets, 0);
    await write([quota('quota', 1)]); await runtime.reload(); assert.equal(consume(), 0);
    await write([{ ...quota('quota', 1), enabled: false }]); await runtime.reload();
    await write([quota('quota', 1)]); await runtime.reload(); assert.equal(consume(), 0);
    await write([]); await runtime.reload();
    await write([quota('quota', 1)]); await runtime.reload(); assert.equal(consume(), 0);
    assert.deepEqual(runtime.health().rateLimit, { buckets: 1, maxBuckets: 3, evictions: 0 });
    await runtime.close(); runtime = await openAdmissionPolicy(root, 'policy.json', undefined, { now: () => 0 });
    assert.equal(consume(), 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('shared substrate retains Access-key strict idle expiry, check-without-touch, success clearing and cap', () => {
  let now = 0;
  const limiter = createBoundedFixedWindow({ now: () => now, maxBuckets: 2 });
  limiter.record('source', 60000); limiter.record('selector', 300000);
  assert.equal(limiter.retryAfter('source', 1, 60000), 60);
  now = 60000; assert.equal(limiter.retryAfter('source', 1, 60000), 0);
  limiter.record('third', 60000); assert.equal(limiter.retryAfter('source', 1, 60000), 0);
  assert.equal(limiter.retryAfter('selector', 1, 300000), 240);
  limiter.delete('selector'); assert.equal(limiter.retryAfter('selector', 1, 300000), 0);
  now = 960000; limiter.record('at-idle-boundary', 60000); assert.equal(limiter.stats().buckets, 2);
  now++; limiter.record('past-idle-boundary', 60000); assert.equal(limiter.stats().buckets, 2);
  assert.equal(limiter.stats().evictions, 1); // expiry is distinct from capacity eviction
});

test('Access-key source and selector failure thresholds and exact expiry retain existing behavior', async () => {
  let now = 0, reads = 0;
  const database = { clock: { now: () => new Date(now) }, adapter: { findAccessKeyAuthenticationRecord: async () => { reads++; return null; } } };
  const source = socket => ({ socket: { remoteAddress: socket }, headers: { authorization: 'Bearer malformed' } });
  for (let i = 0; i < 30; i++) await assert.rejects(resolveAccessKeyCredential(database, source('192.0.2.1'), null), e => e.code === 'UNAUTHENTICATED');
  await assert.rejects(resolveAccessKeyCredential(database, source('192.0.2.1'), null), e => e.code === 'RATE_LIMITED');
  now = 59999; await assert.rejects(resolveAccessKeyCredential(database, source('192.0.2.1'), null), e => e.code === 'RATE_LIMITED');
  now = 60000; await assert.rejects(resolveAccessKeyCredential(database, source('192.0.2.1'), null), e => e.code === 'UNAUTHENTICATED');
  const secret = createAccessKeySecret();
  const selector = { socket: { remoteAddress: '192.0.2.2' }, headers: { authorization: `Bearer ${secret.token}` } };
  for (let i = 0; i < 10; i++) await assert.rejects(resolveAccessKeyCredential(database, selector, null), e => e.code === 'UNAUTHENTICATED');
  await assert.rejects(resolveAccessKeyCredential(database, selector, null), e => e.code === 'RATE_LIMITED'); assert.equal(reads, 10);
  now = 360000; await assert.rejects(resolveAccessKeyCredential(database, selector, null), e => e.code === 'UNAUTHENTICATED'); assert.equal(reads, 11);
});
