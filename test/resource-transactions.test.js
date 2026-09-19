import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { openDevDatabase, runMutation, runEndpoint, runCurrentUserJobWorker, createControllableRuntimeClock } from '../dist/server-runtime-source.js';
import { table, String as Text, endpoint, job, mutation, requireAuth, schedule } from '../dist/server.js';
import { createSqliteDatabaseAdapter } from '../dist/database-runtime.js';
import { resolveAnonymousSession } from '../dist/auth-runtime.js';
import { resourceCanonicalJson, bindJobResources, bindOuterResources } from '../dist/resource-runtime.js';
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from './support/database-adapter-engines.js';
import { createPostgresDatabaseAdapter } from '../dist/server-runtime-source.js';

const actor = { userId: 'actor', displayName: 'Actor', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const options = (input = { b: 2, a: 1 }) => ({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'operation', input });
// Runtime-owned identifiers are quoted through ADR-0039's dialect.  The
// fault hooks observe the receipt operation, not one historical rendering.
const isResourceReceiptInsert = sql => /INSERT\s+INTO\s+(?:\[|\")?sporades_resource_receipts(?:\]|\")?\b/i.test(sql);
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

test('Postgres Job resource scope commits a canonical receipt through its dedicated resource connection', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let resourceFailure;
  const database = await openDevDatabase('postgres-resource-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(async ctx => { try { return await ctx.resources.run(options(), async scope => { await scope.db.writes.insert({ value: 'postgres' }); return { committed: true }; }); } catch (error) { resourceFailure = `${error.code}:${error.message}`; return { failed: error.code }; } }) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue('work', null)) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const queued = await runMutation(database, actor, 'enqueue', []);
    assert.equal(queued.ok, true);
    await runCurrentUserJobWorker(database);
    const settled = await database.adapter.prepare("SELECT status,failure FROM sporades_jobs WHERE id=?").get(queued.data.id);
    assert.equal(settled.status, 'succeeded', settled.failure);
    assert.equal(resourceFailure, undefined, resourceFailure);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres resource ACL helpers preserve awaited Team and cross-table decisions while rejecting synchronous unawaited reads', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'policies', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const teamId = '11111111-1111-4111-8111-111111111111';
  const linkedActor = { ...actor, userId: 'postgres-acl-user', isAuthenticated: true, isGuest: false, provider: 'email' };
  let callbacks = 0;
  const database = await openDevDatabase('postgres-resource-acl-helper-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-acl-helper', services: { database: { engine: 'postgres' } } }, {
    schema: {
      anchors: table({ value: Text() }).acl({ read: ({ row, ctx }) => {
        if (row.value === 'team-allow') return (async () => await ctx.acl.teams.isMember(teamId))();
        if (row.value === 'team-deny') return (async () => await ctx.acl.teams.isAdmin(teamId))();
        if (row.value === 'cross-table-allow') return ctx.acl.db.get('policies', 'allow').then(policy => policy?.value === 'allowed');
        if (row.value === 'cross-table-deny') return ctx.acl.db.exists('policies', 'missing').then(Boolean);
        if (row.value === 'awaited-promise-resolve') return (async () => await Promise.resolve(ctx.acl.db.exists('policies', 'allow')))();
        if (row.value === 'awaited-promise-all') return (async () => {
          const [member, policyExists] = await Promise.all([
            ctx.acl.teams.isMember(teamId),
            ctx.acl.db.exists('policies', 'allow'),
          ]);
          return member && policyExists;
        })();
        if (row.value === 'lost-promise-race') return (async () => await Promise.race([
          Promise.resolve(true),
          ctx.acl.db.exists('policies', 'allow'),
        ]))();
        if (row.value === 'lost-promise-any') return (async () => await Promise.any([
          Promise.resolve(true),
          ctx.acl.db.exists('policies', 'allow'),
        ]))();
        if (row.value === 'ignored-promise-resolve') return (async () => {
          void Promise.resolve(ctx.acl.db.exists('policies', 'allow'));
          await Promise.resolve();
          return true;
        })();
        if (row.value.startsWith('discarded-')) return (async () => {
          const helper = ctx.acl.teams.isAdmin(teamId);
          if (row.value === 'discarded-then') void helper.then(Boolean);
          if (row.value === 'discarded-catch') void helper.catch(() => false);
          if (row.value === 'discarded-finally') void helper.finally(() => {});
          return true;
        })();
        ctx.acl.db.exists('policies', 'allow').then(Boolean);
        return true;
      }, write: () => true }),
      policies: table({ value: Text() }),
      writes: table({ value: Text() }),
    },
    mutations: { write: mutation((ctx, id) => ctx.resources.run({ ...options({ id }), resource: { table: 'anchors', id }, operationId: `acl-helper-${id}` }, async scope => {
      callbacks++;
      await scope.db.writes.insert({ value: id });
      return { committed: id };
    })) },
  }, { clock });
  try {
    await database.init();
    const now = clock.now().toISOString();
    await database.adapter.prepare('INSERT INTO sporades_teams (id,name,"createdAt","createdByUserId") VALUES (?,?,?,?)').run(teamId, 'Postgres ACL Team', now, linkedActor.userId);
    await database.adapter.prepare('INSERT INTO sporades_team_memberships ("teamId","userId",role,"createdAt") VALUES (?,?,?,?)').run(teamId, linkedActor.userId, 'member', now);
    await database.adapter.prepare('INSERT INTO policies (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('allow', now, now, 'allowed');
    const ids = ['team-allow', 'team-deny', 'cross-table-allow', 'cross-table-deny', 'awaited-promise-resolve', 'awaited-promise-all', 'lost-promise-race', 'lost-promise-any', 'ignored-promise-resolve', 'discarded-then', 'discarded-catch', 'discarded-finally', 'unawaited'];
    const allowed = new Set(['team-allow', 'cross-table-allow', 'awaited-promise-resolve', 'awaited-promise-all']);
    for (const id of ids) {
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run(id, now, now, id);
    }
    for (const id of ids) {
      const result = await runMutation(database, linkedActor, 'write', [id]);
      if (allowed.has(id)) assert.deepEqual(result, { ok: true, data: { committed: id }, error: null });
      else {
        assert.equal(result.ok, false);
        assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'DENIED', message: 'Denied.' });
      }
    }
    assert.equal(callbacks, 4);
    assert.deepEqual((await database.adapter.prepare('SELECT value FROM writes ORDER BY value').all()).map(row => row.value), ['awaited-promise-all', 'awaited-promise-resolve', 'cross-table-allow', 'team-allow']);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres resource ACL Team dependencies stay locked through callback settlement', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const dependency of ['membership', 'application-role']) await t.test(dependency, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    const teamId = '22222222-2222-4222-8222-222222222222';
    const linkedActor = { ...actor, userId: `postgres-${dependency}-user`, isAuthenticated: true, isGuest: false, provider: 'email' };
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const database = await openDevDatabase(`postgres-resource-acl-${dependency}-lock`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-resource-acl-${dependency}-lock`, services: { database: { engine: 'postgres' } } }, {
      teams: { appRoles: ['author'] },
      schema: {
        anchors: table({ value: Text() }).acl({
          read: ({ row, ctx }) => dependency === 'membership'
            ? ctx.acl.teams.isMember(row.value)
            : ctx.acl.teams.hasRole(row.value, 'author'),
          write: () => true,
        }),
        writes: table({ value: Text() }),
      },
      mutations: { write: mutation(ctx => ctx.resources.run({ ...options({ dependency }), operationId: `acl-dependency-${dependency}` }, async scope => {
        entered.resolve();
        await release.promise;
        await scope.db.writes.insert({ value: dependency });
        return { committed: dependency };
      })) },
    }, { clock });
    let revoker; let execution; let revocation;
    try {
      await database.init();
      const now = clock.now().toISOString();
      await database.adapter.prepare('INSERT INTO sporades_teams (id,name,"createdAt","createdByUserId") VALUES (?,?,?,?)').run(teamId, 'Postgres dependency Team', now, linkedActor.userId);
      await database.adapter.prepare('INSERT INTO sporades_team_memberships ("teamId","userId",role,"createdAt") VALUES (?,?,?,?)').run(teamId, linkedActor.userId, 'member', now);
      await database.adapter.prepare('INSERT INTO sporades_team_membership_application_roles ("teamId","userId",role,"createdAt") VALUES (?,?,?,?)').run(teamId, linkedActor.userId, 'author', now);
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', now, now, teamId);
      execution = runMutation(database, linkedActor, 'write', []);
      await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${dependency} ACL did not authorize before callback entry`)), 2_000))]);
      revoker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      revocation = dependency === 'membership'
        ? revoker.prepare('DELETE FROM sporades_team_memberships WHERE "teamId"=? AND "userId"=?').run(teamId, linkedActor.userId)
        : revoker.prepare('DELETE FROM sporades_team_membership_application_roles WHERE "teamId"=? AND "userId"=? AND role=?').run(teamId, linkedActor.userId, 'author');
      assert.equal(await Promise.race([revocation.then(() => 'committed'), new Promise(resolve => setTimeout(() => resolve('pending'), 75))]), 'pending');
      release.resolve();
      assert.deepEqual(await execution, { ok: true, data: { committed: dependency }, error: null });
      await revocation;
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes WHERE value=?').get(dependency)).n), 1);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE "operationId"=?').get(`acl-dependency-${dependency}`)).n), 1);
    } finally {
      release.resolve();
      await execution?.catch(() => {});
      await revocation?.catch(() => {});
      await revoker?.close();
      await database.shutdown(); await database.close();
    }
  });
});

test('Postgres Job locks the authorization anchor before a concurrent revocation can commit', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let releaseAuthorization;
  let markAuthorizationLocked;
  const authorizationLocked = new Promise(resolve => { markAuthorizationLocked = resolve; });
  const authorizationRelease = new Promise(resolve => { releaseAuthorization = resolve; });
  const database = await openDevDatabase('postgres-resource-authorization-lock-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-authorization-lock', services: { database: { engine: 'postgres' } } }, {
    schema: {
      anchors: table({ value: Text() }).acl({ read: ({ row }) => row?.value === 'allowed', write: () => true }),
      writes: table({ value: Text() }),
    },
    jobs: { work: job(ctx => ctx.resources.run(options({ authorization: 'locked' }), async scope => {
      // This public callback is entered only after `resources.run` authorizes
      // the anchor. Pausing here retains the unmodified PostgreSQL transaction
      // and its FOR UPDATE lock; no adapter method or SQL text is replaced.
      markAuthorizationLocked();
      await authorizationRelease;
      await scope.db.writes.insert({ value: 'protected-after-authorization' });
      return { committed: true };
    })) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'allowed');
    const queued = await runMutation(database, actor, 'enqueue', []);
    const worker = runCurrentUserJobWorker(database);
    await Promise.race([authorizationLocked, new Promise((_, reject) => setTimeout(() => reject(new Error('Job did not lock the authorization anchor before entering its resource callback')), 2_000))]);
    const revoker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      const revocation = revoker.prepare('UPDATE anchors SET value=? WHERE id=?').run('revoked', 'anchor');
      assert.equal(await Promise.race([revocation.then(() => 'committed'), new Promise(resolve => setTimeout(() => resolve('pending'), 75))]), 'pending');
      releaseAuthorization();
      await worker;
      await revocation;
    } finally { await revoker.close(); }
    assert.equal((await database.adapter.prepare('SELECT status,failure FROM sporades_jobs WHERE id=?').get(queued.data.id)).status, 'succeeded');
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='protected-after-authorization'").get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
    assert.equal((await database.adapter.prepare('SELECT value FROM anchors WHERE id=?').get('anchor')).value, 'revoked');
  } finally { releaseAuthorization?.(); await database.shutdown(); await database.close(); }
});

test('Postgres public resource scopes lock the authorization anchor through outer settlement', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const kind of ['mutation', 'endpoint']) await t.test(kind, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const protectedRun = ctx => ctx.resources.run({ ...options({ authorization: kind }), operationId: `outer-authorization-${kind}` }, async scope => {
      entered.resolve();
      await release.promise;
      await scope.db.writes.insert({ value: `protected-${kind}` });
      return { kind };
    });
    const database = await openDevDatabase(`postgres-outer-authorization-${kind}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-outer-authorization-${kind}`, services: { database: { engine: 'postgres' } } }, {
      schema: {
        anchors: table({ value: Text() }).acl({ read: ({ row }) => row?.value === 'allowed', write: () => true }),
        writes: table({ value: Text() }),
      },
      mutations: kind === 'mutation' ? { write: mutation(protectedRun) } : {},
      endpoints: kind === 'endpoint' ? { write: endpoint({ method: 'POST', path: '/authorization-lock' }, protectedRun) } : {},
    }, { clock });
    let revoker; let execution;
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'allowed');
      execution = kind === 'mutation'
        ? runMutation(database, actor, 'write', [])
        : resolveAnonymousSession(database, null).then(session => runEndpoint(database, database.endpoints.find(item => item.path === '/authorization-lock'), new URL('http://capsule.test/authorization-lock'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} }));
      await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${kind} did not enter after authorization`)), 2_000))]);
      revoker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      const revocation = revoker.prepare('UPDATE anchors SET value=? WHERE id=?').run('revoked', 'anchor');
      assert.equal(await Promise.race([revocation.then(() => 'committed'), new Promise(resolve => setTimeout(() => resolve('pending'), 75))]), 'pending');
      release.resolve();
      const result = await execution;
      if (kind === 'mutation') assert.deepEqual(result, { ok: true, data: { kind }, error: null });
      else assert.deepEqual(result, { kind });
      await revocation;
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes WHERE value=?').get(`protected-${kind}`)).n), 1);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE "operationId"=?').get(`outer-authorization-${kind}`)).n), 1);
      assert.equal((await database.adapter.prepare('SELECT value FROM anchors WHERE id=?').get('anchor')).value, 'revoked');
    } finally {
      release.resolve();
      await execution?.catch(() => {});
      await revoker?.close();
      await database.shutdown(); await database.close();
    }
  });
});

test('Postgres public resource scopes reject a missing anchor before authorization and commit after insertion', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const kind of ['mutation', 'endpoint']) await t.test(kind, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let authorizationReads = 0; let callbacks = 0;
    const protectedRun = ctx => ctx.resources.run({ ...options({ missingAnchor: kind }), operationId: `missing-anchor-${kind}` }, async scope => {
      callbacks++;
      await scope.db.writes.insert({ value: `missing-anchor-${kind}` });
      return { kind };
    });
    const database = await openDevDatabase(`postgres-missing-anchor-${kind}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-missing-anchor-${kind}`, services: { database: { engine: 'postgres' } } }, {
      schema: {
        anchors: table({ value: Text() }).acl({ read: ({ row }) => { authorizationReads++; return row?.value === 'allowed'; }, write: () => true }),
        writes: table({ value: Text() }),
      },
      mutations: kind === 'mutation' ? { write: mutation(protectedRun) } : {},
      endpoints: kind === 'endpoint' ? { write: endpoint({ method: 'POST', path: '/missing-anchor' }, protectedRun) } : {},
    }, { clock });
    try {
      await database.init();
      const session = kind === 'endpoint' ? await resolveAnonymousSession(database, null) : null;
      const execute = () => kind === 'mutation'
        ? runMutation(database, actor, 'write', [])
        : runEndpoint(database, database.endpoints.find(item => item.path === '/missing-anchor'), new URL('http://capsule.test/missing-anchor'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} });
      const expectedError = { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' };
      if (kind === 'mutation') {
        const result = await execute();
        assert.equal(result.ok, false);
        assert.deepEqual({ code: result.error.code, message: result.error.message }, expectedError);
      } else {
        await assert.rejects(execute(), expectedError);
      }
      assert.equal(authorizationReads, 0, 'a missing anchor must fail before its read ACL runs');
      assert.equal(callbacks, 0);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 0);
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'allowed');
      const result = await execute();
      if (kind === 'mutation') assert.deepEqual(result, { ok: true, data: { kind }, error: null });
      else assert.deepEqual(result, { kind });
      assert.ok(authorizationReads > 0, 'the inserted anchor must be authorized on retry');
      assert.equal(callbacks, 1);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 1);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
    } finally { await database.shutdown(); await database.close(); }
  });
});

test('Postgres public resource authorization reports fixed storage errors and preserves policy decisions', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const kind of ['mutation', 'endpoint']) for (const mode of ['sqlstate', 'connection', 'denial', 'policy', 'authorized']) await t.test(`${kind} ${mode}`, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let transaction; let authorizationReads = 0; let callbacks = 0; let observed;
    const protectedRun = async ctx => {
      try {
        return await ctx.resources.run(options({ authorization: mode }), async scope => {
          callbacks++;
          await scope.db.writes.insert({ value: `${kind}-${mode}` });
          return { committed: true };
        });
      } catch (error) {
        observed = error;
        throw error;
      }
    };
    const database = await openDevDatabase(`postgres-authorization-error-${kind}-${mode}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-authorization-error', services: { database: { engine: 'postgres' } } }, {
      schema: {
        anchors: table({ value: Text() }).acl({ read: async () => {
          authorizationReads++;
          if (mode === 'sqlstate') await transaction.prepare('SELECT value::integer FROM anchors WHERE id=?').get('anchor');
          if (mode === 'connection') await transaction.exec('SELECT pg_terminate_backend(pg_backend_pid())');
          if (mode === 'policy') throw Object.assign(new Error('Resource operation could not complete.'), { code: 'RESOURCE_INVALID_INPUT' });
          return mode !== 'denial';
        }, write: () => true }),
        writes: table({ value: Text() }),
      },
      mutations: kind === 'mutation' ? { write: mutation(protectedRun) } : {},
      endpoints: kind === 'endpoint' ? { write: endpoint({ method: 'POST', path: '/authorization-error' }, protectedRun) } : {},
    }, { clock });
    const originalWithTransaction = database.adapter.withTransaction;
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'allowed');
      const session = kind === 'endpoint' ? await resolveAnonymousSession(database, null) : null;
      database.adapter.withTransaction = callback => originalWithTransaction.call(database.adapter, async tx => {
        transaction = tx;
        return callback(tx);
      });
      const execute = () => kind === 'mutation'
        ? runMutation(database, actor, 'write', [])
        : runEndpoint(database, database.endpoints.find(item => item.path === '/authorization-error'), new URL('http://capsule.test/authorization-error'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} });
      if (mode === 'authorized') {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await execute();
          assert.deepEqual(result, kind === 'mutation' ? { ok: true, data: { committed: true }, error: null } : { committed: true });
        }
        assert.equal(observed, undefined);
        assert.equal(callbacks, 1);
      } else {
        const expected = mode === 'denial'
          ? { code: 'DENIED', message: 'Denied.' }
          : { code: mode === 'policy' ? 'RESOURCE_INVALID_INPUT' : 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' };
        if (kind === 'mutation') {
          const result = await execute();
          assert.equal(result.ok, false);
          assert.deepEqual({ code: result.error.code, message: result.error.message }, expected);
        } else await assert.rejects(execute(), expected);
        assert.deepEqual({ code: observed.code, message: observed.message }, expected);
        assert.equal(observed.constraint, undefined);
        assert.equal(observed.detail, undefined);
        assert.equal(observed.cause, undefined);
        if (mode === 'sqlstate' || mode === 'connection') {
          assert.deepEqual(Object.getOwnPropertyNames(observed).sort(), ['code', 'message', 'stack']);
          assert.doesNotMatch(observed.stack, /22P02|57P01|invalid input syntax|terminating connection|database is not open/);
        }
        assert.equal(callbacks, 0);
      }
      assert.ok(authorizationReads > 0, 'the failure or decision occurs during authorization after anchor acquisition');
      const inspector = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      try {
        assert.equal(Number((await inspector.prepare('SELECT count(*) n FROM writes').get()).n), mode === 'authorized' ? 1 : 0);
        assert.equal(Number((await inspector.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), mode === 'authorized' ? 1 : 0);
      } finally { await inspector.close(); }
    } finally {
      database.adapter.withTransaction = originalWithTransaction;
      await database.shutdown(); await database.close();
    }
  });
});

test('Postgres caught public resource contention poisons outer settlement without losing prior runtime state', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const { kind, lockedRow } of [
    { kind: 'mutation', lockedRow: 'resource' },
    { kind: 'endpoint', lockedRow: 'anchor' },
  ]) await t.test(`${kind} after ${lockedRow}-row contention`, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']);
    await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let callbacks = 0;
    const protectedRun = async ctx => {
      try {
        await ctx.resources.run({ ...options({ contention: lockedRow }), operationId: `caught-${lockedRow}-${kind}` }, () => { callbacks++; return true; });
      } catch (error) {
        return { code: error.code, message: error.message };
      }
      return { code: 'RESOURCE_CALLBACK_ENTERED' };
    };
    const sessionActor = { ...actor, userId: 'caught-resource-user', email: 'caught-resource@example.test', isAuthenticated: true, isGuest: false, provider: 'email' };
    const sessionToken = 'caught-resource-session';
    const database = await openDevDatabase(`postgres-caught-${lockedRow}-${kind}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-caught-${lockedRow}-${kind}`, services: { database: { engine: 'postgres' } } }, {
      ...(kind === 'mutation' ? { auth: { reauthentication: { purposes: { 'resource-write': { maxAgeSeconds: 900 } } } } } : {}),
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      mutations: kind === 'mutation' ? { contend: mutation(requireAuth({ credentials: ['session'], reauthentication: 'resource-write' }, protectedRun)) } : {},
      endpoints: kind === 'endpoint' ? { contend: endpoint({ method: 'POST', path: '/contend' }, protectedRun) } : {},
    }, { clock });
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    let locker; let lockOwner;
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'allowed');
      if (kind === 'mutation') {
        await database.adapter.insertAuthUser({ id: sessionActor.userId, createdAt: clock.now().toISOString(), displayName: sessionActor.displayName, email: sessionActor.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: 'email' });
        await database.adapter.insertAuthSession({ token: sessionToken, userId: sessionActor.userId, provider: 'email', createdAt: clock.now().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
        await database.adapter.replaceReauthenticationProof({ id: 'caught-resource-proof', userId: sessionActor.userId, sessionToken, purpose: 'resource-write', createdAt: clock.now().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
      }
      if (lockedRow === 'resource') {
        await database.adapter.withResourceTransaction(() => true, undefined, { table: 'anchors', id: 'anchor' });
      }
      locker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      lockOwner = locker.withTransaction(async transaction => {
        if (lockedRow === 'resource') {
          await transaction.prepare('SELECT "resourceTable" FROM "sporades_resource_locks" WHERE "resourceTable"=? AND "resourceId"=? FOR UPDATE').get('anchors', 'anchor');
        } else {
          await transaction.prepare('SELECT id FROM anchors WHERE id=? FOR UPDATE').get('anchor');
        }
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      if (kind === 'mutation') {
        const result = await runMutation(database, sessionActor, 'contend', [], { sessionToken });
        assert.equal(result.ok, false);
        assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_BUSY', message: 'Resource transaction is busy.' });
        assert.ok(await database.adapter.prepare('SELECT id FROM sporades_auth_reauthentication_proofs WHERE id=?').get('caught-resource-proof'), 'rollback retains the runtime-owned proof consumed before resource acquisition');
      } else {
        const session = await resolveAnonymousSession(database, null);
        const request = { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} };
        await assert.rejects(runEndpoint(database, database.endpoints.find(item => item.path === '/contend'), new URL('http://capsule.test/contend'), request), { code: 'RESOURCE_BUSY', message: 'Resource transaction is busy.' });
      }
      release.resolve();
      await lockOwner;
      assert.equal(callbacks, 0);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE "operationId"=?').get(`caught-${lockedRow}-${kind}`)).n), 0);
    } finally {
      release.resolve();
      await lockOwner?.catch(() => {});
      await locker?.close();
      await database.shutdown(); await database.close();
    }
  });
});

test('Postgres Job resource storage failures are redacted without replacing callback errors', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const observed = [];
  const database = await openDevDatabase('postgres-resource-error-redaction', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-error-redaction', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }).unique('value') },
    jobs: { work: job(async (ctx, mode) => {
      try {
        await ctx.resources.run({ ...options({ mode }), operationId: `error-${mode}` }, async scope => {
          if (mode === 'callback') throw Object.assign(new Error('Expected callback failure.'), { code: 'EXPECTED_CALLBACK_FAILURE' });
          await scope.db.writes.insert({ value: 'duplicate' });
          await scope.db.writes.insert({ value: 'duplicate' });
          return true;
        });
      } catch (error) {
        observed.push({ code: error.code, message: error.message, constraint: error.constraint, detail: error.detail });
      }
      return { caught: mode };
    }) },
    mutations: { enqueue: mutation((ctx, mode) => ctx.jobs.enqueue('work', mode, { retry: { maxAttempts: 1, delayMs: 0 } })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    for (const mode of ['storage', 'callback']) {
      const queued = await runMutation(database, actor, 'enqueue', [mode]);
      assert.equal(queued.ok, true);
      await runCurrentUserJobWorker(database);
      assert.equal((await database.adapter.prepare('SELECT status FROM sporades_jobs WHERE id=?').get(queued.data.id)).status, 'succeeded');
    }
    assert.deepEqual(observed, [
      { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.', constraint: undefined, detail: undefined },
      { code: 'EXPECTED_CALLBACK_FAILURE', message: 'Expected callback failure.', constraint: undefined, detail: undefined },
    ]);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres public resource storage failures are redacted without replacing callback errors', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const callbackCaught = [];
  const operation = (kind, mode) => ({ ...options({ kind, mode }), operationId: `public-error-${kind}-${mode}` });
  const run = (kind, mode) => async ctx => ctx.resources.run(operation(kind, mode), async scope => {
    await scope.db.writes.insert({ value: `${kind}-${mode}` });
    if (mode === 'callback') throw Object.assign(new Error('Expected callback failure.'), { code: '23505', constraint: 'deliberate_callback_constraint', detail: 'deliberate callback detail' });
    if (mode === 'receipt') return { receiptFailure: true };
    const duplicate = scope.db.writes.insert({ value: `${kind}-${mode}` });
    if (mode === 'caught') try { await duplicate; } catch (error) {
      callbackCaught.push({ kind, code: error.code, message: error.message, constraint: error.constraint, detail: error.detail });
    }
    else void duplicate.catch(() => {});
    return { impossible: true };
  });
  const database = await openDevDatabase('postgres-public-resource-error-redaction', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-public-resource-error-redaction', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }).unique('value') },
    mutations: Object.fromEntries(['caught', 'unawaited', 'receipt', 'callback'].map(mode => [mode, mutation(run('mutation', mode))])),
    endpoints: Object.fromEntries(['caught', 'unawaited', 'receipt', 'callback'].map(mode => [mode, endpoint({ method: 'POST', path: `/${mode}` }, run('endpoint', mode))])),
  }, { clock });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    await database.adapter[Symbol.for('sporades.database.resourceBootstrapMechanics')]();
    database.adapter.withTransaction = (fn, transactionOptions) => originalWithTransaction(async transaction => {
      const originalPrepare = transaction.prepare.bind(transaction);
      transaction.prepare = sql => {
        const statement = originalPrepare(sql);
        if (!isResourceReceiptInsert(sql)) return statement;
        return Object.assign(Object.create(statement), {
          run(...args) {
            if (args[5] === '{"receiptFailure":true}') throw Object.assign(new Error('receipt result forbidden'), { code: '23514' });
            return statement.run(...args);
          },
        });
      };
      return fn(transaction);
    }, transactionOptions);
    for (const kind of ['mutation', 'endpoint']) for (const mode of ['caught', 'unawaited', 'receipt', 'callback']) {
      const error = kind === 'mutation'
        ? (await runMutation(database, actor, mode, [])).error
        : await runEndpoint(database, database.endpoints.find(item => item.name === mode), new URL(`http://capsule.test/${mode}`), request).then(() => null, value => value);
      if (mode === 'callback') {
        assert.deepEqual({ code: error.code, message: error.message, constraint: error.constraint, detail: error.detail }, {
          code: '23505', message: 'Expected callback failure.',
          constraint: kind === 'endpoint' ? 'deliberate_callback_constraint' : undefined,
          detail: kind === 'endpoint' ? 'deliberate callback detail' : undefined,
        });
      } else {
        assert.deepEqual({ code: error.code, message: error.message, constraint: error.constraint, detail: error.detail }, {
          code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.', constraint: undefined, detail: undefined,
        });
      }
    }
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE \"operationId\" LIKE 'public-error-%'").get()).n), 0);
    assert.deepEqual(callbackCaught, ['mutation', 'endpoint'].map(kind => ({
      kind,
      code: 'RESOURCE_STORAGE_ERROR',
      message: 'Resource operation could not complete.',
      constraint: undefined,
      detail: undefined,
    })));
  } finally {
    database.adapter.withTransaction = originalWithTransaction;
    await database.shutdown(); await database.close();
  }
});

test('Postgres Job exact claim-row contention returns RESOURCE_BUSY without entering its resource callback', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let releaseHandler, markResourceSettled, resourceCallbacks = 0, resourceOutcome;
  const handlerReady = new Promise(resolve => { releaseHandler = resolve; });
  const resourceSettled = new Promise(resolve => { markResourceSettled = resolve; });
  let markClaimed;
  const claimed = new Promise(resolve => { markClaimed = resolve; });
  const database = await openDevDatabase('postgres-resource-exact-job-nowait', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-exact-job-nowait', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(async ctx => {
      markClaimed();
      await handlerReady;
      try {
        const result = await ctx.resources.run(options({ exactJob: true }), async () => {
          resourceCallbacks += 1;
          return { shouldNotEnter: true };
        });
        resourceOutcome = 'RESOURCE_CALLBACK_ENTERED';
        markResourceSettled();
        return result;
      } catch (error) {
        resourceOutcome = error.code;
        markResourceSettled();
        return { resourceOutcome: error.code };
      }
    }) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })) },
  }, { clock });
  let controller, observer;
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const queued = await runMutation(database, actor, 'enqueue', []);
    assert.equal(queued.ok, true);
    const worker = runCurrentUserJobWorker(database);
    await Promise.race([claimed, new Promise((_, reject) => setTimeout(() => reject(new Error('Job did not claim its exact row before resource entry')), 2_000))]);
    controller = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    observer = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await controller.exec('BEGIN');
    await controller.prepare('SELECT id FROM sporades_jobs WHERE id=? FOR UPDATE').get(queued.data.id);

    let observing = true;
    const observedJobLockWait = (async () => {
      for (let attempt = 0; observing && attempt < 400; attempt += 1) {
        const row = await observer.prepare("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%sporades_jobs%' AND query LIKE '%FOR UPDATE%'").get();
        if (Number(row.n) > 0) return 'job-lock-wait';
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return 'no-job-lock-wait';
    })();
    releaseHandler();
    const contention = await Promise.race([
      resourceSettled.then(() => 'resource-outcome'),
      observedJobLockWait,
    ]);
    observing = false;
    await observedJobLockWait;
    await controller.exec('ROLLBACK');
    await worker;

    assert.equal(contention, 'resource-outcome', 'the exact Job-row NOWAIT acquisition must settle before PostgreSQL reports a waiting Job lock');
    assert.equal(resourceOutcome, 'RESOURCE_BUSY');
    assert.equal(resourceCallbacks, 0);
    assert.equal((await database.adapter.prepare('SELECT status FROM sporades_jobs WHERE id=?').get(queued.data.id)).status, 'succeeded');
  } finally {
    releaseHandler?.();
    await controller?.exec('ROLLBACK').catch(() => {});
    await observer?.close();
    await controller?.close();
    await database.shutdown(); await database.close();
  }
});

test('Postgres rejected resource COMMIT reports a storage failure for Job mutation and endpoint scopes', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const kind of ['job', 'mutation', 'endpoint']) await t.test(kind, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let callbacks = 0; let completedCallbacks = 0;
    const handler = ctx => ctx.resources.run(options(), async scope => {
      callbacks++;
      await scope.db.writes.insert({ value: 'duplicate' });
      await scope.db.writes.insert({ value: 'duplicate' });
      completedCallbacks++;
      return true;
    });
    const database = await openDevDatabase(`postgres-rejected-commit-${kind}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-rejected-commit-${kind}`, services: { database: { engine: 'postgres' } } }, {
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      jobs: { work: job(handler) },
      mutations: {
        enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
        write: mutation(handler),
      },
      endpoints: { write: endpoint({ method: 'POST', path: '/write' }, handler) },
    }, { clock });
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
      await database.adapter.exec('ALTER TABLE writes ADD CONSTRAINT writes_value_deferred UNIQUE (value) DEFERRABLE INITIALLY DEFERRED');
      const session = kind === 'endpoint' ? await resolveAnonymousSession(database, null) : null;
      const execute = async () => {
        if (kind === 'job') {
          const queued = await runMutation(database, actor, 'enqueue', []);
          assert.equal(queued.ok, true);
          await runCurrentUserJobWorker(database);
          const settled = await database.adapter.prepare('SELECT status,failure FROM sporades_jobs WHERE id=?').get(queued.data.id);
          if (settled.status === 'failed') return JSON.parse(settled.failure);
          assert.equal(settled.status, 'succeeded', settled.failure);
          return null;
        }
        if (kind === 'mutation') {
          const result = await runMutation(database, actor, 'write', []);
          return result.ok ? null : result.error;
        }
        return runEndpoint(database, database.endpoints.find(item => item.path === '/write'), new URL('http://capsule.test/write'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} }).then(() => null, error => error);
      };
      const error = await execute();
      assert.equal(callbacks, 1);
      assert.equal(completedCallbacks, 1);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 0);
      assert.deepEqual({ code: error?.code, message: error?.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
      await database.adapter.exec('ALTER TABLE writes DROP CONSTRAINT writes_value_deferred');
      assert.equal(await execute(), null);
      assert.equal(callbacks, 2);
      assert.equal(completedCallbacks, 2);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 2);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
      assert.equal(await execute(), null);
      assert.equal(callbacks, 2);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 2);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
    } finally { await database.shutdown(); await database.close(); }
  });
});

test('Postgres Job reconciles a lost resource COMMIT acknowledgement through its locked receipt without repeating writes', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const target = new URL(postgresTestUrl());
  let dropNextCommit = false;
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    const remove = () => { sockets.delete(client); sockets.delete(upstream); };
    client.once('close', remove); upstream.once('close', remove);
    let receiptForwarded = false; let commitForwarded = false;
    client.on('data', chunk => {
      if (dropNextCommit && isResourceReceiptInsert(chunk.toString('utf8'))) receiptForwarded = true;
      if (dropNextCommit && receiptForwarded && chunk.includes(Buffer.from('COMMIT\0'))) commitForwarded = true;
      upstream.write(chunk);
    });
    upstream.on('data', chunk => {
      if (commitForwarded) { dropNextCommit = false; client.destroy(); upstream.destroy(); return; }
      client.write(chunk);
    });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxiedUrl = new URL(postgresTestUrl()); proxiedUrl.port = String(proxy.address().port);
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let callbacks = 0;
  const database = await openDevDatabase('postgres-resource-commit-loss-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: proxiedUrl.toString() }, { name: 'postgres-resource-commit-loss', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'written-once' }); return { committed: true }; })) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const first = await runMutation(database, actor, 'enqueue', []);
    assert.equal(first.ok, true);
    dropNextCommit = true;
    await runCurrentUserJobWorker(database);
    assert.equal(JSON.parse((await database.adapter.prepare('SELECT failure FROM sporades_jobs WHERE id=?').get(first.data.id)).failure).code, 'RESOURCE_COMMIT_UNKNOWN');
    const replay = await runMutation(database, actor, 'enqueue', []);
    assert.equal(replay.ok, true);
    await runCurrentUserJobWorker(database);
    const replaySettled = await database.adapter.prepare('SELECT status,failure FROM sporades_jobs WHERE id=?').get(replay.data.id);
    assert.equal(replaySettled.status, 'succeeded', replaySettled.failure);
    assert.equal(callbacks, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='written-once'").get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
  } finally {
    await database.shutdown(); await database.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('Postgres mutation resource scopes hold the resource lock and report a lost outer COMMIT acknowledgement', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const target = new URL(postgresTestUrl()); let dropNextCommit = false;
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) }); sockets.add(client); sockets.add(upstream);
    const remove = () => { sockets.delete(client); sockets.delete(upstream); }; client.once('close', remove); upstream.once('close', remove);
    let receiptForwarded = false; let commitForwarded = false;
    client.on('data', chunk => { if (dropNextCommit && isResourceReceiptInsert(chunk.toString('utf8'))) receiptForwarded = true; if (dropNextCommit && receiptForwarded && chunk.includes(Buffer.from('COMMIT\0'))) commitForwarded = true; upstream.write(chunk); });
    upstream.on('data', chunk => { if (commitForwarded) { dropNextCommit = false; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxiedUrl = new URL(postgresTestUrl()); proxiedUrl.port = String(proxy.address().port);
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z'); let callbacks = 0;
  const database = await openDevDatabase('postgres-outer-commit-loss-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: proxiedUrl.toString() }, { name: 'postgres-outer-commit-loss', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'outer-written-once' }); return true; })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    dropNextCommit = true;
    const uncertain = await runMutation(database, actor, 'write', []);
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.error.code, 'RESOURCE_COMMIT_UNKNOWN');
    const replay = await runMutation(database, actor, 'write', []);
    assert.deepEqual(replay, { ok: true, data: true, error: null });
    assert.equal(callbacks, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='outer-written-once'").get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
  } finally {
    await database.shutdown(); await database.close().catch(() => {}); for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve));
  }
});

test('Postgres adapter reconnects on the next query after its socket was discarded and retains recovery after a connection failure', { skip: POSTGRES_SKIP_REASON, timeout: 15_000 }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const target = new URL(postgresTestUrl());
  let dropNextCommit = false; let unavailable = false; let discarded = false;
  let failedConnections = 0; let recoveredConnections = 0; let receiptInserts = 0; let commits = 0;
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    if (unavailable) { failedConnections++; client.destroy(); return; }
    if (discarded) recoveredConnections++;
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    client.once('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
    let receiptForwarded = false; let commitForwarded = false;
    client.on('data', chunk => {
      if (isResourceReceiptInsert(chunk.toString('utf8'))) { receiptInserts++; receiptForwarded = true; }
      if (receiptForwarded && chunk.includes(Buffer.from('COMMIT\0'))) {
        commits++;
        commitForwarded = dropNextCommit;
        receiptForwarded = false;
      }
      upstream.write(chunk);
    });
    upstream.on('data', chunk => {
      if (commitForwarded) {
        dropNextCommit = false; unavailable = true; discarded = true;
        client.destroy(); upstream.destroy(); return;
      }
      client.write(chunk);
    });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxiedUrl = new URL(postgresTestUrl()); proxiedUrl.port = String(proxy.address().port);
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z'); let callbacks = 0;
  const database = await openDevDatabase('postgres-retained-reconnect-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: proxiedUrl.toString() }, { name: 'postgres-retained-reconnect', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'reconnected-once' }); return true; })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const backend = database.adapter.prepare('SELECT pg_backend_pid() AS pid');
    const originalPid = (await backend.get()).pid;
    dropNextCommit = true;
    const uncertain = await runMutation(database, actor, 'write', []);
    assert.equal(uncertain.ok, false);
    assert.deepEqual({ code: uncertain.error.code, message: uncertain.error.message }, { code: 'RESOURCE_COMMIT_UNKNOWN', message: 'Resource operation could not complete.' });
    assert.equal(discarded, true);
    const attemptsBeforeQuery = failedConnections;
    await assert.rejects(backend.get());
    const attemptsAfterQuery = failedConnections;
    unavailable = false;
    const recovered = await Promise.all([backend.get(), backend.get(), backend.get()]);
    assert.equal(attemptsAfterQuery, attemptsBeforeQuery + 1, 'a failed query must attempt a fresh connection');
    assert.equal(recoveredConnections, 1, 'concurrent queries must share a single reconnect');
    assert.notEqual(recovered[0].pid, originalPid);
    assert.ok(recovered.every(row => row.pid === recovered[0].pid));
    assert.equal(callbacks, 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
    assert.deepEqual(await runMutation(database, actor, 'write', []), { ok: true, data: true, error: null });
    assert.equal(callbacks, 1);
    assert.equal(receiptInserts, 1);
    assert.equal(commits, 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
  } finally {
    unavailable = false;
    await database.shutdown(); await database.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('Postgres endpoint resource scopes reconcile a lost outer COMMIT acknowledgement without replaying the callback', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const target = new URL(postgresTestUrl()); let dropNextCommit = false; let receiptFaults = 0;
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) }); sockets.add(client); sockets.add(upstream);
    const remove = () => { sockets.delete(client); sockets.delete(upstream); }; client.once('close', remove); upstream.once('close', remove);
    let receiptForwarded = false; let commitForwarded = false;
    client.on('data', chunk => {
      if (dropNextCommit && isResourceReceiptInsert(chunk.toString('utf8'))) { receiptForwarded = true; receiptFaults++; }
      if (dropNextCommit && receiptForwarded && chunk.includes(Buffer.from('COMMIT\0'))) commitForwarded = true;
      upstream.write(chunk);
    });
    upstream.on('data', chunk => { if (commitForwarded) { dropNextCommit = false; client.destroy(); upstream.destroy(); return; } client.write(chunk); });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxiedUrl = new URL(postgresTestUrl()); proxiedUrl.port = String(proxy.address().port);
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z'); let callbacks = 0;
  const database = await openDevDatabase('postgres-endpoint-commit-loss-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: proxiedUrl.toString() }, { name: 'postgres-endpoint-commit-loss', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    endpoints: { write: endpoint({ method: 'POST', path: '/write' }, ctx => ctx.resources.run(options(), async scope => { callbacks++; await scope.db.writes.insert({ value: 'endpoint-written-once' }); return true; })) },
  }, { clock });
  let request;
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const session = await resolveAnonymousSession(database, null);
    request = { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} };
    dropNextCommit = true;
    const route = database.endpoints.find(item => item.path === '/write');
    const uncertain = await runEndpoint(database, route, new URL('http://capsule.test/write'), request).then(() => null, error => error);
    assert.equal(uncertain.code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal(await runEndpoint(database, route, new URL('http://capsule.test/write'), request), true);
    assert.equal(callbacks, 1);
    assert.equal(receiptFaults, 1, 'the endpoint loss proxy observed the quoted receipt insert');
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='endpoint-written-once'").get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
  } finally {
    await database.shutdown(); await database.close().catch(() => {}); for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve));
  }
});

test('Postgres resource readiness rejects malformed relations and accepts correctly-shaped tables', { skip: POSTGRES_SKIP_REASON }, async t => {
  const cases = [
    ...['locks', 'receipts'].flatMap(tableName => ['unique', 'check', 'foreign-key'].map(constraint => ({ tableName, constraint }))),
    { tableName: 'locks', constraint: 'standalone-unique-index' },
    ...['locks', 'receipts'].map(tableName => ({ tableName, persistence: 'unlogged' })),
    ...['correct', 'fresh', 'folded-legacy'].map(shape => ({ shape })),
  ];
  for (const { tableName, constraint, persistence, shape } of cases) await t.test(shape ?? `${tableName} ${constraint ?? persistence}`, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await resetPostgresSchema(reset, ['anchors', 'writes']);
      await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    } finally { await reset.close(); }
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let callbacks = 0;
    const observed = [];
    const database = await openDevDatabase('postgres-resource-schema-constraints', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-schema-constraints', services: { database: { engine: 'postgres' } } }, {
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      mutations: { write: mutation(async (ctx, id) => {
        try {
          return await ctx.resources.run({ ...options(), resource: { table: 'anchors', id } }, async scope => {
            callbacks++;
            await scope.db.writes.insert({ value: id });
            return { committed: id };
          });
        } catch (error) {
          observed.push({ code: error.code, message: error.message, constraint: error.constraint, detail: error.detail });
          throw error;
        }
      }) },
    }, { clock });
    try {
      await database.init();
      for (const id of ['anchor-one', 'anchor-two']) await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run(id, clock.now().toISOString(), clock.now().toISOString(), 'ready');
      if (shape !== 'fresh') {
        const column = name => shape === 'folded-legacy' ? name : `"${name}"`;
        await database.adapter.exec(`CREATE ${persistence === 'unlogged' && tableName === 'locks' ? 'UNLOGGED ' : ''}TABLE sporades_resource_locks (${column('resourceTable')} TEXT NOT NULL, ${column('resourceId')} TEXT NOT NULL, PRIMARY KEY (${column('resourceTable')}, ${column('resourceId')}))`);
        await database.adapter.exec(`CREATE ${persistence === 'unlogged' && tableName === 'receipts' ? 'UNLOGGED ' : ''}TABLE sporades_resource_receipts (${['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt'].map(name => `${column(name)} TEXT NOT NULL`).join(', ')}, PRIMARY KEY (${column('resourceTable')}, ${column('resourceId')}, ${column('operationId')}))`);
      }
      if (constraint) {
        const definition = constraint === 'unique' ? 'UNIQUE ("resourceTable")'
          : constraint === 'check' ? `CHECK ("resourceId" <> 'anchor-two')`
          : 'FOREIGN KEY ("resourceId") REFERENCES anchors(id)';
        if (constraint === 'standalone-unique-index') {
          await database.adapter.exec('CREATE UNIQUE INDEX unexpected_resource_unique_index ON sporades_resource_locks ("resourceTable")');
        } else await database.adapter.exec(`ALTER TABLE sporades_resource_${tableName} ADD CONSTRAINT unexpected_resource_constraint ${definition}`);
      }
      for (const id of ['anchor-one', 'anchor-two']) {
        const result = await runMutation(database, actor, 'write', [id]);
        if (constraint || persistence) {
          assert.equal(result.ok, false, 'the readiness check rejects a malformed runtime table before its first write');
          assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
        } else assert.deepEqual(result, { ok: true, data: { committed: id }, error: null });
      }
      const malformed = Boolean(constraint || persistence);
      assert.equal(callbacks, malformed ? 0 : 2);
      assert.deepEqual(observed, malformed ? Array.from({ length: 2 }, () => ({ code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.', constraint: undefined, detail: undefined })) : []);
      for (const name of ['writes', 'sporades_resource_locks', 'sporades_resource_receipts']) {
        assert.equal(Number((await database.adapter.prepare(`SELECT count(*) n FROM ${name}`).get()).n), malformed ? 0 : 2);
      }
    } finally { await database.shutdown(); await database.close(); }
  });
});

test('Postgres resource readiness rejects user database mechanisms that can remove a resource receipt', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const mode of ['before-suppress', 'after-delete', 'rewrite-instead']) await t.test(mode, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await resetPostgresSchema(reset, ['anchors', 'writes']);
      await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
      await reset.exec('CREATE TABLE sporades_resource_locks ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId"))');
      await reset.exec('CREATE TABLE sporades_resource_receipts ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "operationId" TEXT NOT NULL, "inputDigest" TEXT NOT NULL, "actorDigest" TEXT NOT NULL, "resultJson" TEXT NOT NULL, "intentIdsJson" TEXT NOT NULL, "committedAt" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId", "operationId"))');
      if (mode === 'rewrite-instead') {
        await reset.exec('CREATE RULE alter_resource_receipt AS ON INSERT TO sporades_resource_receipts DO INSTEAD NOTHING');
      } else {
        const body = mode === 'before-suppress'
          ? 'BEGIN RETURN NULL; END'
          : 'BEGIN DELETE FROM sporades_resource_receipts WHERE "resourceTable"=NEW."resourceTable" AND "resourceId"=NEW."resourceId" AND "operationId"=NEW."operationId"; RETURN NEW; END';
        await reset.exec(`CREATE FUNCTION alter_resource_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`);
        await reset.exec(`CREATE TRIGGER alter_resource_receipt ${mode === 'before-suppress' ? 'BEFORE' : 'AFTER'} INSERT ON sporades_resource_receipts FOR EACH ROW EXECUTE FUNCTION alter_resource_receipt()`);
      }
    } finally { await reset.close(); }
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let callbacks = 0;
    const database = await openDevDatabase(`postgres-resource-receipt-trigger-${mode}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-resource-receipt-trigger-${mode}`, services: { database: { engine: 'postgres' } } }, {
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      mutations: { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: `${mode}-receipt` }, async scope => {
        callbacks++;
        await scope.db.writes.insert({ value: 'must-not-commit' });
        return { committed: true };
      })) },
    }, { clock });
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'ready');
      const result = await runMutation(database, actor, 'write', []);
      assert.equal(result.ok, false);
      assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
      assert.equal(callbacks, 0, 'schema readiness rejects the trigger before protected work starts');
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 0);
    } finally {
      try {
        await database.adapter.exec('DROP RULE IF EXISTS alter_resource_receipt ON sporades_resource_receipts');
        await database.adapter.exec('DROP FUNCTION IF EXISTS alter_resource_receipt() CASCADE');
      }
      finally { await database.shutdown(); await database.close(); }
    }
  });
});

test('Postgres resource readiness rejects forced row security that can hide a committed receipt', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try {
    await resetPostgresSchema(reset, ['anchors', 'writes']);
    await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    await reset.exec('DROP ROLE IF EXISTS sporades_resource_rls_reader');
    await reset.exec('CREATE TABLE sporades_resource_locks ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId"))');
    await reset.exec('CREATE TABLE sporades_resource_receipts ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "operationId" TEXT NOT NULL, "inputDigest" TEXT NOT NULL, "actorDigest" TEXT NOT NULL, "resultJson" TEXT NOT NULL, "intentIdsJson" TEXT NOT NULL, "committedAt" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId", "operationId"))');
    await reset.exec('ALTER TABLE sporades_resource_receipts ENABLE ROW LEVEL SECURITY');
    await reset.exec('ALTER TABLE sporades_resource_receipts FORCE ROW LEVEL SECURITY');
    await reset.exec('CREATE POLICY hide_resource_receipt_reads ON sporades_resource_receipts FOR SELECT USING (false)');
    await reset.exec('CREATE POLICY allow_resource_receipt_inserts ON sporades_resource_receipts FOR INSERT WITH CHECK (true)');
    await reset.exec('CREATE ROLE sporades_resource_rls_reader NOLOGIN');
    await reset.exec('GRANT SELECT ON sporades_resource_receipts TO sporades_resource_rls_reader');
    await reset.prepare('INSERT INTO sporades_resource_receipts VALUES (?,?,?,?,?,?,?,?)').run('anchors', 'anchor', 'hidden-by-rls', 'input', 'actor', '{}', '[]', '2030-01-01T00:00:00.000Z');
    await reset.exec('SET ROLE sporades_resource_rls_reader');
    try {
      assert.equal((await reset.prepare("SELECT row_security_active('sporades_resource_receipts') AS active").get()).active, true);
      assert.equal(Number((await reset.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 0, 'forced row security hides the committed receipt from a non-bypass role');
    } finally { await reset.exec('RESET ROLE'); }
  } finally { await reset.close(); }
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let callbacks = 0;
  const database = await openDevDatabase('postgres-resource-receipt-rls', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-receipt-rls', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'forced-rls-receipt' }, async scope => {
      callbacks++;
      await scope.db.writes.insert({ value: 'must-not-commit' });
      return { committed: true };
    })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'ready');
    const result = await runMutation(database, actor, 'write', []);
    assert.equal(result.ok, false);
    assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
    assert.equal(callbacks, 0, 'schema readiness rejects receipt-hiding row security before protected work starts');
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE "operationId"=?').get('forced-rls-receipt')).n), 0);
  } finally {
    try {
      await database.adapter.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
      await database.adapter.exec('DROP ROLE IF EXISTS sporades_resource_rls_reader');
    } finally { await database.shutdown(); await database.close(); }
  }
});

test('Postgres resource readiness rejects case-folding operation identity collation', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try {
    await resetPostgresSchema(reset, ['anchors', 'writes']);
    await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    await reset.exec('DROP COLLATION IF EXISTS sporades_resource_casefold');
    await reset.exec("CREATE COLLATION sporades_resource_casefold (provider = icu, locale = 'und-u-ks-level2', deterministic = false)");
    await reset.exec('CREATE TABLE sporades_resource_locks ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId"))');
    await reset.exec('CREATE TABLE sporades_resource_receipts ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "operationId" TEXT COLLATE sporades_resource_casefold NOT NULL, "inputDigest" TEXT NOT NULL, "actorDigest" TEXT NOT NULL, "resultJson" TEXT NOT NULL, "intentIdsJson" TEXT NOT NULL, "committedAt" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId", "operationId"))');
    const identity = await reset.prepare("SELECT 'CaseFoldOperation' COLLATE sporades_resource_casefold = 'casefoldoperation' COLLATE sporades_resource_casefold AS collides").get();
    assert.equal(identity.collides, true, 'the seeded primary-key collation folds distinct operation IDs together');
  } finally { await reset.close(); }
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let callbacks = 0;
  const database = await openDevDatabase('postgres-resource-receipt-collation', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-receipt-collation', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'CaseFoldOperation' }, async scope => {
      callbacks++;
      await scope.db.writes.insert({ value: 'must-not-commit' });
      return { committed: true };
    })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'ready');
    const result = await runMutation(database, actor, 'write', []);
    assert.equal(result.ok, false);
    assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
    assert.equal(callbacks, 0, 'schema readiness rejects case-folding receipt identity before protected work starts');
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM writes').get()).n), 0);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 0);
  } finally {
    try {
      await database.adapter.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
      await database.adapter.exec('DROP COLLATION IF EXISTS sporades_resource_casefold');
    } finally { await database.shutdown(); await database.close(); }
  }
});

test('Postgres resource readiness scopes primary-key columns to the checked table', { skip: POSTGRES_SKIP_REASON }, async t => {
  for (const tableName of ['locks', 'receipts']) for (const shape of ['correct', 'wrong-primary-key']) await t.test(`${tableName} ${shape}`, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await resetPostgresSchema(reset, ['resource_catalog_other', 'anchors', 'writes']);
      await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    } finally { await reset.close(); }
    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let callbacks = 0;
    const database = await openDevDatabase('postgres-resource-catalog-table', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-catalog-table', services: { database: { engine: 'postgres' } } }, {
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      mutations: { write: mutation(ctx => ctx.resources.run(options(), async scope => {
        callbacks++;
        await scope.db.writes.insert({ value: 'table-scoped' });
        return { committed: true };
      })) },
    }, { clock });
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'ready');
      await database.adapter.exec('CREATE TABLE sporades_resource_locks ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId"))');
      await database.adapter.exec('CREATE TABLE sporades_resource_receipts ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "operationId" TEXT NOT NULL, "inputDigest" TEXT NOT NULL, "actorDigest" TEXT NOT NULL, "resultJson" TEXT NOT NULL, "intentIdsJson" TEXT NOT NULL, "committedAt" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId", "operationId"))');
      const primaryKey = tableName === 'locks' ? ['resourceTable', 'resourceId'] : ['resourceTable', 'resourceId', 'operationId'];
      if (shape === 'wrong-primary-key') {
        await database.adapter.exec(`ALTER TABLE sporades_resource_${tableName} DROP CONSTRAINT sporades_resource_${tableName}_pkey`);
        await database.adapter.exec(`ALTER TABLE sporades_resource_${tableName} ADD CONSTRAINT sporades_resource_${tableName}_pkey PRIMARY KEY (${[...primaryKey].reverse().map(name => `"${name}"`).join(', ')})`);
      }
      const foreignColumns = primaryKey.map((_, index) => `other_${index}`);
      await database.adapter.exec(`CREATE TABLE resource_catalog_other (${foreignColumns.map(name => `${name} TEXT NOT NULL`).join(', ')}, CONSTRAINT sporades_resource_${tableName}_pkey FOREIGN KEY (${foreignColumns.join(', ')}) REFERENCES sporades_resource_${tableName} (${primaryKey.map(name => `"${name}"`).join(', ')}))`);
      const result = await runMutation(database, actor, 'write', []);
      if (shape === 'correct') {
        assert.deepEqual(result, { ok: true, data: { committed: true }, error: null });
      } else {
        assert.equal(result.ok, false);
        assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
      }
      assert.equal(callbacks, shape === 'correct' ? 1 : 0);
      for (const name of ['writes', 'sporades_resource_locks', 'sporades_resource_receipts']) {
        assert.equal(Number((await database.adapter.prepare(`SELECT count(*) n FROM ${name}`).get()).n), shape === 'correct' ? 1 : 0);
      }
    } finally {
      try { await database.adapter.exec('DROP TABLE IF EXISTS resource_catalog_other, sporades_resource_receipts, sporades_resource_locks'); }
      finally { await database.shutdown(); await database.close(); }
    }
  });
});

test('Postgres public mutation and endpoint bootstrap fence repeated fresh and folded-legacy races', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try {
    for (const phase of ['fresh', 'folded-legacy']) for (let attempt = 0; attempt < 4; attempt++) {
      await resetPostgresSchema(reset, ['anchors', 'writes']);
      await reset.exec('DROP TABLE IF EXISTS "sporades_resource_receipts", "sporades_resource_locks"');
      const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
      let release; let markEntered;
      const entered = new Promise(resolve => { markEntered = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const makeDatabase = async (name, kind) => {
        const database = await openDevDatabase(name, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name, services: { database: { engine: 'postgres' } } }, {
          schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
          mutations: kind === 'mutation' ? { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: `outer-bootstrap-${phase}-${attempt}` }, async scope => { markEntered(); await held; await scope.db.writes.insert({ value: `outer-${phase}-${attempt}` }); return true; })) } : {},
          endpoints: kind === 'endpoint' ? { write: endpoint({ method: 'POST', path: '/write' }, ctx => ctx.resources.run({ ...options(), operationId: `outer-bootstrap-${phase}-${attempt}` }, async scope => { markEntered(); await held; await scope.db.writes.insert({ value: `outer-${phase}-${attempt}` }); return true; })) } : {},
        }, { clock });
        await database.init();
        return database;
      };
      const mutationDatabase = await makeDatabase(`postgres-public-bootstrap-mutation-${phase}-${attempt}`, 'mutation');
      const endpointDatabase = await makeDatabase(`postgres-public-bootstrap-endpoint-${phase}-${attempt}`, 'endpoint');
      try {
        await mutationDatabase.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'ready');
        if (phase === 'folded-legacy') {
          await reset.exec('CREATE TABLE sporades_resource_locks (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId))');
          await reset.exec('CREATE TABLE sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))');
          await reset.prepare('INSERT INTO sporades_resource_receipts VALUES (?,?,?,?,?,?,?,?)').run('legacy-table', 'legacy-id', 'legacy-operation', 'legacy-input', 'legacy-actor', '{"legacy":true}', '[]', '2030-01-01T00:00:00.000Z');
        }
        const session = await resolveAnonymousSession(endpointDatabase, null);
        const mutationResult = runMutation(mutationDatabase, actor, 'write', []);
        const endpointResult = runEndpoint(endpointDatabase, endpointDatabase.endpoints.find(item => item.path === '/write'), new URL('http://capsule.test/write'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error(`${phase} attempt ${attempt}: no public owner acquired`)), 2_000))]);
        await new Promise(resolve => setTimeout(resolve, 40));
        release();
        const [mutation, endpointResultValue] = await Promise.all([mutationResult, endpointResult]);
        const outcomes = [mutation.ok ? { ok: true } : { ok: false, error: mutation.error }, endpointResultValue];
        assert.equal(outcomes.filter(outcome => outcome.ok).length, 1, `${phase} attempt ${attempt}: exactly one public owner enters`);
        const error = outcomes.find(outcome => !outcome.ok).error;
        assert.equal(error.code, 'RESOURCE_BUSY', `${phase} attempt ${attempt}: public contender gets bounded contention rather than raw DDL`);
        assert.notEqual(error.code, '23505');
        if (phase === 'folded-legacy') {
          const legacy = await reset.prepare('SELECT "resultJson" FROM "sporades_resource_receipts" WHERE "resourceTable"=? AND "resourceId"=? AND "operationId"=?').get('legacy-table', 'legacy-id', 'legacy-operation');
          assert.equal(legacy.resultJson, '{"legacy":true}', 'legacy receipt identity and payload survive public bootstrap migration');
        }
      } finally { release?.(); await mutationDatabase.shutdown(); await mutationDatabase.close(); await endpointDatabase.shutdown(); await endpointDatabase.close(); }
    }
  } finally { await reset.close(); }
});

test('Postgres public mutation and endpoint resource paths preserve declared receipt columns and replay exactly once', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let mutationCallbacks = 0;
  let endpointCallbacks = 0;
  let jobCallbacks = 0;
  const database = await openDevDatabase('postgres-public-outer-resource-identifiers', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-public-outer-resource-identifiers', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run({ ...options(), operationId: 'public-job' }, async scope => { jobCallbacks++; await scope.db.writes.insert({ value: 'job-once' }); return { path: 'job' }; })) },
    mutations: {
      write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'public-mutation' }, async scope => { mutationCallbacks++; await scope.db.writes.insert({ value: 'mutation-once' }); return { path: 'mutation' }; })),
      enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
    },
    endpoints: { write: endpoint({ method: 'POST', path: '/public-resource-write' }, ctx => ctx.resources.run({ ...options(), operationId: 'public-endpoint' }, async scope => { endpointCallbacks++; await scope.db.writes.insert({ value: 'endpoint-once' }); return { path: 'endpoint' }; })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    assert.deepEqual(await runMutation(database, actor, 'write', []), { ok: true, data: { path: 'mutation' }, error: null });
    assert.deepEqual(await runMutation(database, actor, 'write', []), { ok: true, data: { path: 'mutation' }, error: null });
    const firstJob = await runMutation(database, actor, 'enqueue', []);
    assert.equal(firstJob.ok, true);
    await runCurrentUserJobWorker(database);
    const replayJob = await runMutation(database, actor, 'enqueue', []);
    assert.equal(replayJob.ok, true);
    await runCurrentUserJobWorker(database);
    const session = await resolveAnonymousSession(database, null);
    const request = { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} };
    const route = database.endpoints.find(item => item.path === '/public-resource-write');
    assert.deepEqual(await runEndpoint(database, route, new URL('http://capsule.test/public-resource-write'), request), { path: 'endpoint' });
    assert.deepEqual(await runEndpoint(database, route, new URL('http://capsule.test/public-resource-write'), request), { path: 'endpoint' });
    assert.equal(mutationCallbacks, 1);
    assert.equal(endpointCallbacks, 1);
    assert.equal(jobCallbacks, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value IN ('mutation-once','job-once','endpoint-once')").get()).n), 3);
    for (const [tableName, expectedColumns] of Object.entries({
      sporades_resource_locks: ['resourceTable', 'resourceId'],
      sporades_resource_receipts: ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt'],
    })) {
      const actualColumns = (await database.adapter.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position").all(tableName)).map(row => row.column_name);
      assert.deepEqual(actualColumns, expectedColumns, `${tableName} must retain its declared PostgreSQL camelCase columns`);
    }
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 3);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres Job-first resource bootstrap shares quoted receipt columns with public endpoint and mutation replays', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const callbacks = { job: 0, endpoint: 0, mutation: 0 };
  const database = await openDevDatabase('postgres-job-first-resource-identifiers', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-job-first-resource-identifiers', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run({ ...options(), operationId: 'job-first' }, async scope => { callbacks.job++; await scope.db.writes.insert({ value: 'job-first-once' }); return { path: 'job' }; })) },
    mutations: {
      enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
      write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'mutation-after-job' }, async scope => { callbacks.mutation++; await scope.db.writes.insert({ value: 'mutation-after-job-once' }); return { path: 'mutation' }; })),
    },
    endpoints: { write: endpoint({ method: 'POST', path: '/endpoint-after-job' }, ctx => ctx.resources.run({ ...options(), operationId: 'endpoint-after-job' }, async scope => { callbacks.endpoint++; await scope.db.writes.insert({ value: 'endpoint-after-job-once' }); return { path: 'endpoint' }; })) },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const queued = await runMutation(database, actor, 'enqueue', []);
      assert.equal(queued.ok, true);
      await runCurrentUserJobWorker(database);
    }
    const session = await resolveAnonymousSession(database, null);
    const request = { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} };
    const route = database.endpoints.find(item => item.path === '/endpoint-after-job');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await runEndpoint(database, route, new URL('http://capsule.test/endpoint-after-job'), request), { path: 'endpoint' });
      assert.deepEqual(await runMutation(database, actor, 'write', []), { ok: true, data: { path: 'mutation' }, error: null });
    }
    assert.deepEqual(callbacks, { job: 1, endpoint: 1, mutation: 1 });
    assert.deepEqual((await database.adapter.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sporades_resource_receipts' ORDER BY ordinal_position").all()).map(row => row.column_name), ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt']);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 3);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres public resource mutation upgrades folded lock and receipt columns before replay', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  // This is the persisted pre-ADR-0039 shape: only this fixture deliberately
  // leaves identifiers unquoted so the public path must perform the upgrade.
  await reset.exec('CREATE TABLE sporades_resource_locks (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId))');
  await reset.exec('CREATE TABLE sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const callbacks = { mutation: 0, job: 0 };
  const database = await openDevDatabase('postgres-public-resource-folded-upgrade', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-public-resource-folded-upgrade', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run({ ...options(), operationId: 'folded-upgrade-job' }, async scope => { callbacks.job++; await scope.db.writes.insert({ value: 'folded-upgraded-job-once' }); return true; })) },
    mutations: {
      write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'folded-upgrade' }, async scope => { callbacks.mutation++; await scope.db.writes.insert({ value: 'folded-upgraded-once' }); return true; })),
      enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
    },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    assert.equal((await runMutation(database, actor, 'write', [])).ok, true);
    assert.equal((await runMutation(database, actor, 'write', [])).ok, true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const queued = await runMutation(database, actor, 'enqueue', []);
      assert.equal(queued.ok, true);
      await runCurrentUserJobWorker(database);
    }
    assert.deepEqual(callbacks, { mutation: 1, job: 1 });
    for (const [tableName, expectedColumns] of Object.entries({
      sporades_resource_locks: ['resourceTable', 'resourceId'],
      sporades_resource_receipts: ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt'],
    })) assert.deepEqual((await database.adapter.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position").all(tableName)).map(row => row.column_name), expectedColumns);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 2);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres Job-first resource replay upgrades seeded folded locks and receipts without losing rows', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  await reset.exec('CREATE TABLE sporades_resource_locks (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId))');
  await reset.exec('CREATE TABLE sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))');
  await reset.prepare("INSERT INTO sporades_resource_receipts VALUES (?,?,?,?,?,?,?,?)").run('legacy-table', 'legacy-id', 'legacy-op', 'legacy-digest', 'legacy-actor', '{}', '[]', '2030-01-01T00:00:00.000Z');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const callbacks = { job: 0, mutation: 0 };
  const database = await openDevDatabase('postgres-job-first-folded-resource-upgrade', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-job-first-folded-resource-upgrade', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run({ ...options(), operationId: 'legacy-job' }, async scope => { callbacks.job++; await scope.db.writes.insert({ value: 'legacy-job-once' }); return true; })) },
    mutations: {
      enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
      write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'legacy-mutation' }, async scope => { callbacks.mutation++; await scope.db.writes.insert({ value: 'legacy-mutation-once' }); return true; })),
    },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const queued = await runMutation(database, actor, 'enqueue', []);
      assert.equal(queued.ok, true);
      await runCurrentUserJobWorker(database);
      assert.equal((await runMutation(database, actor, 'write', [])).ok, true);
    }
    assert.deepEqual(callbacks, { job: 1, mutation: 1 });
    assert.deepEqual(await database.adapter.prepare('SELECT "resourceTable","resourceId","operationId" FROM sporades_resource_receipts WHERE "operationId"=?').get('legacy-op'), { resourceTable: 'legacy-table', resourceId: 'legacy-id', operationId: 'legacy-op' });
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 3);
    assert.deepEqual((await database.adapter.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sporades_resource_locks' ORDER BY ordinal_position").all()).map(row => row.column_name), ['resourceTable', 'resourceId']);
  } finally { await database.shutdown(); await database.close(); }
});

test('Postgres outer replay preserves an actual legacy folded receipt payload without rerunning its callback', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const definition = (callback) => ({
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'legacy-payload-replay' }, callback)) },
  });
  const open = (name, callback) => openDevDatabase(name, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name, services: { database: { engine: 'postgres' } } }, definition(callback), { clock });
  const first = await open('postgres-legacy-resource-payload-first', async scope => { await scope.db.writes.insert({ value: 'legacy-payload-once' }); return { retained: 'payload' }; });
  try {
    await first.init();
    await first.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    assert.deepEqual(await runMutation(first, actor, 'write', []), { ok: true, data: { retained: 'payload' }, error: null });
  } finally { await first.shutdown(); await first.close(); }
  const fold = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try {
    await fold.exec('ALTER TABLE sporades_resource_locks RENAME COLUMN "resourceTable" TO resourcetable');
    await fold.exec('ALTER TABLE sporades_resource_locks RENAME COLUMN "resourceId" TO resourceid');
    for (const column of ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt']) await fold.exec(`ALTER TABLE sporades_resource_receipts RENAME COLUMN "${column}" TO ${column.toLowerCase()}`);
  } finally { await fold.close(); }
  let replayCallbacks = 0;
  const restarted = await open('postgres-legacy-resource-payload-restarted', async () => { replayCallbacks++; return { unexpected: true }; });
  try {
    await restarted.init();
    assert.deepEqual(await runMutation(restarted, actor, 'write', []), { ok: true, data: { retained: 'payload' }, error: null });
    assert.equal(replayCallbacks, 0);
    assert.equal(Number((await restarted.adapter.prepare("SELECT count(*) n FROM writes WHERE value='legacy-payload-once'").get()).n), 1);
    assert.deepEqual((await restarted.adapter.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sporades_resource_receipts' ORDER BY ordinal_position").all()).map(row => row.column_name), ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt']);
  } finally { await restarted.shutdown(); await restarted.close(); }
});

test('Postgres outer folded receipt migration waits on its explicit schema lock only through the resource timeout', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']);
  await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
  await reset.exec('CREATE TABLE "sporades_resource_locks" ("resourceTable" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY ("resourceTable", "resourceId"))');
  await reset.exec('CREATE TABLE sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const database = await openDevDatabase('postgres-folded-receipt-migration-lock', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-folded-receipt-migration-lock', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: { write: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'receipt-migration-lock' }, async scope => { await scope.db.writes.insert({ value: 'after-migration-lock' }); return true; })) },
  }, { clock });
  const blocker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    await blocker.exec('BEGIN');
    await blocker.exec('LOCK TABLE sporades_resource_receipts IN ACCESS EXCLUSIVE MODE');
    const blocked = await runMutation(database, actor, 'write', []);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'RESOURCE_BUSY');
    await blocker.exec('ROLLBACK');
    assert.equal((await runMutation(database, actor, 'write', [])).ok, true);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='after-migration-lock'").get()).n), 1);
  } finally { await blocker.exec('ROLLBACK').catch(() => {}); await blocker.close(); await database.shutdown(); await database.close(); }
});

test('Postgres Job backend loss after its final claim check rolls back write and receipt before another owner acquires', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let oldScoped;
  let retained;
  let parent;
  const database = await openDevDatabase('postgres-resource-loss-test', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-loss', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => {
      parent = ctx.db.writes;
      return ctx.resources.run(options(), async scope => {
        oldScoped = scope.db.writes;
        retained = scope.db.writes;
        await scope.db.writes.insert({ value: 'must-rollback-after-backend-loss' });
        return { committed: true };
      });
    }) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })) },
  }, { clock });
  let release;
  let markFinal;
  const finalChecked = new Promise((resolve) => { markFinal = resolve; });
  const releaseCommit = new Promise((resolve) => { release = resolve; });
  let backendId;
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const original = database.adapter.withResourceTransaction.bind(database.adapter);
    database.adapter.withResourceTransaction = async (callback, beforeCommit, resource) => await original(callback, async transaction => {
      await beforeCommit(transaction);
      backendId = Number((await transaction.prepare('SELECT pg_backend_pid() AS pid').get()).pid);
      markFinal();
      await releaseCommit;
    }, resource);
    const queued = await runMutation(database, actor, 'enqueue', []);
    const worker = runCurrentUserJobWorker(database);
    await Promise.race([finalChecked, new Promise((_, reject) => setTimeout(() => reject(new Error('Job did not reach final PostgreSQL claim check')), 2_000))]);
    const controller = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    const successor = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      assert.equal((await controller.prepare('SELECT pg_terminate_backend(?) AS terminated').get(backendId)).terminated, true);
      let releaseSuccessor;
      let markSuccessorAcquired;
      const successorAcquired = new Promise(resolve => { markSuccessorAcquired = resolve; });
      const successorRelease = new Promise(resolve => { releaseSuccessor = resolve; });
      const successorOwnership = successor.withResourceTransaction(async () => {
        markSuccessorAcquired();
        await successorRelease;
      }, undefined, { table: 'anchors', id: 'anchor' });
      await Promise.race([successorAcquired, new Promise((_, reject) => setTimeout(() => reject(new Error('B did not acquire after A backend termination')), 2_000))]);
      // B now owns the released engine lock. Every A capability—an old scoped
      // table, a retained alias, and parent re-entry—must fail before it can
      // issue a stale protected write.
      assert.throws(() => oldScoped.insert({ value: 'old-scoped-after-loss' }), { code: 'RESOURCE_SCOPE_INACTIVE' });
      assert.throws(() => retained.insert({ value: 'retained-before-loss' }), { code: 'RESOURCE_SCOPE_INACTIVE' });
      assert.throws(() => parent.insert({ value: 'parent-after-loss' }), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });

      // A fresh session is a real reconnect boundary, not another method
      // derived from A's dead scope. It has a new backend PID but cannot enter
      // B's resource interval, so its callback cannot make a stale write,
      // receipt, or intent.
      const reconnected = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      try {
        const reconnectedBackendId = Number((await reconnected.prepare('SELECT pg_backend_pid() AS pid').get()).pid);
        assert.notEqual(reconnectedBackendId, backendId);
        let staleCallbackEntered = false;
        await assert.rejects(reconnected.withResourceTransaction(async transaction => {
          staleCallbackEntered = true;
          await transaction.prepare("INSERT INTO writes (id, \"createdAt\", \"updatedAt\", value) VALUES ('newly-reconnected-after-loss','2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','newly-reconnected-after-loss')").run();
          await transaction.prepare("INSERT INTO sporades_resource_receipts VALUES ('anchors','anchor','newly-reconnected-after-loss','input','actor','{}','[]','2030-01-01T00:00:00.000Z')").run();
        }, undefined, { table: 'anchors', id: 'anchor' }), { code: 'RESOURCE_BUSY' });
        assert.equal(staleCallbackEntered, false);
      } finally { await reconnected.close(); }
      releaseSuccessor();
      await successorOwnership;
    } finally { await controller.close(); await successor.close(); }
    release();
    await worker;
    assert.equal((await database.adapter.prepare('SELECT status FROM sporades_jobs WHERE id=?').get(queued.data.id)).status, 'failed');
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='must-rollback-after-backend-loss'").get()).n), 0);
    assert.equal((await database.adapter.prepare("SELECT to_regclass('sporades_resource_receipts') AS receipt_table").get()).receipt_table, 'sporades_resource_receipts');
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM "sporades_resource_receipts"').get()).n), 0);
    assert.equal((await database.adapter.prepare("SELECT to_regclass('sporades_resource_intents') AS intent_table").get()).intent_table, null);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value IN ('old-scoped-after-loss','retained-before-loss','parent-after-loss','newly-reconnected-after-loss')").get()).n), 0);
  } finally { release?.(); await database.shutdown(); await database.close(); }
});

test('Postgres Job resource authority locks cancellation and recovery through exact claim settlement', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors', 'writes']); await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks'); await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  let entered, release;
  const enteredScope = new Promise(resolve => { entered = resolve; });
  const releaseScope = new Promise(resolve => { release = resolve; });
  const database = await openDevDatabase('postgres-resource-claim-conflict', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: 'postgres-resource-claim-conflict', services: { database: { engine: 'postgres' } } }, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    jobs: { work: job(ctx => ctx.resources.run(options(), async scope => {
      await scope.db.writes.insert({ value: 'claim-owner' }); entered(); await releaseScope; return { committed: true };
    })) },
    mutations: {
      enqueue: mutation(ctx => ctx.jobs.enqueue('work', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
      cancel: mutation((ctx, id) => ctx.jobs.cancel(id)),
    },
  }, { clock });
  try {
    await database.init();
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    const queued = await runMutation(database, actor, 'enqueue', []);
    assert.equal(queued.ok, true);
    const worker = runCurrentUserJobWorker(database);
    await Promise.race([enteredScope, new Promise((_, reject) => setTimeout(() => reject(new Error('PostgreSQL Job did not enter its resource scope')), 2_000))]);
    const claim = await database.adapter.prepare('SELECT status,"claimToken" FROM sporades_jobs WHERE id=?').get(queued.data.id);
    assert.equal(claim.status, 'running'); assert.equal(typeof claim.claimToken, 'string');
    const controller = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await controller.exec("SET lock_timeout = '50ms'");
      const cancellation = runMutation(database, actor, 'cancel', [queued.data.id]);
      assert.equal(await Promise.race([cancellation.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 75))]), 'pending');
      const recovery = controller.prepare('UPDATE sporades_jobs SET status=\'queued\' WHERE id=? AND status=\'running\' AND "claimToken"=?').run(queued.data.id, claim.claimToken);
      await assert.rejects(recovery, { code: '55P03' });
      release();
      assert.equal((await cancellation).ok, true);
    } finally { await controller.close(); }
    await worker;
    const settled = await database.adapter.prepare('SELECT status,"claimToken","attemptHistory" FROM sporades_jobs WHERE id=?').get(queued.data.id);
    assert.equal(settled.status, 'cancelled'); assert.equal(settled.claimToken, null);
    assert.equal(JSON.parse(settled.attemptHistory).length, 1);
    assert.equal(Number((await database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='claim-owner'").get()).n), 1);
    assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get()).n), 1);
    const staleSettlement = await database.adapter.prepare("UPDATE sporades_jobs SET status='failed' WHERE id=? AND status='running' AND \"claimToken\"=?").run(queued.data.id, claim.claimToken);
    assert.equal(staleSettlement.changes, 0);
  } finally { release?.(); await database.shutdown(); await database.close(); }
});

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

test('a Custom mutation joins its outer transaction for a first resource scope', async () => {
  const f = await fixture(() => null, {
    mutations: {
      resourceWrite: mutation(async (ctx) => ctx.resources.run(options(), async scope => {
        await scope.db.writes.insert({ value: 'mutation-committed' });
        return { committed: true };
      })),
    },
  });
  try {
    const result = await runMutation(f.database, actor, 'resourceWrite', []);
    assert.deepEqual(result, { ok: true, data: { committed: true }, error: null });
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='mutation-committed'").get().n, 1);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts').get().n, 1);
  } finally { await f.close(); }
});

test('a Custom mutation outer rollback removes its resource receipt and staged write', async () => {
  const f = await fixture(() => null, {
    mutations: {
      resourceRollback: mutation(async (ctx) => {
        await ctx.resources.run(options(), async scope => {
          await scope.db.writes.insert({ value: 'mutation-rolled-back' });
          return { provisional: true };
        });
        throw new Error('outer mutation failure');
      }),
    },
  });
  try {
    const result = await runMutation(f.database, actor, 'resourceRollback', []);
    assert.equal(result.ok, false);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='mutation-rolled-back'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('a caught outer scope callback or canonical-result failure poisons the enclosing mutation', async () => {
  const f = await fixture(() => null, {
    mutations: {
      caughtCallback: mutation(async ctx => {
        try { await ctx.resources.run(options(), async scope => { await scope.db.writes.insert({ value: 'caught-callback' }); throw new Error('callback failure'); }); } catch {}
        return { unexpectedlyCommitted: true };
      }),
      caughtResult: mutation(async ctx => {
        try { await ctx.resources.run(options(), async scope => { await scope.db.writes.insert({ value: 'caught-result' }); return undefined; }); } catch {}
        return { unexpectedlyCommitted: true };
      }),
    },
  });
  try {
    for (const name of ['caughtCallback', 'caughtResult']) {
      const result = await runMutation(f.database, actor, name, []);
      assert.equal(result.ok, false);
    }
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value LIKE 'caught-%'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('a caught invalid table write through a resource scope poisons the outer mutation', async () => {
  const f = await fixture(() => null, { mutations: { invalidTableWrite: mutation(async ctx => {
    try { await ctx.resources.run({ ...options(), operationId: 'invalid-table-write' }, async scope => {
      await scope.db.writes.insert({ value: 'must-rollback' });
      try { scope.db.writes.insertOrIgnore({ value: 'invalid' }); } catch {}
      return { returned: true };
    }); } catch {}
    return { unexpectedlyCommitted: true };
  }) } });
  try {
    const result = await runMutation(f.database, actor, 'invalidTableWrite', []);
    assert.equal(result.ok, false);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('a caught or unawaited invalid child enqueue poisons outer mutation and endpoint resource scopes', async () => {
  const f = await fixture(() => null, {
    mutations: {
      badChild: mutation(async ctx => {
        await ctx.resources.run(options(), scope => { scope.jobs.enqueue('missing', null); return { queued: true }; });
        return { unexpectedlyCommitted: true };
      }),
    },
    endpoints: {
      badChild: endpoint({ method: 'POST', path: '/bad-child' }, async ctx => {
        try { await ctx.resources.run(options(), async scope => { try { await scope.jobs.enqueue('missing', null); } catch {} return { queued: true }; }); } catch {}
        return { unexpectedlyCommitted: true };
      }),
    },
  });
  try {
    assert.equal((await runMutation(f.database, actor, 'badChild', [])).ok, false);
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'badChild'), new URL('http://capsule.test/bad-child'), { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} }));
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('outer mutation and endpoint settlement wait for an unawaited whole resource invocation', async () => {
  let release;
  let entered;
  const f = await fixture(() => null, {
    mutations: {
      unawaitedResource: mutation(ctx => {
        ctx.resources.run({ ...options(), operationId: 'unawaited-mutation' }, async scope => {
          await scope.db.writes.insert({ value: 'unawaited-mutation' });
          entered();
          await new Promise(resolve => { release = resolve; });
          return { settled: true };
        });
        return { outerReturned: true };
      }),
    },
    endpoints: {
      unawaitedResource: endpoint({ method: 'POST', path: '/unawaited-resource' }, ctx => {
        ctx.resources.run({ ...options(), operationId: 'unawaited-endpoint' }, async scope => {
          await scope.db.writes.insert({ value: 'unawaited-endpoint' });
          entered();
          await new Promise(resolve => { release = resolve; });
          return { settled: true };
        });
        return { outerReturned: true };
      }),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    for (const mode of ['mutation', 'endpoint']) {
      let reach;
      const reached = new Promise(resolve => { reach = resolve; });
      entered = reach;
      const running = mode === 'mutation'
        ? runMutation(f.database, actor, 'unawaitedResource', [])
        : runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'unawaitedResource'), new URL('http://capsule.test/unawaited-resource'), request);
      await reached;
      assert.equal(await Promise.race([running.then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 25))]), false, `${mode} committed while its resource callback was still blocked`);
      release();
      const result = await running;
      if (mode === 'mutation') assert.equal(result.ok, true);
      else assert.deepEqual(result, { outerReturned: true });
      assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes WHERE value=?').get(`unawaited-${mode}`).n, 1);
      assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE operationId=?').get(`unawaited-${mode}`).n, 1);
    }
  } finally { release?.(); await f.close(); }
});

test('outer resource scopes fence retained parent loggers and never publish their payload on rollback', async () => {
  const f = await fixture(() => null, {
    mutations: {
      retainedParentLog: mutation(async ctx => {
        const retained = ctx.log;
        await ctx.resources.run({ ...options(), operationId: 'parent-log-mutation' }, scope => {
          retained.info('must not publish', { token: 'super-secret' });
          scope.log.info('resource diagnostic');
          return true;
        });
        return { unexpected: true };
      }),
    },
    endpoints: {
      retainedParentLog: endpoint({ method: 'POST', path: '/retained-parent-log' }, async ctx => {
        const retained = ctx.log;
        await ctx.resources.run({ ...options(), operationId: 'parent-log-endpoint' }, scope => {
          retained.warn('must not publish', { password: 'super-secret' });
          scope.log.warn('resource diagnostic');
          return true;
        });
        return { unexpected: true };
      }),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    const mutationResult = await runMutation(f.database, actor, 'retainedParentLog', []);
    assert.equal(mutationResult.ok, false);
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'retainedParentLog'), new URL('http://capsule.test/retained-parent-log'), request), { code: 'RESOURCE_EFFECT_UNSUPPORTED' });
    const jsonl = existsSync(f.database.log.path) ? readFileSync(f.database.log.path, 'utf8') : '';
    assert.equal(jsonl.includes('must not publish'), false);
    assert.equal(jsonl.includes('super-secret'), false);
    assert.equal((await f.database.adapter.readRecentLogEvents(100)).filter(event => event.category === 'resource').length, 0);
  } finally { await f.close(); }
});

test('a Custom mutation holds its SQLite writer through outer settlement after the scope returns', async () => {
  let scopeReturned, releaseOuter;
  const afterScope = new Promise(resolve => { scopeReturned = resolve; });
  const waitForOuter = new Promise(resolve => { releaseOuter = resolve; });
  const f = await fixture(() => null, {
    mutations: {
      holdOuterWriter: mutation(async ctx => {
        await ctx.resources.run(options(), async scope => {
          await scope.db.writes.insert({ value: 'held-through-outer-settlement' });
          return null;
        });
        scopeReturned();
        await waitForOuter;
        return { committed: true };
      }),
    },
  });
  try {
    const running = runMutation(f.database, actor, 'holdOuterWriter', []);
    await afterScope;
    const competing = await createSqliteDatabaseAdapter(f.file);
    try {
      assert.throws(() => competing.prepare("UPDATE anchors SET value='competing' WHERE id='anchor'").run(), error => error.errcode === 5 || error.errcode === 6);
    } finally { await competing.close(); }
    releaseOuter();
    assert.equal((await running).ok, true);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='held-through-outer-settlement'").get().n, 1);
  } finally { releaseOuter?.(); await f.close(); }
});

test('a non-Job scope reserves its final second and status replays only after current authorization', async () => {
  let allow = true;
  const f = await fixture(() => null, {
    schema: { anchors: table({ value: Text() }).acl({ read: () => allow, write: () => allow }), writes: table({ value: Text() }) },
    mutations: {
      reserve: mutation(async ctx => {
        f.clock.advanceBy(29_000);
        await assert.rejects(ctx.resources.run(options(), () => ({ unexpected: true })), { code: 'RESOURCE_DEADLINE_EXCEEDED' });
        return { reserved: true };
      }),
      record: mutation(ctx => ctx.resources.run(options(), () => ({ committed: true }))),
      inspect: mutation(ctx => ctx.resources.status({ resource: options().resource, operationId: 'operation' })),
    },
  });
  try {
    assert.deepEqual(await runMutation(f.database, actor, 'reserve', []), { ok: true, data: { reserved: true }, error: null });
    assert.deepEqual(await runMutation(f.database, actor, 'record', []), { ok: true, data: { committed: true }, error: null });
    assert.deepEqual(await runMutation(f.database, actor, 'inspect', []), { ok: true, data: { state: 'committed', result: { committed: true }, intentIds: [] }, error: null });
    allow = false;
    const denied = await runMutation(f.database, actor, 'inspect', []);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'DENIED');
  } finally { await f.close(); }
});

test('a child enqueued inside a mutation resource scope becomes visible only after outer commit', async () => {
  let scopeReturned, releaseOuter;
  const afterScope = new Promise(resolve => { scopeReturned = resolve; });
  const waitForOuter = new Promise(resolve => { releaseOuter = resolve; });
  const f = await fixture(() => null, {
    mutations: {
      enqueueAfterCommit: mutation(async ctx => {
        await ctx.resources.run(options(), async scope => {
          await scope.jobs.enqueue('child', { source: 'outer' }, { availableAt: '2031-01-01T00:00:00.000Z' });
          return null;
        });
        scopeReturned();
        await waitForOuter;
        return { committed: true };
      }),
    },
  });
  try {
    const running = runMutation(f.database, actor, 'enqueueAfterCommit', []);
    await afterScope;
    const observer = await createSqliteDatabaseAdapter(f.file, { readOnly: true });
    try {
      assert.equal(observer.prepare("SELECT count(*) n FROM sporades_jobs WHERE handler='child'").get().n, 0);
    } finally { await observer.close(); }
    releaseOuter();
    assert.equal((await running).ok, true);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_jobs WHERE handler='child'").get().n, 1);
  } finally { releaseOuter?.(); await f.close(); }
});

test('a test-owned runtime intent fixture joins outer rollback while public notification acceptance remains unsupported', async () => {
  const f = await fixture(() => null);
  try {
    await assert.rejects(f.database.adapter.withTransaction(async transactionAdapter => {
      const database = { ...f.database, adapter: transactionAdapter };
      const context = {
        auth: actor,
        db: {
          anchors: {
            where: (_field, id) => ({ get: async () => transactionAdapter.prepare('SELECT * FROM anchors WHERE id=?').get(id) }),
            update: async () => null,
          },
        },
        jobs: { enqueue: () => null },
        stageRuntimeIntentFixture: async () => {
          await transactionAdapter.exec('CREATE TABLE IF NOT EXISTS sporades_resource_intent_fixture (id TEXT PRIMARY KEY)');
          await transactionAdapter.prepare("INSERT INTO sporades_resource_intent_fixture VALUES ('staged')").run();
        },
      };
      const release = bindOuterResources(database, context, {
        startedAt: f.clock.now().getTime(),
        authorize: async () => null,
        drain: async candidate => candidate.stageRuntimeIntentFixture(),
      });
      try {
        await context.resources.run(options(), async scope => {
          // The fixture stands in for Ticket 06's runtime-owned staging only;
          // it is deliberately admitted by the test hook, never by accept().
          return { staged: true };
        });
        throw new Error('outer rollback');
      } finally { release(); }
    }), /outer rollback/);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_intent_fixture'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('a mutation resource scope invalidates parent and escaped database handles after its callback', async () => {
  let escaped;
  const f = await fixture(() => null, {
    mutations: {
      resourceLifetime: mutation(async ctx => {
        await ctx.resources.run(options(), async scope => {
          escaped = scope.db.writes;
          await scope.db.writes.insert({ value: 'lifetime-committed' });
          return null;
        });
        assert.throws(() => ctx.db.writes.all(), { code: 'RESOURCE_SCOPE_INACTIVE' });
        assert.throws(() => escaped.all(), { code: 'RESOURCE_SCOPE_INACTIVE' });
        return { done: true };
      }),
    },
  });
  try {
    const result = await runMutation(f.database, actor, 'resourceLifetime', []);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { await f.close(); }
});

test('late-added endpoint File claim and attachment capabilities are guarded as resource operations', async () => {
  const f = await fixture(() => null);
  try {
    await f.database.adapter.withTransaction(async adapter => {
      const database = { ...f.database, adapter };
      const context = { auth: actor, db: { anchors: { where: (_field, id) => ({ get: async () => adapter.prepare('SELECT * FROM anchors WHERE id=?').get(id) }), update: async () => null } }, jobs: { enqueue() {} } };
      const release = bindOuterResources(database, context, { startedAt: f.clock.now().getTime(), authorize: async () => null, drain: async () => null });
      const files = release.guardCapability('files', { claim() {}, attachment() {} });
      try {
        assert.doesNotThrow(() => files.claim());
        await assert.rejects(context.resources.run(options(), () => null), { code: 'RESOURCE_CONTEXT_UNSUPPORTED' });
      } finally { release(); }
    });
  } finally { await f.close(); }
});

test('an unused mutation resource entry cannot escape its settled outer transaction', async () => {
  let escapedResources;
  const f = await fixture(() => null, {
    mutations: { retainResources: mutation(ctx => { escapedResources = ctx.resources; return null; }) },
  });
  try {
    assert.equal((await runMutation(f.database, actor, 'retainResources', [])).ok, true);
    await assert.rejects(escapedResources.run(options(), () => null), { code: 'RESOURCE_SCOPE_INACTIVE' });
  } finally { await f.close(); }
});

test('a non-Job resource watchdog rejects a noncooperative callback at the outer deadline', async () => {
  let entered;
  let signal;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(() => null, {
    mutations: { stalls: mutation(ctx => ctx.resources.run(options(), async scope => { signal = scope.signal; entered(); await new Promise(() => {}); return null; })) },
  });
  try {
    const timersBefore = new Set(f.clock.pendingTimerIds());
    const running = runMutation(f.database, actor, 'stalls', []);
    assert.equal(await Promise.race([enteredPromise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]), true);
    const [watchdog] = f.clock.pendingTimerIds().filter(id => !timersBefore.has(id));
    assert.equal(typeof watchdog, 'number');
    f.clock.advanceBy(30_000);
    await f.clock.runTimer(watchdog);
    assert.equal(signal.aborted, true);
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RESOURCE_DEADLINE_EXCEEDED');
  } finally { await f.close(); }
});

test('a non-Job outer handler cannot commit a completed resource scope after its budget expires', async () => {
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(() => null, {
    mutations: { stallsAfterScope: mutation(async ctx => {
      await ctx.resources.run(options(), async scope => { await scope.db.writes.insert({ value: 'outer-deadline' }); return null; });
      entered(); await new Promise(() => {});
    }) },
  });
  try {
    const timersBefore = new Set(f.clock.pendingTimerIds());
    const running = runMutation(f.database, actor, 'stallsAfterScope', []);
    await enteredPromise;
    const [watchdog] = f.clock.pendingTimerIds().filter(id => !timersBefore.has(id));
    f.clock.advanceBy(30_000); await f.clock.runTimer(watchdog);
    const result = await running;
    assert.equal(result.error.code, 'RESOURCE_DEADLINE_EXCEEDED');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='outer-deadline'").get().n, 0);
  } finally { await f.close(); }
});

test('the outer watchdog aborts a stalled after-mutation hook after a completed resource scope', async () => {
  let entered;
  const stalled = new Promise(resolve => { entered = resolve; });
  const f = await fixture(() => null, { mutations: { hookDeadline: mutation(ctx => ctx.resources.run(options(), () => true)) } });
  globalThis.__resourceHookEntered = entered;
  f.database.mutationHooks.afterMutation = ['async () => { globalThis.__resourceHookEntered(); await new Promise(() => {}); }'];
  try {
    const before = new Set(f.clock.pendingTimerIds());
    const running = runMutation(f.database, actor, 'hookDeadline', []);
    await stalled;
    const [watchdog] = f.clock.pendingTimerIds().filter(id => !before.has(id));
    f.clock.advanceBy(30_000); await f.clock.runTimer(watchdog);
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RESOURCE_DEADLINE_EXCEEDED');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { delete globalThis.__resourceHookEntered; await f.close(); }
});

test('the outer watchdog races resource-aware middleware and releases its SQLite writer', async () => {
  const definition = {
    middleware: [async ctx => {
      await ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: ctx.kind === 'endpoint' ? 'middleware-endpoint' : 'middleware-mutation', input: { a: 1, b: 2 } }, async scope => {
        await scope.db.writes.insert({ value: ctx.kind });
        return true;
      });
      globalThis.__resourceMiddlewareEntered();
      await globalThis.__resourceMiddlewareBarrier;
      return ctx;
    }],
    mutations: { middlewareDeadline: mutation(() => ({ unexpected: true })) },
    endpoints: { middlewareDeadline: endpoint({ method: 'POST', path: '/middleware-deadline' }, () => ({ unexpected: true })) },
  };
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    for (const mode of ['mutation', 'endpoint']) {
      let entered;
      let release;
      const stalled = new Promise(resolve => { entered = resolve; });
      const barrier = new Promise(resolve => { release = resolve; });
      globalThis.__resourceMiddlewareEntered = entered;
      globalThis.__resourceMiddlewareBarrier = barrier;
      const f = await fixture(() => null, definition);
      try {
      const before = new Set(f.clock.pendingTimerIds());
      const running = mode === 'mutation'
        ? runMutation(f.database, actor, 'middlewareDeadline', [])
        : runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'middlewareDeadline'), new URL('http://capsule.test/middleware-deadline'), request);
      const reached = await Promise.race([
        stalled.then(() => 'entered'),
        running.then(value => value?.error?.code ?? 'settled', error => error),
        new Promise(resolve => setTimeout(() => resolve('timed out'), 100)),
      ]);
      assert.equal(reached, 'entered', `resource middleware did not reach its barrier: ${reached?.code ?? reached}`);
      const [watchdog] = f.clock.pendingTimerIds().filter(id => !before.has(id));
      f.clock.advanceBy(30_000); await f.clock.runTimer(watchdog);
      const settled = await Promise.race([
        running.then(() => true, () => true),
        new Promise(resolve => setTimeout(() => resolve(false), 100)),
      ]);
      assert.equal(settled, true, `${mode} middleware remained live after its resource watchdog fired`);
      if (mode === 'mutation') assert.equal((await running).error.code, 'RESOURCE_DEADLINE_EXCEEDED');
      else await assert.rejects(running, { code: 'RESOURCE_DEADLINE_EXCEEDED' });
      assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value=?").get(mode).n, 0);
      const independent = await createSqliteDatabaseAdapter(f.file);
      try { assert.doesNotThrow(() => independent.prepare("UPDATE anchors SET value=? WHERE id='anchor'").run(`released-${mode}`)); }
      finally { await independent.close(); }
      } finally { release?.(); await f.close(); }
    }
  } finally {
    delete globalThis.__resourceMiddlewareEntered; delete globalThis.__resourceMiddlewareBarrier;
  }
});

test('outer resource commit checks the deadline at the actual transaction commit', async () => {
  const f = await fixture(() => null, {
    mutations: { delayedCommit: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'actual-commit-deadline' }, async scope => {
      await scope.db.writes.insert({ value: 'must-rollback-at-commit' });
      return true;
    })) },
  });
  const withTransaction = f.database.adapter.withTransaction.bind(f.database.adapter);
  f.database.adapter.withTransaction = callback => withTransaction(async adapter => {
    const result = await callback(adapter);
    // Deliberately do not run the watchdog: this is the JavaScript gap after
    // cleanup/revocation and immediately before the adapter issues COMMIT.
    f.clock.advanceBy(30_000);
    return result;
  });
  try {
    const result = await runMutation(f.database, actor, 'delayedCommit', []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RESOURCE_DEADLINE_EXCEEDED');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='must-rollback-at-commit'").get().n, 0);
  } finally { f.database.adapter.withTransaction = withTransaction; await f.close(); }
});

test('an outer unknown commit outcome reconciles by receipt without replaying its callback', async () => {
  globalThis.__outerResourceCallbacks = 0;
  globalThis.__outerResourceHandles = [];
  const f = await fixture(() => null, {
    mutations: { unknownOuterCommit: mutation(ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'outer-unknown-mutation', input: { a: 1, b: 2 } }, async scope => {
      globalThis.__outerResourceHandles.push([ctx.db.writes, scope.db.writes]);
      globalThis.__outerResourceCallbacks++; await scope.db.writes.insert({ value: 'outer-once-mutation' }); return { once: true };
    })) },
    endpoints: { unknownOuterCommit: endpoint({ method: 'POST', path: '/outer-unknown' }, ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'outer-unknown-endpoint', input: { a: 1, b: 2 } }, async scope => {
      globalThis.__outerResourceHandles.push([ctx.db.writes, scope.db.writes]);
      globalThis.__outerResourceCallbacks++; await scope.db.writes.insert({ value: 'outer-once-endpoint' }); return { once: true };
    })) },
  });
  const endpointAuth = { userId: 'outer-endpoint-actor', displayName: 'Endpoint actor', email: 'endpoint@example.com', picture: null, isAuthenticated: true, isGuest: false, provider: 'email' };
  const endpointSessionToken = 'outer-endpoint-session';
  await f.database.adapter.insertAuthUser({ id: endpointAuth.userId, createdAt: f.clock.now().toISOString(), displayName: endpointAuth.displayName, email: endpointAuth.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: endpointAuth.provider });
  await f.database.adapter.insertAuthSession({ token: endpointSessionToken, userId: endpointAuth.userId, provider: endpointAuth.provider, createdAt: f.clock.now().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  const request = { method: 'POST', headers: { 'x-sporades-session-token': endpointSessionToken }, async *[Symbol.asyncIterator]() {} };
  try {
    for (const mode of ['endpoint', 'mutation']) {
      const transactionOperations = Symbol.for('sporades.database.transactionOperations');
      const originalOperations = f.database.adapter[transactionOperations];
      const uncertainAdapter = Object.create(f.database.adapter); let receiptFaults = 0;
      Object.defineProperty(uncertainAdapter, transactionOperations, { value: () => {
        const operations = originalOperations();
        let resourceReceiptInserted = false;
        return { ...operations, prepare(sql) {
          const statement = operations.prepare(sql);
          return Object.assign(Object.create(statement), { run(...args) {
            const value = statement.run(...args);
            if (isResourceReceiptInsert(sql)) { resourceReceiptInserted = true; receiptFaults++; }
            return value;
          } });
        }, exec(sql) {
          const value = operations.exec(sql);
          if (sql === 'COMMIT' && resourceReceiptInserted) throw Object.assign(new Error('lost COMMIT reply'), { code: 'ECONNRESET' });
          return value;
        } };
      } });
      const uncertainDatabase = { ...f.database, adapter: uncertainAdapter };
      const first = mode === 'mutation'
        ? await runMutation(uncertainDatabase, actor, 'unknownOuterCommit', [])
        : await runEndpoint(uncertainDatabase, f.database.endpoints.find(item => item.name === 'unknownOuterCommit'), new URL('http://capsule.test/outer-unknown'), request).then(() => null, error => error);
      const code = mode === 'mutation' ? first.error?.code : first.code;
      assert.equal(code, 'RESOURCE_COMMIT_UNKNOWN', `${mode}: ${JSON.stringify(first)}`);
      assert.equal(receiptFaults, 1, `${mode}: the receipt loss hook fired exactly once`);
      const [parentTable, scopedTable] = globalThis.__outerResourceHandles.at(-1);
      assert.throws(() => parentTable.all(), { code: 'RESOURCE_SCOPE_INACTIVE' });
      assert.throws(() => scopedTable.all(), { code: 'RESOURCE_SCOPE_INACTIVE' });
      const replay = mode === 'mutation'
        ? await runMutation(f.database, actor, 'unknownOuterCommit', [])
        : await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'unknownOuterCommit'), new URL('http://capsule.test/outer-unknown'), request);
      if (mode === 'mutation') assert.deepEqual(replay, { ok: true, data: { once: true }, error: null });
      else assert.deepEqual(replay, { once: true });
      assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes WHERE value=?').get(`outer-once-${mode}`).n, 1);
    }
    assert.equal(globalThis.__outerResourceCallbacks, 2);
  } finally { delete globalThis.__outerResourceCallbacks; delete globalThis.__outerResourceHandles; await f.close(); }
});

test('caught and unawaited outer receipt insertion failures poison mutation and endpoint settlement', async () => {
  const f = await fixture(() => null, { mutations: {
    caughtReceipt: mutation(async ctx => { try { await ctx.resources.run({ ...options(), operationId: 'caught-mutation-receipt' }, async scope => { await scope.db.writes.insert({ value: 'caught-mutation-receipt' }); return true; }); } catch {} return { caught: true }; }),
    unawaitedReceipt: mutation(ctx => { void ctx.resources.run({ ...options(), operationId: 'unawaited-mutation-receipt' }, async scope => { await scope.db.writes.insert({ value: 'unawaited-mutation-receipt' }); return true; }); return { returned: true }; }),
  }, endpoints: {
    caughtReceipt: endpoint({ method: 'POST', path: '/caught-receipt' }, async ctx => { try { await ctx.resources.run({ ...options(), operationId: 'caught-endpoint-receipt' }, async scope => { await scope.db.writes.insert({ value: 'caught-endpoint-receipt' }); return true; }); } catch {} return { caught: true }; }),
    unawaitedReceipt: endpoint({ method: 'POST', path: '/unawaited-receipt' }, ctx => { void ctx.resources.run({ ...options(), operationId: 'unawaited-endpoint-receipt' }, async scope => { await scope.db.writes.insert({ value: 'unawaited-endpoint-receipt' }); return true; }); return { returned: true }; }),
  } });
  const symbol = Symbol.for('sporades.database.transactionOperations'), original = f.database.adapter[symbol], adapter = Object.create(f.database.adapter); let receiptFaults = 0;
  Object.defineProperty(adapter, symbol, { value: () => { const operations = original(); return { ...operations, prepare(sql) { const statement = operations.prepare(sql); return Object.assign(Object.create(statement), { run(...args) { if (isResourceReceiptInsert(sql)) { receiptFaults++; throw new Error('receipt insert failed'); } return statement.run(...args); } }); } }; } });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    for (const name of ['caughtReceipt', 'unawaitedReceipt']) {
      assert.equal((await runMutation({ ...f.database, adapter }, actor, name, [])).ok, false, `mutation ${name}`);
      await assert.rejects(runEndpoint({ ...f.database, adapter }, f.database.endpoints.find(item => item.name === name), new URL(`http://capsule.test/${name}`), request), /receipt insert failed/, `endpoint ${name}`);
    }
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value LIKE '%receipt'").get().n, 0);
    assert.equal(receiptFaults, 4, 'every caught/unawaited mutation and endpoint receipt fault fired');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { await f.close(); }
});

test('an outer resource COMMIT with a failed native close quarantines root and cached SQLite statements', async () => {
  const f = await fixture(() => null, { mutations: { closeUnknown: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'outer-close-unknown' }, async scope => {
    await scope.db.writes.insert({ value: 'close-unknown' }); return true;
  })) } });
  const transactionOperations = Symbol.for('sporades.database.transactionOperations');
  const operationsFactory = f.database.adapter[transactionOperations];
  const uncertainAdapter = Object.create(f.database.adapter);
  const cachedRootStatement = f.database.adapter.prepare('SELECT count(*) n FROM writes');
  let receiptFaults = 0;
  Object.defineProperty(uncertainAdapter, transactionOperations, { value: () => {
    const operations = operationsFactory(); let receipt = false;
    return { ...operations, prepare(sql) { const statement = operations.prepare(sql); return Object.assign(Object.create(statement), { run(...args) { const value = statement.run(...args); if (isResourceReceiptInsert(sql)) { receipt = true; receiptFaults++; } return value; } }); }, exec(sql) {
      const value = operations.exec(sql); if (sql === 'COMMIT' && receipt) throw Object.assign(new Error('lost COMMIT reply'), { code: 'ECONNRESET' }); return value;
    } };
  } });
  const { DatabaseSync } = await import('node:sqlite');
  const originalClose = DatabaseSync.prototype.close;
  let failDiscardClose = true;
  DatabaseSync.prototype.close = function() { if (failDiscardClose) { failDiscardClose = false; throw new Error('native close failed'); } return originalClose.call(this); };
  try {
    const result = await runMutation({ ...f.database, adapter: uncertainAdapter }, actor, 'closeUnknown', []);
    assert.equal(result.error.code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal(receiptFaults, 1, 'the native-close uncertainty hook fired after receipt insertion');
    assert.throws(() => f.database.adapter.exec('SELECT 1'), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.throws(() => f.database.adapter.prepare('SELECT 1').get(), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.throws(() => cachedRootStatement.get(), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.equal(String(result.error.message).includes(f.file), false);
    const independent = await createSqliteDatabaseAdapter(f.file);
    try {
      assert.equal(independent.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE operationId='outer-close-unknown'").get().n, 1);
      assert.equal(independent.prepare("SELECT count(*) n FROM writes WHERE value='close-unknown'").get().n, 1);
    } finally { await independent.close(); }
  } finally { DatabaseSync.prototype.close = originalClose; await f.close(); }
});

test('an outer resource COMMIT with a failed SQLite replacement quarantines root and cached statements', async () => {
  const f = await fixture(() => null, { mutations: { reopenUnknown: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'outer-reopen-unknown' }, async scope => {
    await scope.db.writes.insert({ value: 'reopen-unknown' }); return true;
  })) } });
  const transactionOperations = Symbol.for('sporades.database.transactionOperations');
  const operationsFactory = f.database.adapter[transactionOperations];
  const uncertainAdapter = Object.create(f.database.adapter);
  const cachedRootStatement = f.database.adapter.prepare('SELECT count(*) n FROM writes');
  const movedPath = `${f.file}.reopen-fault`;
  let pathReplaced = false;
  let receiptFaults = 0;
  Object.defineProperty(uncertainAdapter, transactionOperations, { value: () => {
    const operations = operationsFactory(); let receipt = false;
    return { ...operations, prepare(sql) { const statement = operations.prepare(sql); return Object.assign(Object.create(statement), { run(...args) { const value = statement.run(...args); if (isResourceReceiptInsert(sql)) { receipt = true; receiptFaults++; } return value; } }); }, exec(sql) {
      const value = operations.exec(sql);
      if (sql === 'COMMIT' && receipt) { renameSync(f.file, movedPath); mkdirSync(f.file); pathReplaced = true; throw Object.assign(new Error('lost COMMIT reply'), { code: 'ECONNRESET' }); }
      return value;
    } };
  } });
  try {
    const result = await runMutation({ ...f.database, adapter: uncertainAdapter }, actor, 'reopenUnknown', []);
    assert.equal(result.error.code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal(receiptFaults, 1, 'the replacement uncertainty hook fired after receipt insertion');
    assert.throws(() => f.database.adapter.exec('SELECT 1'), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.throws(() => f.database.adapter.prepare('SELECT 1').get(), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.throws(() => cachedRootStatement.get(), { code: 'RESOURCE_COMMIT_UNKNOWN' });
    assert.equal(String(result.error.message).includes(f.file), false);
    await rm(f.file, { recursive: true, force: true }); renameSync(movedPath, f.file); pathReplaced = false;
    const independent = await createSqliteDatabaseAdapter(f.file);
    try {
      assert.equal(independent.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE operationId='outer-reopen-unknown'").get().n, 1);
      assert.equal(independent.prepare("SELECT count(*) n FROM writes WHERE value='reopen-unknown'").get().n, 1);
    } finally { await independent.close(); }
  } finally {
    if (pathReplaced) { await rm(f.file, { recursive: true, force: true }); renameSync(movedPath, f.file); }
    await f.close();
  }
});

test('an outer resource COMMIT throw before engine completion leaves no receipt for fresh authority', async () => {
  let callbacks = 0;
  const f = await fixture(() => null, { mutations: { beforeCommit: mutation(ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'outer-before-commit', input: { a: 1 } }, async scope => {
    callbacks++; await scope.db.writes.insert({ value: 'before-commit' }); return true;
  })) } });
  const transactionOperations = Symbol.for('sporades.database.transactionOperations');
  const originalOperations = f.database.adapter[transactionOperations];
  const uncertainAdapter = Object.create(f.database.adapter);
  let receiptFaults = 0;
  Object.defineProperty(uncertainAdapter, transactionOperations, { value: () => {
    const operations = originalOperations(); let receipt = false;
    return { ...operations, prepare(sql) { const statement = operations.prepare(sql); return Object.assign(Object.create(statement), { run(...args) { const value = statement.run(...args); if (isResourceReceiptInsert(sql)) { receipt = true; receiptFaults++; } return value; } }); }, exec(sql) {
      if (sql === 'COMMIT' && receipt) throw Object.assign(new Error('connection died before COMMIT'), { code: 'ECONNRESET' });
      return operations.exec(sql);
    } };
  } });
  try {
    const first = await runMutation({ ...f.database, adapter: uncertainAdapter }, actor, 'beforeCommit', []);
    assert.equal(first.error.code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal(receiptFaults, 1, 'the pre-COMMIT mutation fault hook fired after receipt insertion');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
    const independent = await createSqliteDatabaseAdapter(f.file);
    try { assert.doesNotThrow(() => independent.prepare("UPDATE anchors SET value='fresh' WHERE id='anchor'").run()); }
    finally { await independent.close(); }
    assert.deepEqual(await runMutation(f.database, actor, 'beforeCommit', []), { ok: true, data: true, error: null });
    assert.equal(callbacks, 2);
  } finally { await f.close(); }
});

test('an endpoint resource COMMIT throw before engine completion leaves no receipt for fresh authority', async () => {
  let callbacks = 0;
  const f = await fixture(() => null, { endpoints: { beforeCommit: endpoint({ method: 'POST', path: '/before-commit' }, ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'outer-before-endpoint', input: { a: 1 } }, async scope => { callbacks++; await scope.db.writes.insert({ value: 'before-endpoint' }); return true; })) } });
  const auth = { userId: 'before-endpoint', displayName: 'Before endpoint', email: 'before-endpoint@example.com', picture: null, isAuthenticated: true, isGuest: false, provider: 'email' }; const token = 'before-endpoint-token';
  await f.database.adapter.insertAuthUser({ id: auth.userId, createdAt: f.clock.now().toISOString(), displayName: auth.displayName, email: auth.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: auth.provider }); await f.database.adapter.insertAuthSession({ token, userId: auth.userId, provider: auth.provider, createdAt: f.clock.now().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  const symbol = Symbol.for('sporades.database.transactionOperations'), operationsFactory = f.database.adapter[symbol], adapter = Object.create(f.database.adapter); let receiptFaults = 0;
  Object.defineProperty(adapter, symbol, { value: () => { const operations = operationsFactory(); let receipt = false; return { ...operations, prepare(sql) { const statement = operations.prepare(sql); return Object.assign(Object.create(statement), { run(...args) { const value = statement.run(...args); if (isResourceReceiptInsert(sql)) { receipt = true; receiptFaults++; } return value; } }); }, exec(sql) { if (sql === 'COMMIT' && receipt) throw Object.assign(new Error('endpoint before commit'), { code: 'ECONNRESET' }); return operations.exec(sql); } }; } });
  const request = { method: 'POST', headers: { 'x-sporades-session-token': token }, async *[Symbol.asyncIterator]() {} }; const route = f.database.endpoints.find(item => item.name === 'beforeCommit');
  try {
    const error = await runEndpoint({ ...f.database, adapter }, route, new URL('http://capsule.test/before-commit'), request).then(() => null, value => value); assert.equal(error.code, 'RESOURCE_COMMIT_UNKNOWN');
    assert.equal(receiptFaults, 1, 'the pre-COMMIT endpoint fault hook fired after receipt insertion');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
    assert.equal(await runEndpoint(f.database, route, new URL('http://capsule.test/before-commit'), request), true); assert.equal(callbacks, 2);
  } finally { await f.close(); }
});

test('the outer watchdog aborts the real pending-log cleanup phase after a completed resource scope', async () => {
  let entered;
  const inserted = new Promise(resolve => { entered = resolve; });
  let draining;
  const drainStarted = new Promise(resolve => { draining = resolve; });
  const cleanupPending = new Promise(() => {});
  const f = await fixture(() => null, { mutations: { cleanupDeadline: mutation(async ctx => {
    await ctx.resources.run({ ...options(), operationId: 'cleanup-deadline' }, scope => {
      // This is the runtime-owned staged diagnostic. Parent ctx.log is
      // intentionally unavailable after resource entry, so the watchdog must
      // prove real transactional log cleanup rather than an escaped parent log.
      scope.log.info('resource diagnostic');
      return true;
    });
    return { returned: true };
  }) } });
  const withTransaction = f.database.adapter.withTransaction.bind(f.database.adapter);
  f.database.adapter.withTransaction = async callback => withTransaction(async adapter => {
    adapter.insertLogIndexEvent = () => {
      const pendingSymbol = Object.getOwnPropertySymbols(adapter).find(symbol => symbol.description === 'sporades.transactionPendingLogWrites');
      const pending = adapter[pendingSymbol];
      const splice = pending.splice.bind(pending);
      pending.splice = (...args) => { draining(); return splice(...args); };
      entered();
      // Match the runtime sink's asynchronous index work: staging itself is
      // complete, while cleanup owns the retained promise in this transaction.
      pending.push(cleanupPending);
      return undefined;
    };
    return await callback(adapter);
  });
  try {
    const before = new Set(f.clock.pendingTimerIds());
    const running = runMutation(f.database, actor, 'cleanupDeadline', []);
    await inserted;
    await drainStarted;
    const [watchdog] = f.clock.pendingTimerIds().filter(id => !before.has(id));
    assert.equal(typeof watchdog, 'number');
    f.clock.advanceBy(30_000); await f.clock.runTimer(watchdog);
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RESOURCE_DEADLINE_EXCEEDED');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally { f.database.adapter.withTransaction = withTransaction; await f.close(); }
});

test('a Custom endpoint joins its outer transaction for a first resource scope', async () => {
  const f = await fixture(() => null, {
    endpoints: {
      resourceWrite: endpoint({ method: 'POST', path: '/resource-write' }, async ctx => ctx.resources.run(options(), async scope => {
        await scope.db.writes.insert({ value: 'endpoint-committed' });
        return { committed: true };
      })),
    },
  });
  try {
    const result = await runEndpoint(f.database, f.database.endpoints[0], new URL('http://capsule.test/resource-write'), { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} });
    assert.deepEqual(result, { committed: true });
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value='endpoint-committed'").get().n, 1);
  } finally { await f.close(); }
});

test('a Custom endpoint has the same outer deadline and authorized status semantics as a mutation', async () => {
  let entered;
  const endpointEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(() => null, {
    endpoints: {
      resourceStall: endpoint({ method: 'POST', path: '/resource-stall' }, async ctx => ctx.resources.run(options(), async () => {
        entered();
        await new Promise(() => {});
        return null;
      })),
      resourceStatus: endpoint({ method: 'POST', path: '/resource-status' }, ctx => ctx.resources.status({ resource: options().resource, operationId: 'missing' })),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    assert.deepEqual(await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'resourceStatus'), new URL('http://capsule.test/resource-status'), request), { state: 'absent' });
    const before = new Set(f.clock.pendingTimerIds());
    const running = runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'resourceStall'), new URL('http://capsule.test/resource-stall'), request);
    await endpointEntered;
    const [watchdog] = f.clock.pendingTimerIds().filter(id => !before.has(id));
    f.clock.advanceBy(30_000);
    await f.clock.runTimer(watchdog);
    await assert.rejects(running, { code: 'RESOURCE_DEADLINE_EXCEEDED' });
  } finally { await f.close(); }
});

test('outer mutation and endpoint resource logs commit payload-free, roll back, and enforce the 100-call cap', async () => {
  const f = await fixture(() => null, {
    mutations: {
      logCommit: mutation(ctx => ctx.resources.run(options(), scope => { scope.log.info('secret', { body: 'secret' }); return true; })),
      logRollback: mutation(async ctx => { await ctx.resources.run({ ...options(), operationId: 'log-rollback' }, scope => { scope.log.warn('secret'); return true; }); throw new Error('outer'); }),
      logCap: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'log-cap' }, scope => { for (let i = 0; i < 101; i++) scope.log.error('secret'); return true; })),
    },
    endpoints: { logCommit: endpoint({ method: 'POST', path: '/resource-log' }, ctx => ctx.resources.run({ ...options(), operationId: 'endpoint-log' }, scope => { scope.log.info('secret'); return true; })) },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    assert.equal((await runMutation(f.database, actor, 'logCommit', [])).ok, true);
    assert.equal((await runMutation(f.database, actor, 'logRollback', [])).ok, false);
    assert.equal((await runMutation(f.database, actor, 'logCap', [])).ok, false);
    assert.equal(await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'logCommit'), new URL('http://capsule.test/resource-log'), request), true);
    const events = (await f.database.adapter.readRecentLogEvents(100)).filter(event => event.category === 'resource');
    assert.equal(events.length, 2);
    assert.equal(JSON.stringify(events).includes('secret'), false);
    const jsonl = readFileSync(f.database.log.path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.category === 'resource');
    assert.equal(jsonl.length, 2);
    assert.equal(JSON.stringify(jsonl).includes('secret'), false);
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
    const supportedMutation = await runMutation(f.database, actor, 'unsupported', []);
    assert.equal(supportedMutation.ok, true);
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

test('outer mutation and endpoint unawaited notification acceptance rolls back without an unhandled rejection', async () => {
  const unhandled = [];
  const observeUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', observeUnhandled);
  const f = await fixture(() => null, {
    mutations: {
      unawaitedNotification: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'outer-notification-mutation' }, async scope => {
        await scope.db.writes.insert({ value: 'outer-notification-mutation' });
        scope.notifications.accept({});
        return true;
      })),
    },
    endpoints: {
      unawaitedNotification: endpoint({ method: 'POST', path: '/outer-notification' }, ctx => ctx.resources.run({ ...options(), operationId: 'outer-notification-endpoint' }, async scope => {
        await scope.db.writes.insert({ value: 'outer-notification-endpoint' });
        scope.notifications.accept({});
        return true;
      })),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    const mutationResult = await runMutation(f.database, actor, 'unawaitedNotification', []);
    assert.equal(mutationResult.ok, false);
    assert.equal(mutationResult.error.code, 'RESOURCE_EFFECT_UNSUPPORTED');
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'unawaitedNotification'), new URL('http://capsule.test/outer-notification'), request), { code: 'RESOURCE_EFFECT_UNSUPPORTED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value LIKE 'outer-notification-%'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
  } finally {
    process.removeListener('unhandledRejection', observeUnhandled);
    await f.close();
  }
});

test('postcommit resource JSONL failure is redacted while mutation and endpoint receipts remain committed', async () => {
  let callbacks = 0;
  const f = await fixture(() => null, {
    mutations: { jsonlFailure: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'jsonl-mutation' }, async scope => { callbacks++; scope.log.info('diagnostic'); await scope.db.writes.insert({ value: 'jsonl-mutation' }); return { committed: true }; })) },
    endpoints: { jsonlFailure: endpoint({ method: 'POST', path: '/jsonl-failure' }, ctx => ctx.resources.run({ ...options(), operationId: 'jsonl-endpoint' }, async scope => { callbacks++; scope.log.info('diagnostic'); await scope.db.writes.insert({ value: 'jsonl-endpoint' }); return { committed: true }; })) },
  });
  const originalPath = f.database.log.path;
  f.database.log.path = path.dirname(f.file);
  const endpointAuth = { userId: 'jsonl-endpoint-actor', displayName: 'JSONL endpoint actor', email: 'jsonl-endpoint@example.com', picture: null, isAuthenticated: true, isGuest: false, provider: 'email' };
  const endpointToken = 'jsonl-endpoint-session';
  await f.database.adapter.insertAuthUser({ id: endpointAuth.userId, createdAt: f.clock.now().toISOString(), displayName: endpointAuth.displayName, email: endpointAuth.email, picture: null, isAuthenticated: 1, isGuest: 0, provider: endpointAuth.provider });
  await f.database.adapter.insertAuthSession({ token: endpointToken, userId: endpointAuth.userId, provider: endpointAuth.provider, createdAt: f.clock.now().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  const request = { method: 'POST', headers: { 'x-sporades-session-token': endpointToken }, async *[Symbol.asyncIterator]() {} };
  try {
    const mutationResult = await runMutation(f.database, actor, 'jsonlFailure', []);
    assert.equal(mutationResult.ok, false); assert.equal(mutationResult.error.code, 'RESOURCE_STORAGE_ERROR');
    const endpointError = await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'jsonlFailure'), new URL('http://capsule.test/jsonl-failure'), request).then(() => null, error => error);
    assert.equal(endpointError.code, 'RESOURCE_STORAGE_ERROR');
    assert.equal(String(mutationResult.error.message).includes(f.database.log.path), false);
    assert.equal(String(endpointError.message).includes(f.database.log.path), false);
    for (const mode of ['mutation', 'endpoint']) {
      assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes WHERE value=?').get(`jsonl-${mode}`).n, 1);
      assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_resource_receipts WHERE operationId=?').get(`jsonl-${mode}`).n, 1);
    }
    f.database.log.path = originalPath;
    assert.equal((await runMutation(f.database, actor, 'jsonlFailure', [])).ok, true);
    assert.deepEqual(await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'jsonlFailure'), new URL('http://capsule.test/jsonl-failure'), request), { committed: true });
    assert.equal(callbacks, 2);
  } finally { f.database.log.path = originalPath; await f.close(); }
});

test('resource attempts suppress ACL denial diagnostics from initial authorization and scoped work', async () => {
  const f = await fixture(() => null, {
    schema: {
      anchors: table({ value: Text() }).acl({ read: ({ row }) => row?.value === 'permitted', write: () => true }),
      writes: table({ value: Text() }).acl({ read: () => false, write: () => false }),
    },
    mutations: {
      initialAclDenied: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'initial-acl-mutation' }, () => ({ impossible: true }))),
      scopedAclDenied: mutation(async ctx => {
        try { await ctx.resources.run({ ...options(), operationId: 'scoped-acl-mutation' }, async scope => {
          try { await scope.db.writes.insert({ value: 'sensitive-mutation' }); } catch {}
          void scope.db.writes.insert({ value: 'sensitive-unawaited-mutation' }).catch(() => {});
          await scope.db.writes.where('value', 'sensitive-read-mutation').get();
          return { impossible: true };
        }); } catch {}
        return { impossible: true };
      }),
    },
    endpoints: {
      initialAclDenied: endpoint({ method: 'POST', path: '/initial-acl' }, ctx => ctx.resources.run({ ...options(), operationId: 'initial-acl-endpoint' }, () => ({ impossible: true }))),
      scopedAclDenied: endpoint({ method: 'POST', path: '/scoped-acl' }, async ctx => {
        try { await ctx.resources.run({ ...options(), operationId: 'scoped-acl-endpoint' }, async scope => {
          try { await scope.db.writes.insert({ value: 'sensitive-endpoint' }); } catch {}
          void scope.db.writes.insert({ value: 'sensitive-unawaited-endpoint' }).catch(() => {});
          await scope.db.writes.where('value', 'sensitive-read-endpoint').get();
          return { impossible: true };
        }); } catch {}
        return { impossible: true };
      }),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    f.database.adapter.prepare("UPDATE anchors SET value='denied' WHERE id='anchor'").run();
    assert.equal((await runMutation(f.database, actor, 'initialAclDenied', [])).ok, false);
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'initialAclDenied'), new URL('http://capsule.test/initial-acl'), request), { code: 'DENIED' });
    f.database.adapter.prepare("UPDATE anchors SET value='permitted' WHERE id='anchor'").run();
    assert.equal((await runMutation(f.database, actor, 'scopedAclDenied', [])).ok, false);
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'scopedAclDenied'), new URL('http://capsule.test/scoped-acl'), request));
    await new Promise(resolve => setImmediate(resolve));
    const indexed = await f.database.adapter.readRecentLogEvents(100);
    const jsonl = existsSync(f.database.log.path) ? readFileSync(f.database.log.path, 'utf8') : '';
    assert.equal(indexed.some(event => event.event === 'acl.denied'), false);
    assert.equal(jsonl.includes('acl.denied'), false);
    assert.equal(jsonl.includes('sensitive-'), false);
  } finally { await f.close(); }
});

test('postcommit JSONL publication failure still dispatches committed resource children', async () => {
  let childRuns = 0;
  const f = await fixture(() => null, {
    jobs: { work: job(() => null), child: job(() => { childRuns++; }) },
    mutations: { jsonlDispatch: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'jsonl-dispatch-mutation' }, async scope => { scope.log.info('diagnostic'); await scope.jobs.enqueue('child', { source: 'mutation' }); return { committed: true }; })) },
    endpoints: { jsonlDispatch: endpoint({ method: 'POST', path: '/jsonl-dispatch' }, ctx => ctx.resources.run({ ...options(), operationId: 'jsonl-dispatch-endpoint' }, async scope => { scope.log.info('diagnostic'); await scope.jobs.enqueue('child', { source: 'endpoint' }); return { committed: true }; })) },
  });
  const originalPath = f.database.log.path;
  f.database.log.path = path.dirname(f.file);
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    // The fixture starts its idle worker on a controllable zero-delay timer.
    // Drain only timers that existed before this test's operation; there are no
    // children yet, so this cannot be a later queue kick for the assertion.
    for (const timer of f.clock.pendingTimerIds()) await f.clock.runTimer(timer);
    assert.equal(childRuns, 0);
    const runOnlyNewDispatchTimer = async (operation) => {
      const before = new Set(f.clock.pendingTimerIds());
      const result = await operation();
      const dispatchTimers = f.clock.pendingTimerIds().filter(timer => !before.has(timer));
      assert.equal(dispatchTimers.length, 1, 'the committed operation must schedule exactly one worker timer');
      assert.equal(await f.clock.runTimer(dispatchTimers[0]), true);
      return result;
    };
    const mutationResult = await runOnlyNewDispatchTimer(() => runMutation(f.database, actor, 'jsonlDispatch', []));
    assert.equal(mutationResult.error.code, 'RESOURCE_STORAGE_ERROR');
    const endpointError = await runOnlyNewDispatchTimer(() => runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'jsonlDispatch'), new URL('http://capsule.test/jsonl-dispatch'), request).then(() => null, error => error));
    assert.equal(endpointError.code, 'RESOURCE_STORAGE_ERROR');
    assert.equal(childRuns, 2, 'committed children must run without an unrelated queue kick');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_jobs WHERE handler='child' AND status='succeeded'").get().n, 2);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE operationId LIKE 'jsonl-dispatch-%'").get().n, 2);
  } finally { f.database.log.path = originalPath; await f.close(); }
});

test('outer resource SQLite setup failures are redacted and poison caught and unawaited mutation and endpoint work', async () => {
  const f = await fixture(() => null, {
    mutations: {
      caughtStorage: mutation(async ctx => { try { await ctx.resources.run({ ...options(), operationId: 'caught-storage-mutation' }, () => true); } catch {} return { impossible: true }; }),
      unawaitedStorage: mutation(ctx => { void ctx.resources.run({ ...options(), operationId: 'unawaited-storage-mutation' }, () => true).catch(() => {}); return { impossible: true }; }),
    },
    endpoints: {
      caughtStorage: endpoint({ method: 'POST', path: '/caught-storage' }, async ctx => { try { await ctx.resources.run({ ...options(), operationId: 'caught-storage-endpoint' }, () => true); } catch {} return { impossible: true }; }),
      unawaitedStorage: endpoint({ method: 'POST', path: '/unawaited-storage' }, ctx => { void ctx.resources.run({ ...options(), operationId: 'unawaited-storage-endpoint' }, () => true).catch(() => {}); return { impossible: true }; }),
    },
  });
  const original = f.database.adapter.withTransaction.bind(f.database.adapter);
  f.database.adapter.withTransaction = async callback => original(async adapter => {
    const exec = adapter.exec.bind(adapter); let failed = false;
    adapter.exec = async sql => {
      if (!failed && sql.includes('sporades_resource_outer_fence')) { failed = true; throw Object.assign(new Error('private SQLite schema diagnostic'), { code: 'ERR_SQLITE_ERROR' }); }
      return exec(sql);
    };
    return callback(adapter);
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    for (const name of ['caughtStorage', 'unawaitedStorage']) {
      const mutationResult = await runMutation(f.database, actor, name, []);
      assert.equal(mutationResult.ok, false); assert.equal(mutationResult.error.code, 'RESOURCE_STORAGE_ERROR'); assert.equal(mutationResult.error.message, 'Resource operation could not complete.');
      const endpointError = await runEndpoint(f.database, f.database.endpoints.find(item => item.name === name), new URL(`http://capsule.test/${name}`), request).then(() => null, error => error);
      assert.deepEqual({ code: endpointError.code, message: endpointError.message }, { code: 'RESOURCE_STORAGE_ERROR', message: 'Resource operation could not complete.' });
    }
  } finally { f.database.adapter.withTransaction = original; await f.close(); }
});

test('admitted outer resource constraint failures are redacted and poison caught and unawaited mutation and endpoint work', async () => {
  const f = await fixture(() => null, {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }).unique('value') },
    mutations: {
      caughtConstraint: mutation(async ctx => ctx.resources.run({ ...options(), operationId: 'caught-constraint-mutation' }, async scope => { await scope.db.writes.insert({ value: 'caught-mutation' }); try { await scope.db.writes.insert({ value: 'caught-mutation' }); } catch {} return { impossible: true }; })),
      unawaitedConstraint: mutation(ctx => ctx.resources.run({ ...options(), operationId: 'unawaited-constraint-mutation' }, async scope => { await scope.db.writes.insert({ value: 'unawaited-mutation' }); void scope.db.writes.insert({ value: 'unawaited-mutation' }).catch(() => {}); return { impossible: true }; })),
    },
    endpoints: {
      caughtConstraint: endpoint({ method: 'POST', path: '/caught-constraint' }, ctx => ctx.resources.run({ ...options(), operationId: 'caught-constraint-endpoint' }, async scope => { await scope.db.writes.insert({ value: 'caught-endpoint' }); try { await scope.db.writes.insert({ value: 'caught-endpoint' }); } catch {} return { impossible: true }; })),
      unawaitedConstraint: endpoint({ method: 'POST', path: '/unawaited-constraint' }, ctx => ctx.resources.run({ ...options(), operationId: 'unawaited-constraint-endpoint' }, async scope => { await scope.db.writes.insert({ value: 'unawaited-endpoint' }); void scope.db.writes.insert({ value: 'unawaited-endpoint' }).catch(() => {}); return { impossible: true }; })),
    },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    for (const name of ['caughtConstraint', 'unawaitedConstraint']) {
      const mutationResult = await runMutation(f.database, actor, name, []);
      assert.equal(mutationResult.ok, false); assert.equal(mutationResult.error.code, 'RESOURCE_STORAGE_ERROR'); assert.equal(mutationResult.error.message, 'Resource operation could not complete.');
      const endpointError = await runEndpoint(f.database, f.database.endpoints.find(item => item.name === name), new URL(`http://capsule.test/${name}`), request).then(() => null, error => error);
      assert.equal(endpointError.code, 'RESOURCE_STORAGE_ERROR'); assert.equal(endpointError.message, 'Resource operation could not complete.');
    }
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0);
  } finally { await f.close(); }
});

test('memory SQLite rejects outer resource run and status before callbacks in mutations and endpoints', async () => {
  let callbacks = 0;
  const database = await openDevDatabase(':memory:', '', {}, { name: 'memory-resource' }, {
    schema: { anchors: table({ value: Text() }) },
    mutations: { run: mutation(ctx => ctx.resources.run(options(), () => { callbacks++; return true; })), status: mutation(ctx => ctx.resources.status({ resource: options().resource, operationId: 'memory-status-mutation' })) },
    endpoints: { run: endpoint({ method: 'POST', path: '/run' }, ctx => ctx.resources.run({ ...options(), operationId: 'memory-run-endpoint' }, () => { callbacks++; return true; })), status: endpoint({ method: 'POST', path: '/status' }, ctx => ctx.resources.status({ resource: options().resource, operationId: 'memory-status-endpoint' })) },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    database.adapter.prepare("INSERT INTO anchors (id,createdAt,updatedAt,value) VALUES ('anchor','2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','memory')").run();
    for (const name of ['run', 'status']) {
      const mutationResult = await runMutation(database, actor, name, []);
      assert.equal(mutationResult.error.code, 'RESOURCE_ADAPTER_UNSUPPORTED');
      await assert.rejects(runEndpoint(database, database.endpoints.find(item => item.name === name), new URL(`http://capsule.test/${name}`), request), { code: 'RESOURCE_ADAPTER_UNSUPPORTED' });
    }
    assert.equal(callbacks, 0);
  } finally { await database.shutdown(); await database.close(); }
});

test('retained outer notifications reject inactive without poisoning committed mutation and endpoint receipts', async () => {
  let retainedMutation, retainedEndpoint;
  const f = await fixture(() => null, {
    mutations: { retainNotification: mutation(async ctx => ctx.resources.run({ ...options(), operationId: 'retained-notification-mutation' }, async scope => { retainedMutation = scope.notifications; await scope.db.writes.insert({ value: 'retained-notification-mutation' }); return { committed: true }; })) },
    endpoints: { retainNotification: endpoint({ method: 'POST', path: '/retain-notification' }, async ctx => ctx.resources.run({ ...options(), operationId: 'retained-notification-endpoint' }, async scope => { retainedEndpoint = scope.notifications; await scope.db.writes.insert({ value: 'retained-notification-endpoint' }); return { committed: true }; })) },
  });
  const request = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  try {
    assert.equal((await runMutation(f.database, actor, 'retainNotification', [])).ok, true);
    assert.deepEqual(await runEndpoint(f.database, f.database.endpoints.find(item => item.name === 'retainNotification'), new URL('http://capsule.test/retain-notification'), request), { committed: true });
    for (const retained of [retainedMutation, retainedEndpoint]) assert.throws(() => retained.accept({}), { code: 'RESOURCE_SCOPE_INACTIVE' });
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM writes WHERE value LIKE 'retained-notification-%'").get().n, 2);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE operationId LIKE 'retained-notification-%'").get().n, 2);
  } finally { await f.close(); }
});
