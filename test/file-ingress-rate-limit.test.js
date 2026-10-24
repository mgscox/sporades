import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { capsule, endpoint } from '../dist/server.js';
import { openDevDatabase, routeEndpoint, runEndpoint } from '../dist/server-runtime-source.js';
import { createCapsuleRateLimiter } from '../dist/capsule-rate-limit.js';
import { sweepExpiredFileIngress } from '../dist/file-ingress-runtime.js';

const options = { limit: 2, windowMs: 60_000 };
const signature = resource => createHmac('sha256', 'synthetic-test-signing-secret').update(resource).digest('hex');
const key = resource => `upload:${resource}`;
const limits = { maxFiles: 1, maxFileBytes: 1024, maxTotalFileBytes: 1024, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100, allowedPathPrefixes: ['/attachments'], requestKeyHeader: 'idempotency-key', partKeyHeader: 'content-id', requireStablePartKeys: true, claimAuthorities: ['capsule-principal'] };
function authorized(request) {
  const resource = request.query.resource;
  const supplied = Buffer.from(request.headers['x-upload-signature'] ?? '', 'hex');
  const expected = Buffer.from(signature(resource), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
const decision = resource => ({ allow: true, principal: { namespace: 'resource', key: resource } });
function incoming(resource = 'a', requestKey = 'attempt', valid = true) {
  const request = Object.assign(new EventEmitter(), {
    method: 'POST', url: `/upload?resource=${resource}`, aborted: false, destroyed: false, reads: 0,
    headers: { 'content-type': 'multipart/form-data; boundary=dummy', 'idempotency-key': requestKey, 'x-upload-signature': valid ? signature(resource) : signature('another-resource') },
    async *[Symbol.asyncIterator]() {
      this.reads++;
      yield Buffer.concat([Buffer.from('--dummy\r\nContent-Disposition: form-data; name="file"; filename="dummy.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable\r\n\r\n'), Buffer.alloc(1024, 97), Buffer.from('\r\n--dummy--\r\n')]);
    },
  });
  return request;
}
function response() {
  return { status: null, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = String(body); } };
}
async function storedBytes(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result.push([path.relative(root, file), (await readFile(file)).toString('base64')]);
    }
  }
  await visit(root); return result.sort();
}
async function fixture(run, { admit, handler } = {}) {
  await mkdir(path.join(process.cwd(), '.sporades'), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.sporades', 'ingress-limit-'));
  const config = { name: 'ingress-limit', files: { storagePath: path.join(root, 'files') } };
  const definition = capsule({ name: config.name, files: {
    acl: { read: () => false, delete: () => false },
    ingress: { principalNamespaces: ['resource'], admit: admit ?? ((ctx, request) => {
      if (!authorized(request)) return { allow: false };
      if (!ctx.rateLimit(key(request.query.resource), options).ok) return { allow: false };
      return decision(request.query.resource);
    }) },
  }, endpoints: {
    upload: endpoint({ method: 'POST', path: '/upload', body: { multipart: limits } }, handler ?? (async ctx => await ctx.files.claim(ctx.request.multipart.files[0], { path: '/attachments/dummy.txt', authority: { kind: 'capsule-principal', ...ctx.ingress.principal } }))),
    ordinary: endpoint({ method: 'GET', path: '/ordinary' }, ctx => ctx.rateLimit(key(ctx.request.query.resource), options)),
  } });
  let db = await openDevDatabase(path.join(root, 'data.db'), '', {}, config, definition);
  const upload = request => runEndpoint(db, db.endpoints.find(e => e.options.path === '/upload'), new URL(`http://capsule.test${request.url}`), request);
  const ordinary = resource => runEndpoint(db, db.endpoints.find(e => e.options.path === '/ordinary'), new URL(`http://capsule.test/ordinary?resource=${resource}`), { method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {} });
  const snapshot = async () => ({ bytes: await storedBytes(config.files.storagePath), receipts: await db.adapter.prepare('SELECT * FROM sporades_file_ingress ORDER BY [key]').all(), files: await db.adapter.prepare('SELECT * FROM sporades_files ORDER BY [id]').all() });
  try { await run({ get db() { return db; }, upload, ordinary, snapshot, restart: async () => { await db.close(); db = await openDevDatabase(path.join(root, 'data.db'), '', {}, config, definition); } }); }
  finally { await db.close(); await rm(root, { recursive: true, force: true }); }
}

test('signed-resource admission shares the real handler budget and denies before body or storage work', async () => {
  await fixture(async ({ db, upload, ordinary, snapshot }) => {
    const before = await snapshot();
    const invalid = incoming('a', 'invalid', false); const denied = response();
    await routeEndpoint(db, invalid, denied);
    assert.equal(denied.status, 401); assert.equal(denied.headers['cache-control'], 'no-store'); assert.equal(denied.headers.pragma, 'no-cache');
    assert.deepEqual(JSON.parse(denied.body), { ok: false, data: null, error: { code: 'UNAUTHENTICATED', message: 'Unauthenticated.', hint: 'Provide valid ingress authority and retry.' } });
    assert.equal(invalid.reads, 0); assert.equal(db.capsuleRateLimiter.stats().buckets, 0); assert.deepEqual(await snapshot(), before);
    assert.equal((await ordinary('a')).ok, true);
    const file = await upload(incoming()); assert.ok(file.id);
    assert.equal((await ordinary('a')).ok, false, 'admission spent the same root budget');
    const afterSuccess = await snapshot(); assert.equal(afterSuccess.receipts.length, 1); assert.equal(afterSuccess.files.length, 1);
    const exhausted = incoming('a', 'exhausted'); const result = response();
    await routeEndpoint(db, exhausted, result);
    assert.equal(result.body, denied.body); assert.equal(result.status, denied.status); assert.equal(exhausted.reads, 0);
    assert.deepEqual(await snapshot(), afterSuccess, 'exhaustion creates no staging bytes or receipt');
    assert.equal((await ordinary('b')).ok, true, 'a different resource retains its budget');
  });
});

test('replay spends another admission attempt, handler does not double charge, and restart resets capacity', async () => {
  await fixture(async ({ upload, snapshot, restart }) => {
    const first = await upload(incoming());
    const afterFirst = await snapshot();
    assert.equal((await upload(incoming())).id, first.id, 'the second attempt fits the two-attempt budget');
    const afterReplay = await snapshot();
    assert.deepEqual(afterReplay.bytes, afterFirst.bytes); assert.equal(afterReplay.receipts.length, 1); assert.equal(afterReplay.files.length, 1);
    const third = incoming(); await assert.rejects(upload(third), { code: 'UNAUTHENTICATED' }); assert.equal(third.reads, 0);
    await restart(); assert.equal((await upload(incoming())).id, first.id);
  });
});

test('concurrent admitted retries share a budget and one durable claim', async () => {
  await fixture(async ({ upload, snapshot }) => {
    const files = await Promise.all([upload(incoming()), upload(incoming())]);
    assert.equal(files[0].id, files[1].id);
    const state = await snapshot(); assert.equal(state.receipts.length, 1); assert.equal(state.files.length, 1);
    const exhausted = incoming(); await assert.rejects(upload(exhausted), { code: 'UNAUTHENTICATED' }); assert.equal(exhausted.reads, 0);
  });
});

test('admission validates limiter arguments and preserves fixed windows, expiry and bounded storage', async () => {
  let now = 0;
  await fixture(async ({ db, upload, ordinary }) => {
    db.capsuleRateLimiter = createCapsuleRateLimiter({ now: () => now, maxBuckets: 2 });
    await upload(incoming()); assert.equal((await ordinary('a')).ok, true);
    now = 59_999; assert.deepEqual(await ordinary('a'), { ok: false, retryAfterMs: 1 });
    now = 60_000; await upload(incoming()); assert.equal((await ordinary('a')).ok, true);
    await ordinary('b'); await ordinary('c'); assert.deepEqual(db.capsuleRateLimiter.stats(), { buckets: 2, maxBuckets: 2, evictions: 1 });
    now = 120_000; await upload(incoming()); assert.equal(db.capsuleRateLimiter.stats().buckets, 1);
  }, { admit: (ctx, request) => {
    for (const invalid of ['', null, 'é'.repeat(513)]) assert.throws(() => ctx.rateLimit(invalid, options), { code: 'INVALID_RATE_LIMIT' });
    for (const invalid of [null, [], { limit: 0, windowMs: 1 }, { limit: Number.MAX_SAFE_INTEGER, windowMs: 1 }, { limit: 1.5, windowMs: 1 }, { limit: 1, windowMs: 86_400_001 }, { limit: 1, windowMs: NaN }]) assert.throws(() => ctx.rateLimit('invalid', invalid), { code: 'INVALID_RATE_LIMIT' });
    assert.equal(ctx.rateLimit(key(request.query.resource), options).ok, true);
    return decision(request.query.resource);
  } });
});

for (const outcome of ['allow', 'deny', 'throw']) test(`retained admission limiter expires after callback ${outcome}`, async () => {
  let retained;
  await fixture(async ({ db, upload }) => {
    const attempt = upload(incoming());
    if (outcome === 'allow') await attempt; else await assert.rejects(attempt);
    const before = db.capsuleRateLimiter.stats();
    assert.throws(() => retained('late', options), { code: 'TRUSTED_READ_ACCESS_INACTIVE' });
    assert.deepEqual(db.capsuleRateLimiter.stats(), before);
  }, { admit: ctx => { retained = ctx.rateLimit; if (outcome === 'throw') throw new Error('private policy detail'); return outcome === 'deny' ? { allow: false } : decision('a'); } });
});

for (const spend of [false, true]) test(`disconnect revokes retained admission access without refund (spent=${spend})`, async () => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const pending = new Promise(resolve => { release = resolve; });
  let retained;
  await fixture(async ({ db, ordinary, snapshot }) => {
    const request = incoming(); const result = response(); const before = await snapshot();
    const running = routeEndpoint(db, request, result);
    try {
      await Promise.race([entered, running.then(() => { throw new Error('admission did not enter'); })]);
      request.aborted = true; request.emit('aborted');
      assert.throws(() => retained('after-abort', options), { code: 'TRUSTED_READ_ABORTED' });
    } finally { release(); await running; }
    assert.equal(request.reads, 0); assert.deepEqual(await snapshot(), before);
    assert.equal((await ordinary('a')).ok, true);
    assert.equal((await ordinary('a')).ok, !spend, 'cancellation does not refund a spent attempt');
  }, { admit: async ctx => { retained = ctx.rateLimit; if (spend) assert.equal(retained(key('a'), options).ok, true); enter(); await pending; return decision('a'); } });
});

test('endpoint rollback keeps the admission charge and unclaimed lease until ordinary expiry cleanup', async () => {
  await fixture(async ({ db, upload, ordinary, snapshot }) => {
    await assert.rejects(upload(incoming()), /handler rollback/);
    const staged = await snapshot(); assert.equal(staged.receipts.length, 1); assert.equal(staged.files.length, 0); assert.ok(staged.bytes.length > 0);
    assert.equal((await ordinary('a')).ok, true); assert.equal((await ordinary('a')).ok, false);
    const receipt = JSON.parse(staged.receipts[0].payload);
    await sweepExpiredFileIngress(db, { now: new Date(Date.parse(receipt.expiresAt) + 1).toISOString() });
    const swept = await snapshot(); assert.deepEqual(swept.bytes, []); assert.equal(swept.files.length, 0);
  }, { handler: async ctx => { await ctx.files.claim(ctx.request.multipart.files[0], { path: '/attachments/rollback.txt', authority: { kind: 'capsule-principal', ...ctx.ingress.principal } }); throw new Error('handler rollback'); } });
});

test('Capsule-principal admission source matches its emitted runtime', async () => {
  const [source, emitted] = await Promise.all([
    readFile(new URL('../src/server-runtime-source.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dist/server-runtime-source.js', import.meta.url), 'utf8'),
  ]);
  const admission = text => text.slice(text.indexOf('async function admitCapsuleIngressPrincipal('), text.indexOf('const endpointMultipartAdmissionTimeoutMs'));
  const compiled = ts.transpileModule(admission(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  assert.equal(compiled.trim(), admission(emitted).trim());
});

test('already-aborted Capsule-principal requests never enter admission or consume capacity', async () => {
  let calls = 0;
  await fixture(async ({ db, snapshot }) => {
    const before = await snapshot(); const request = incoming(); request.aborted = true;
    await routeEndpoint(db, request, response());
    assert.equal(calls, 0); assert.equal(request.reads, 0); assert.equal(db.capsuleRateLimiter.stats().buckets, 0);
    assert.deepEqual(await snapshot(), before);
  }, { admit: ctx => { calls++; ctx.rateLimit(key('a'), options); return decision('a'); } });
});

test('limiter alias expires before asynchronous transaction settlement and abort prevents staging', async () => {
  let retained;
  await fixture(async ({ db, snapshot }) => {
    const request = incoming(); const before = await snapshot();
    const withTransaction = db.adapter.withTransaction.bind(db.adapter);
    let admissionSettled = false;
    db.adapter.withTransaction = async (...args) => {
      const result = await withTransaction(...args);
      if (!admissionSettled && retained) {
        admissionSettled = true;
        assert.throws(() => retained('late-settlement', options), { code: 'TRUSTED_READ_ACCESS_INACTIVE' });
        request.aborted = true; request.emit('aborted');
      }
      return result;
    };
    try { await routeEndpoint(db, request, response()); }
    finally { db.adapter.withTransaction = withTransaction; }
    assert.equal(admissionSettled, true); assert.equal(request.reads, 0);
    assert.equal(db.capsuleRateLimiter.stats().buckets, 0); assert.deepEqual(await snapshot(), before);
  }, { admit: ctx => { retained = ctx.rateLimit; return decision('a'); } });
});
