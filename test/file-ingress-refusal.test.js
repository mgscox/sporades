import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capsule, endpoint, endpointError, job, table, String as Text } from '../dist/server.js';
import { openDevDatabase, runEndpoint, createControllableRuntimeClock } from '../dist/server-runtime-source.js';
import { snapshotIngressDecision, ingressRefusalJob } from '../dist/file-ingress-refusal.js';
import { endpointErrorResponseHeaders } from '../dist/endpoint-error.js';
import { withFakeLibsqlService } from './support/libsql-http-service.js';
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from './support/database-adapter-engines.js';

const policy = { maxFiles: 1, maxFileBytes: 64, maxTotalFileBytes: 64, maxFieldCount: 1, maxFieldBytes: 64, maxTotalFieldBytes: 64, allowedPathPrefixes: ['/attachments'], requestKeyHeader: 'idempotency-key', partKeyHeader: 'content-id', claimAuthorities: ['capsule-principal'] };
const refusal = () => ({ allow: false, refusalJob: { name: 'record', payload: { applicationId: 'trusted-id' }, idempotencyKey: 'trusted-id:policy-v1' } });
function definition(admit, observed = []) {
  return capsule({ name: 'refusal-boundaries', schema: { observations: table({ value: Text() }) },
    files: { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ['application'], admit } },
    jobs: { record: job((ctx, payload) => { observed.push({ actor: ctx.auth.userId, payload }); return null; }) },
    endpoints: { upload: endpoint({ method: 'POST', path: '/upload', body: { multipart: policy } }, () => { assert.fail('No handler authority on denial'); }) },
  });
}
const request = signal => ({ method: 'POST', url: '/upload', signal, headers: { 'content-type': 'multipart/form-data; boundary=invalid', 'idempotency-key': 'untrusted-request' }, async *[Symbol.asyncIterator]() { assert.fail('No body reads on denial'); } });
async function denied(db, signal, code = 'UNAUTHENTICATED') {
  await assert.rejects(runEndpoint(db, db.endpoints[0], new URL('http://localhost/upload'), request(signal)), error => error.code === code);
}
async function fixture(fn, admit = refusal) {
  const dir = await mkdtemp(path.join(tmpdir(), 'refusal-'));
  const db = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: 'refusal-boundaries' }, definition(admit));
  try { await fn(db); } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
}
const rows = async db => await db.adapter.prepare(db.adapter.dialect.sql('SELECT * FROM [sporades_jobs]')).all();

test('endpoint error headers reject accessors, duplicates, injections, unsupported names and oversized values', () => {
  for (const headers of [null, [], { 'Set-Cookie': 'secret' }, { 'cache-control': 'no-store\nX: yes' }, { Pragma: 1 }, { Pragma: '' }, { Pragma: 'x'.repeat(8193) }, { pragma: 'one', Pragma: 'two' }, { get Pragma() { assert.fail('getter'); } }]) {
    assert.throws(() => endpointError(headers), /Invalid endpoint error headers/);
  }
  const headers = { 'Cache-Control': 'no-store' };
  const error = endpointError(headers);
  headers['Cache-Control'] = 'public';
  assert.deepEqual(endpointErrorResponseHeaders(error), { 'cache-control': 'no-store' });
  assert.deepEqual(endpointErrorResponseHeaders({ [Symbol.for('sporades.endpoint.errorHeaders')]: { 'Set-Cookie': 'secret' } }), {});
});

test('refusal evidence has strict JSON, payload and UTF-8 key bounds without invoking getters/toJSON', () => {
  let invoked = 0;
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, { get allow() { invoked++; return false; } }, { toJSON() { invoked++; return {}; } }, { allow: false, refusalJob: { ...refusal().refusalJob, payload: 'x'.repeat(4097) } },
    ...['', 'x'.repeat(257), 'é'.repeat(129), 'a\r\nb'].map(idempotencyKey => ({ allow: false, refusalJob: { ...refusal().refusalJob, idempotencyKey } })),
    { ...refusal(), extra: true }, { allow: false, refusalJob: { ...refusal().refusalJob, name: '__sporades_internal' } },
  ]) assert.throws(() => ingressRefusalJob(snapshotIngressDecision(value)));
  assert.equal(invoked, 0);
  assert.equal(snapshotIngressDecision({ allow: true, principal: { namespace: 'application', key: 'key' }, allowFiles: undefined }).allowFiles, undefined);
  assert.equal(ingressRefusalJob(snapshotIngressDecision({ allow: false, refusalJob: undefined })), null);
  assert.ok(ingressRefusalJob(snapshotIngressDecision({ allow: false, refusalJob: { name: 'record', payload: 'x'.repeat(4094), idempotencyKey: 'é'.repeat(128) } })));
});

test('admission reads expire before refusal writes; policy output cannot be changed after returning', async () => {
  let retained, decision;
  await fixture(async db => {
    await denied(db);
    assert.throws(() => retained.observations.all(), error => error.code === 'TRUSTED_READ_ACCESS_INACTIVE');
    decision.refusalJob.payload.applicationId = 'changed';
    const queued = await rows(db);
    assert.equal(queued.length, 1);
    assert.deepEqual(JSON.parse(queued[0].payload), { applicationId: 'trusted-id' });
    assert.equal((await db.adapter.prepare('SELECT COUNT(*) AS n FROM sporades_file_ingress').get()).n, 0);
  }, ctx => { retained = ctx.db; assert.equal(ctx.db.observations.insert, undefined); decision = refusal(); return decision; });
});

test('malformed and unknown refusal Jobs fail closed without body reads or queue writes', async () => {
  for (const decision of [{ allow: false }, { allow: false, refusalJob: null }, { allow: true, refusalJob: refusal().refusalJob }, { allow: false, refusalJob: { ...refusal().refusalJob, payload: 'x'.repeat(4097) } }, { allow: false, refusalJob: { ...refusal().refusalJob, name: 'missing' } }]) {
    await fixture(async db => { await denied(db, undefined, decision.refusalJob?.name === 'missing' ? 'FILE_INGRESS_REFUSAL_FAILED' : 'UNAUTHENTICATED'); assert.equal((await rows(db)).length, 0); }, () => decision);
  }
});

test('enqueue storage failure remains opaque and rolls back privileged audit and queue writes', async () => {
  await fixture(async db => {
    const transaction = db.adapter.withTransaction.bind(db.adapter);
    db.adapter.withTransaction = (fn, options) => transaction(async scoped => {
      const prepare = scoped.prepare.bind(scoped);
      scoped.prepare = sql => {
        if (sql.includes('INSERT INTO') && sql.includes('sporades_jobs')) throw new Error('private storage secret');
        return prepare(sql);
      };
      return fn(scoped);
    }, options);
    await assert.rejects(runEndpoint(db, db.endpoints[0], new URL('http://localhost/upload'), request()), error => {
      assert.equal(error.code, 'FILE_INGRESS_REFUSAL_FAILED');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /private storage/);
      return true;
    });
    assert.equal((await rows(db)).length, 0);
    assert.equal((await db.adapter.prepare("SELECT COUNT(*) AS n FROM sporades_log_events WHERE event LIKE 'privileged.%'").get()).n, 0);
  });
});

test('aborts before admission, during a noncooperative policy, and immediately before refusal commit deny without recording', { timeout: 20000 }, async () => {
  const before = new AbortController(); before.abort();
  await fixture(async db => { await denied(db, before.signal); assert.equal((await rows(db)).length, 0); });
  const during = new AbortController();
  let retained;
  await fixture(async db => {
    const pending = denied(db, during.signal);
    while (!retained) await new Promise(resolve => setImmediate(resolve));
    during.abort(); await pending;
    assert.throws(() => retained.observations.all());
    assert.equal((await rows(db)).length, 0);
  }, ctx => { retained = ctx.db; return new Promise(() => {}); });
  await fixture(async db => {
    const atCommit = new AbortController();
    const transaction = db.adapter.withTransaction.bind(db.adapter);
    db.adapter.withTransaction = (fn, options) => transaction(async scoped => {
      let refusalWrite = false;
      const prepare = scoped.prepare.bind(scoped);
      scoped.prepare = sql => {
        if (sql.includes('INSERT INTO') && sql.includes('sporades_jobs')) refusalWrite = true;
        return prepare(sql);
      };
      const result = await fn(scoped);
      if (refusalWrite) atCommit.abort();
      return result;
    }, options);
    await denied(db, atCommit.signal, 'FILE_INGRESS_REFUSAL_FAILED');
    assert.equal((await rows(db)).length, 0);
  });
});

test('an abort after refusal commit retains queue-owned durable work', async () => {
  await fixture(async db => {
    const afterCommit = new AbortController();
    const transaction = db.adapter.withTransaction.bind(db.adapter);
    db.adapter.withTransaction = async (fn, options) => {
      let refusalWrite = false;
      const result = await transaction(async scoped => {
        const prepare = scoped.prepare.bind(scoped);
        scoped.prepare = sql => { if (sql.includes('INSERT INTO') && sql.includes('sporades_jobs')) refusalWrite = true; return prepare(sql); };
        return fn(scoped);
      }, options);
      if (refusalWrite) afterCommit.abort();
      return result;
    };
    await denied(db, afterCommit.signal);
    assert.equal((await rows(db)).length, 1);
    assert.equal((await rows(db))[0].status, 'queued');
  });
});

async function engineProof(dir, serverEnv = {}, config = {}) {
  const observed = [];
  const def = definition(refusal, observed);
  let clock;
  const open = () => { clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z'); return openDevDatabase(path.join(dir, 'data.db'), '', serverEnv, { name: def.name, ...config }, def, { clock }); };
  let db = await open();
  try {
    await Promise.all([denied(db), denied(db)]);
    assert.equal((await rows(db)).length, 1);
    assert.equal((await rows(db))[0].status, 'queued');
    await db.close(); db = await open();
    assert.equal((await rows(db))[0].attempts, 0);
    await db.init(); await clock.runDueTimers();
    assert.deepEqual(observed, [{ actor: '__privileged__', payload: { applicationId: 'trusted-id' } }]);
    assert.equal((await rows(db))[0].status, 'succeeded');
    await denied(db);
    assert.equal((await rows(db)).length, 1);
    await clock.runDueTimers();
    assert.equal(observed.length, 1);
  } finally { await db.close(); }
}
test('SQLite refusal concurrency, pending restart delivery and replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'refusal-sqlite-'));
  try { await engineProof(dir); } finally { await rm(dir, { recursive: true, force: true }); }
});
test('libSQL refusal concurrency, pending restart delivery and replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'refusal-libsql-'));
  try { await withFakeLibsqlService(path.join(dir, 'remote.db'), {}, async ({ url }) => engineProof(dir, { SPORADES_SERVICE_DATABASE_ENGINE: 'libsql', SPORADES_SERVICE_DATABASE_URL: url }, { services: { database: { engine: 'libsql' } } })); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('Postgres refusal concurrency, pending restart delivery and replay', { skip: POSTGRES_SKIP_REASON }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'refusal-postgres-'));
  try { await withPostgresAdapter(async () => {}); await engineProof(dir, { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
