import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDevDatabase, runMutation, runCurrentUserJobWorker, createControllableRuntimeClock } from '../dist/server-runtime-source.js';
import { table, String as Text, job, mutation, schedule } from '../dist/server.js';
import { createSqliteDatabaseAdapter } from '../dist/database-runtime.js';
import { resourceCanonicalJson, bindJobResources } from '../dist/resource-runtime.js';

const actor = { userId: 'actor', displayName: 'Actor', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const options = (input = { b: 2, a: 1 }) => ({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'operation', input });
async function fixture(handler, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'resource-runtime-'));
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: 'resources' }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(handler), child: job(() => null) },
    mutations: { enqueue: mutation((ctx, payload, retry) => ctx.jobs.enqueue('work', payload, { retry })), unsupported: mutation((ctx) => ctx.resources.run(options(), () => null)) },
    ...extra,
  }, { clock });
  database.adapter.prepare('INSERT INTO anchors (id,createdAt,updatedAt,value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'original');
  await database.init();
  const enqueue = async (payload = null, retry = { maxAttempts: 1, delayMs: 0 }) => {
    const result = await runMutation(database, actor, 'enqueue', [payload, retry]);
    assert.equal(result.ok, true);
    await runCurrentUserJobWorker(database);
    return database.adapter.prepare('SELECT * FROM sporades_jobs WHERE id=?').get(result.data.id);
  };
  return { database, clock, enqueue, file: path.join(dir, 'data.db'), close: async () => { await database.shutdown(); await database.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('SQLite commits writes, enqueues and a canonical replay receipt exactly once', async () => {
  let callbacks = 0;
  const f = await fixture(async (ctx, input) => ctx.resources.run(options(input), async scope => {
    callbacks++;
    await scope.db.writes.insert({ value: 'committed' });
    await scope.jobs.enqueue('child', null, { availableAt: '2031-01-01T00:00:00.000Z' });
    return { ok: true };
  }));
  try {
    const first = await f.enqueue({ a: 1, b: 2 });
    assert.equal(first.status, 'succeeded', first.failure);
    const replay = await f.enqueue({ b: 2, a: 1 });
    assert.equal(replay.status, 'succeeded', replay.failure);
    assert.equal(callbacks, 1);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_jobs WHERE handler='child'").get().n, 1);
    const conflict = await f.enqueue({ a: 2 });
    assert.equal(JSON.parse(conflict.failure).code, 'RESOURCE_OPERATION_CONFLICT');
  } finally { await f.close(); }
});

test('rollback removes app writes and receipt; escaped handles reject after callback', async () => {
  let escaped;
  const f = await fixture(async ctx => ctx.resources.run(options(), async scope => {
    escaped = scope.db.writes;
    await scope.db.writes.insert({ value: 'rollback' });
    await scope.jobs.enqueue('child', null);
    throw new Error('fixture failure');
  }));
  try {
    assert.equal((await f.enqueue()).status, 'failed');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_jobs WHERE handler='child'").get().n, 0);
    assert.throws(() => escaped.insert({ value: 'late' }), { code: 'RESOURCE_SCOPE_INACTIVE' });
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('entry is first and once; parent aliases, nested privilege and notification effects fail closed', async () => {
  const seen = [];
  const f = await fixture(async (ctx, mode) => {
    if (mode === 'prior') {
      await ctx.db.writes.all();
      await assert.rejects(ctx.resources.run(options(), () => null), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
      return null;
    }
    const alias = ctx.db.writes;
    await assert.rejects(ctx.resources.run(options(), async scope => {
      assert.throws(() => alias.all(), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
      assert.throws(() => ctx.privileged.run({}, () => null), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
      await assert.rejects(ctx.resources.run(options(), () => null), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
      await assert.rejects(scope.notifications.accept({}), { code: 'RESOURCE_EFFECT_UNSUPPORTED' });
      seen.push('callback');
      return null;
    }), { code: 'RESOURCE_EFFECT_UNSUPPORTED' });
    await assert.rejects(ctx.resources.run(options(), () => null), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
    return null;
  });
  try {
    assert.equal((await f.enqueue('prior')).status, 'succeeded');
    const row = await f.enqueue('scope');
    assert.equal(row.status, 'succeeded', row.failure);
    assert.deepEqual(seen, ['callback']);
    const unsupported = await runMutation(f.database, actor, 'unsupported', []);
    assert.equal(unsupported.ok, false);
  } finally { await f.close(); }
});

test('original lease reserves 1000ms; watchdog rolls back and revokes a noncooperative callback', async () => {
  let escaped;
  let callbackStarted;
  const started = new Promise(resolve => callbackStarted = resolve);
  const f = await fixture(async ctx => ctx.resources.run(options(), async scope => {
    escaped = scope.db.writes;
    await scope.db.writes.insert({ value: 'deadline' });
    callbackStarted();
    await new Promise(() => {});
  }));
  try {
    const running = f.enqueue();
    await started;
    f.clock.advanceBy(29_000);
    assert.throws(() => escaped.all(), { code: 'RESOURCE_DEADLINE_EXCEEDED' });
    f.clock.advanceBy(1000);
    await f.clock.runDueTimers();
    const row = await running;
    assert.equal(row.status, 'failed', row.failure);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
    assert.throws(() => escaped.all(), { code: 'RESOURCE_SCOPE_INACTIVE' });
  } finally { await f.close(); }
});

test('canonical JSON rejects lossy or oversized values and normalizes key order', () => {
  assert.equal(resourceCanonicalJson({ z: -0, a: [true, null] }), '{"a":[true,null],"z":0}');
  for (const value of [undefined, NaN, new Date(), { x: undefined }, new Array(2), 'x'.repeat(65537)]) {
    assert.throws(() => resourceCanonicalJson(value), { code: 'RESOURCE_INVALID_INPUT' });
  }
});

test('status acquires authority and returns committed or absent without a callback', async () => {
  const f = await fixture(async (ctx, mode) => mode === 'write'
    ? ctx.resources.run(options(), () => ({ stored: true }))
    : ctx.resources.status({ resource: options().resource, operationId: mode }));
  try {
    assert.deepEqual(JSON.parse((await f.enqueue('missing')).result), { state: 'absent' });
    await f.enqueue('write');
    assert.deepEqual(JSON.parse((await f.enqueue('operation')).result), { state: 'committed', result: { stored: true }, intentIds: [] });
  } finally { await f.close(); }
});

test('failure after committed scope retries by receipt without repeating writes', async () => {
  let callbacks = 0, attempts = 0;
  const f = await fixture(async ctx => {
    const result = await ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'once' }); return true; });
    if (++attempts === 1) throw new Error('after successful scope');
    return result;
  });
  try {
    await f.enqueue(null, { maxAttempts: 2, delayMs: 0 });
    f.clock.advanceBy(1); await f.clock.runDueTimers();
    assert.equal(callbacks, 1); assert.equal(attempts, 2);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
    assert.equal(f.database.adapter.prepare("SELECT status FROM sporades_jobs WHERE handler='work'").get().status, 'succeeded');
  } finally { await f.close(); }
});

test('unknown commit acknowledgement reconciles through a receipt after reacquisition', async () => {
  let callbacks = 0;
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'once' }); return true; }));
  try {
    const original = f.database.adapter.withResourceTransaction.bind(f.database.adapter);
    let loseResponse = true;
    f.database.adapter.withResourceTransaction = async (...args) => {
      const value = await original(...args);
      if (loseResponse) { loseResponse = false; throw Object.assign(new Error('Commit acknowledgement lost.'), { code: 'RESOURCE_COMMIT_UNKNOWN' }); }
      return value;
    };
    const first = await f.enqueue();
    assert.equal(JSON.parse(first.failure).code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal((await f.enqueue()).status, 'succeeded');
    assert.equal(callbacks, 1);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
  } finally { await f.close(); }
});

test('current anchor ACL and actor binding are checked again on receipt replay', async () => {
  let allow = true;
  let callbacks = 0;
  const f = await fixture(ctx => ctx.resources.run(options(), () => { callbacks++; return true; }), {
    schema: { anchors: table({ value: Text() }).acl({ read: () => allow, write: () => allow }), writes: table({ value: Text() }) },
  });
  try {
    assert.equal((await f.enqueue()).status, 'succeeded');
    allow = false;
    assert.equal((await f.enqueue()).status, 'failed');
    assert.equal(callbacks, 1);
  } finally { await f.close(); }
});

test('unawaited DB work drains before receipt commit; late asynchronous ACL cannot write after rollback', async () => {
  let releaseAcl, startedAcl;
  const started = new Promise(resolve => startedAcl = resolve);
  const released = new Promise(resolve => releaseAcl = resolve);
  const f = await fixture(ctx => ctx.resources.run(options(), scope => { scope.db.writes.insert({ value: 'drained' }); return true; }), {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }).acl({ write: async () => { startedAcl(); await released; return true; } }) },
  });
  try {
    const pending = f.enqueue(); await started;
    f.clock.advanceBy(30_000); await f.clock.runDueTimers();
    assert.equal((await pending).status, 'failed');
    releaseAcl(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
  } finally { releaseAcl(); await f.close(); }
});

test('non-opt-in ordinary Jobs retain synchronous DB access and nontransactional failure behavior', async () => {
  const f = await fixture(ctx => {
    const row = ctx.db.writes.insert({ value: 'legacy' });
    assert.equal(typeof row.id, 'string');
    throw new Error('legacy failure');
  });
  try {
    assert.equal((await f.enqueue()).status, 'failed');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('different captured actor cannot replay or inspect another actor receipt', async () => {
  const f = await fixture((ctx, mode) => mode === 'status' ? ctx.resources.status({ resource: options().resource, operationId: 'operation' }) : ctx.resources.run(options(), () => true));
  try {
    await f.enqueue();
    for (const mode of [null, 'status']) {
    const queued = await runMutation(f.database, { ...actor, userId: 'other' }, 'enqueue', [mode, { maxAttempts: 1 }]);
    await runCurrentUserJobWorker(f.database);
    const row = f.database.adapter.prepare('SELECT failure FROM sporades_jobs WHERE id=?').get(queued.data.id);
    assert.equal(JSON.parse(row.failure).code, 'RESOURCE_OPERATION_CONFLICT');
    }
  } finally { await f.close(); }
});

test('entry rejects exhausted original budget and exact claim-token replacement before callback', async () => {
  let callbacks = 0;
  let f;
  f = await fixture(async (ctx, mode) => {
    if (mode === 'deadline') f.clock.advanceBy(29_000);
    else f.database.adapter.prepare("UPDATE sporades_jobs SET claimToken='replacement' WHERE status='running'").run();
    await assert.rejects(ctx.resources.run(options(), () => { callbacks++; return true; }), { code: mode === 'deadline' ? 'RESOURCE_DEADLINE_EXCEEDED' : 'RESOURCE_CLAIM_LOST' });
    return null;
  });
  try {
    await f.enqueue('deadline'); await f.enqueue('claim');
    assert.equal(callbacks, 0);
  } finally { await f.close(); }
});

test('a commit already admitted under its exact claim can finish after the original deadline', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => { await scope.db.writes.insert({ value: 'admitted' }); return true; }));
  try {
    const original = f.database.adapter.withResourceTransaction.bind(f.database.adapter);
    f.database.adapter.withResourceTransaction = (fn, precommit) => original(fn, adapter => {
      precommit(adapter);
      // Models a pause after the final synchronous admission decision. COMMIT
      // still owns the same dedicated engine connection until it returns.
      f.clock.advanceBy(30_001);
    });
    assert.equal((await f.enqueue()).status, 'succeeded');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get().n, 1);
  } finally { await f.close(); }
});

test('resource logs commit with the receipt and never retain supplied payload values', async () => {
  const f = await fixture((ctx, fail) => ctx.resources.run(options(fail), scope => {
    scope.log.info('private-input', { body: 'private-body' });
    if (fail) throw new Error('rollback');
    return true;
  }));
  try {
    await f.enqueue(true);
    assert.equal((await f.database.adapter.readRecentLogEvents(100)).filter(event => event.category === 'resource').length, 0);
    await f.enqueue(false);
    const events = (await f.database.adapter.readRecentLogEvents(100)).filter(event => event.category === 'resource');
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes('private-'), false);
  } finally { await f.close(); }
});

test('existing audited Privileged Job authority enters without allowing nested privilege', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    await scope.db.writes.insert({ value: 'privileged' });
    return true;
  }), {
    schema: { anchors: table({ value: Text() }).acl({ read: () => false, write: () => false }), writes: table({ value: Text() }).acl({ write: () => false }) },
    mutations: { enqueue: mutation((ctx, payload, retry) => ctx.privileged.run({ operation: 'resource.enqueue', targetResourceKind: 'job-queue' }, privileged => privileged.jobs.enqueue('work', payload, { retry }))) },
  });
  try {
    const row = await f.enqueue();
    assert.equal(row.status, 'succeeded', row.failure);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
    const audits = await f.database.adapter.readRecentLogEvents(100);
    assert.equal(audits.some(event => event.data?.operation === 'jobs.execute'), true);
  } finally { await f.close(); }
});

test('entry validates byte bounds and rejects caller-controlled authority without callback', async () => {
  let callbacks = 0;
  const f = await fixture(async ctx => {
    for (const invalid of [
      { ...options(), actor: 'override' }, { ...options(), operationId: 'é'.repeat(65) },
      { ...options(), operationId: '' }, { ...options(), input: 'x'.repeat(65537) },
      { ...options(), resource: { table: 'undeclared', id: 'anchor' } },
    ]) await assert.rejects(ctx.resources.run(invalid, () => { callbacks++; return true; }), { code: 'RESOURCE_INVALID_INPUT' });
    return ctx.resources.run(options(), () => { callbacks++; return null; });
  });
  try { assert.equal((await f.enqueue()).status, 'succeeded'); assert.equal(callbacks, 1); }
  finally { await f.close(); }
});

test('current Team membership authorizes anchor and writes under the captured linked Job actor', async () => {
  const teamId = '11111111-1111-4111-8111-111111111111';
  let callbacks = 0;
  const member = ({ ctx }) => ctx.acl.teams.isMember(teamId);
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    callbacks++; await scope.db.writes.insert({ value: 'member' }); return true;
  }), { schema: { anchors: table({ value: Text() }).acl({ read: member, write: member }), writes: table({ value: Text() }).acl({ write: member }) } });
  try {
    f.database.adapter.prepare('INSERT INTO sporades_teams (id,name,createdAt,createdByUserId) VALUES (?,?,?,?)').run(teamId, 'Fixture', f.clock.now().toISOString(), actor.userId);
    f.database.adapter.prepare('INSERT INTO sporades_team_memberships (teamId,userId,role,createdAt) VALUES (?,?,?,?)').run(teamId, actor.userId, 'member', f.clock.now().toISOString());
    const linkedActor = { ...actor, isAuthenticated: true, isGuest: false, provider: 'email' };
    const invoke = async () => {
      const queued = await runMutation(f.database, linkedActor, 'enqueue', [null, { maxAttempts: 1 }]);
      await runCurrentUserJobWorker(f.database);
      return f.database.adapter.prepare('SELECT status FROM sporades_jobs WHERE id=?').get(queued.data.id).status;
    };
    assert.equal(await invoke(), 'succeeded');
    f.database.adapter.prepare('DELETE FROM sporades_team_memberships WHERE teamId=?').run(teamId);
    assert.equal(await invoke(), 'failed');
    assert.equal(callbacks, 1);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
  } finally { await f.close(); }
});


test('unsupported adapter discriminators reject run and status before opening a connection', async () => {
  for (const engine of ['postgres', 'libsql']) {
    const context = { auth: actor };
    bindJobResources({ adapter: { engine, withResourceTransaction() { assert.fail('unsupported connection opened'); } } }, context, {}, {});
    await assert.rejects(context.resources.run(options(), () => assert.fail('unsupported callback entered')), { code: 'RESOURCE_ADAPTER_UNSUPPORTED' });
    await assert.rejects(context.resources.status({ resource: options().resource, operationId: 'operation' }), { code: 'RESOURCE_ADAPTER_UNSUPPORTED' });
  }
});

test('a postcommit hook failure never calls rollback hooks and has a redacted error', async () => {
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let rolledBack = 0;
  const context = { auth: actor };
  bindJobResources({
    clock, schema: { tables: [{ name: 'anchors' }] },
    adapter: { engine: 'sqlite', withResourceTransaction: async () => true },
  }, context, { leaseExpiresAt: '2030-01-01T00:00:30.000Z' }, {
    committed() { throw new Error('private filesystem path'); },
    rolledBack() { rolledBack++; }, release() {},
  });
  await assert.rejects(context.resources.run(options(), () => null), error => {
    assert.equal(error.code, 'RESOURCE_STORAGE_ERROR');
    assert.equal(error.message, 'Resource operation could not complete.');
    return true;
  });
  assert.equal(rolledBack, 0);
});

test('resource entry locks out parent DB but permits outcome logging after settlement even on busy', async () => {
  const f = await fixture(async (ctx, busy) => {
    if (busy) await assert.rejects(ctx.resources.run(options(), () => null), { code: 'RESOURCE_BUSY' });
    else await ctx.resources.run(options(), () => {
      assert.throws(() => ctx.log.info('inside scope'), { code: 'RESOURCE_EFFECT_UNSUPPORTED' });
      return true;
    });
    assert.throws(() => ctx.db.writes.all(), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
    assert.doesNotThrow(() => ctx.log.info('after scope'));
    return true;
  });
  try {
    assert.equal((await f.enqueue(false)).status, 'succeeded');
    f.database.adapter.withResourceTransaction = async () => { throw Object.assign(new Error('busy'), { code: 'RESOURCE_BUSY' }); };
    assert.equal((await f.enqueue(true)).status, 'succeeded');
  } finally { await f.close(); }
});

test('same-runtime resource acquisition is busy behind a transaction but roots queue behind a resource', async () => {
  const f = await fixture(() => null);
  const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
  try {
    const entered = barrier(), finish = barrier();
    const outer = f.database.adapter.withTransaction(async () => { entered.release(); await finish.promise; });
    await entered.promise;
    await assert.rejects(f.database.adapter.withResourceTransaction(() => assert.fail('busy callback')), { code: 'RESOURCE_BUSY', retryable: true });
    finish.release(); await outer;
    const scoped = barrier(), releaseScope = barrier();
    const resource = f.database.adapter.withResourceTransaction(async () => { scoped.release(); await releaseScope.promise; });
    await scoped.promise;
    let rootRan = false;
    const root = f.database.adapter.withTransaction(() => { rootRan = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rootRan, false);
    releaseScope.release(); await resource; await root;
    assert.equal(rootRan, true);
  } finally { await f.close(); }
});


test('resource table namespace rejects module and source schemas descriptively', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'resource-reserved-'));
  try {
    for (const fromSource of [false, true]) {
      await assert.rejects(openDevDatabase(path.join(dir, `${fromSource}.db`),
        fromSource ? 'schema: { sporades_resource_private: table({ value: String() }) }' : '', {}, {},
        fromSource ? undefined : { schema: { sporades_resource_private: table({ value: Text() }) } }), error => {
          assert.equal(error.code, 'RESERVED_TABLE_NAME');
          assert.match(error.message, /Reserved runtime table name: sporades_resource_private/);
          return true;
        });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('caught engine constraint failure poisons scope and maps to redacted storage failure', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    await scope.db.writes.insert({ value: 'duplicate' });
    await assert.rejects(scope.db.writes.insert({ value: 'duplicate' }));
    return true;
  }), { schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }).unique('value') } });
  try {
    const row = await f.enqueue();
    assert.equal(row.status, 'failed');
    assert.deepEqual(JSON.parse(row.failure), { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
  } finally { await f.close(); }
});

test('resource busy Job settlement retains the public redacted busy message', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), () => true));
  try {
    f.database.adapter.withResourceTransaction = async () => { throw Object.assign(new Error('private engine details'), { code: 'RESOURCE_BUSY' }); };
    assert.deepEqual(JSON.parse((await f.enqueue()).failure), { code: 'RESOURCE_BUSY', message: 'Resource transaction is busy.' });
  } finally { await f.close(); }
});

test('a scheduled Job opts into resources and transfers its enqueuer to child Jobs', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    await scope.db.writes.insert({ value: 'scheduled' });
    await scope.jobs.enqueue('child', null, { availableAt: '2031-01-01T00:00:00.000Z' });
    return true;
  }), { schedules: { recurring: schedule({ expression: '* * * * *', job: 'work' }) } });
  try {
    f.clock.advanceBy(60_000);
    await f.clock.runDueTimers();
    const parent = f.database.adapter.prepare("SELECT * FROM sporades_jobs WHERE handler='work'").get();
    const child = f.database.adapter.prepare("SELECT * FROM sporades_jobs WHERE handler='child'").get();
    assert.equal(parent.status, 'succeeded', parent.failure);
    assert.equal(parent.scheduleName, 'recurring');
    assert.equal(parent.scheduledFor, '2030-01-01T00:01:00.000Z');
    assert.equal(child.enqueuedByUserId, parent.enqueuedByUserId);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1);
  } finally { await f.close(); }
});

test('the 101st scope log call rejects and rolls back staged writes', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    await scope.db.writes.insert({ value: 'rollback-log-cap' });
    for (let i = 0; i < 100; i++) scope.log.info('discarded payload');
    scope.log.info('one too many');
    return true;
  }));
  try {
    assert.equal(JSON.parse((await f.enqueue()).failure).code, 'RESOURCE_INVALID_INPUT');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
  } finally { await f.close(); }
});


test('dedicated connection acquisition failure is redacted and releases the runtime gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'resource-open-failure-'));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, 'data.db'));
  try {
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(adapter.withResourceTransaction(() => assert.fail('callback entered')), {
      code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.',
    });
    await assert.rejects(adapter.withResourceTransaction(() => assert.fail('callback entered')), {
      code: 'RESOURCE_STORAGE_ERROR',
    });
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const remote of [false, true]) for (const privileged of [false, true]) test(`${remote ? 'cross-runtime' : 'local'} resource cancellation settles the ${privileged ? 'Privileged' : 'ordinary'} Job as cancelled without consuming retries`, async () => {
  let entered, resume;
  const ready = new Promise(resolve => { entered = resolve; });
  const proceed = new Promise(resolve => { resume = resolve; });
  const f = await fixture(async ctx => {
    entered();
    await proceed;
    return ctx.resources.run(options(), () => assert.fail('cancelled callback entered'));
  }, { mutations: {
    enqueue: mutation((ctx, payload, retry) => privileged
      ? ctx.privileged.run({ operation: 'resource.enqueue', targetResourceKind: 'job-queue' }, admin => admin.jobs.enqueue('work', payload, { retry }))
      : ctx.jobs.enqueue('work', payload, { retry })),
    cancel: mutation((ctx, id) => privileged
      ? ctx.privileged.run({ operation: 'resource.cancel', targetResourceKind: 'job-queue' }, admin => admin.jobs.cancel(id))
      : ctx.jobs.cancel(id)),
  } });
  try {
    const completion = f.enqueue(null, { maxAttempts: 3, delayMs: 0 });
    await ready;
    const running = f.database.adapter.prepare("SELECT id FROM sporades_jobs WHERE status='running'").get();
    if (remote) {
      const other = await createSqliteDatabaseAdapter(f.file);
      try {
        other.prepare("UPDATE sporades_jobs SET cancelRequestedAt=? WHERE id=? AND status='running'").run(f.clock.now().toISOString(), running.id);
      } finally { await other.close(); }
    } else {
      const cancelled = await runMutation(f.database, actor, 'cancel', [running.id]);
      assert.equal(cancelled.ok, true);
    }
    resume();
    const settled = await completion;
    assert.equal(settled.status, 'cancelled', settled.failure);
    assert.equal(JSON.parse(settled.attemptHistory).length, 1);
    assert.equal(JSON.parse(settled.attemptHistory)[0].outcome, 'cancelled');
  } finally { resume(); await f.close(); }
});

test('an unawaited unsupported notification poisons and rolls back the resource transaction', async () => {
  const f = await fixture(ctx => ctx.resources.run(options(), async scope => {
    await scope.db.writes.insert({ value: 'must roll back' });
    scope.notifications.accept({});
    return true;
  }));
  try {
    const result = await f.enqueue();
    assert.equal(result.status, 'failed');
    assert.equal(JSON.parse(result.failure).code, 'RESOURCE_EFFECT_UNSUPPORTED');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});
