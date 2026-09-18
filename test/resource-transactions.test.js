import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDevDatabase, runMutation, runEndpoint, runCurrentUserJobWorker, createControllableRuntimeClock } from '../dist/server-runtime-source.js';
import { table, String as Text, endpoint, job, mutation, schedule } from '../dist/server.js';
import { createSqliteDatabaseAdapter } from '../dist/database-runtime.js';
import { resourceCanonicalJson, bindJobResources, bindOuterResources } from '../dist/resource-runtime.js';

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

test('the outer watchdog aborts the real pending-log cleanup phase after a completed resource scope', async () => {
  let entered;
  const inserted = new Promise(resolve => { entered = resolve; });
  let draining;
  const drainStarted = new Promise(resolve => { draining = resolve; });
  const cleanupPending = new Promise(() => {});
  const f = await fixture(() => null, { mutations: { cleanupDeadline: mutation(async ctx => {
    await ctx.resources.run({ ...options(), operationId: 'cleanup-deadline' }, () => true);
    ctx.log.info('post-scope outcome');
    entered();
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
      return cleanupPending;
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
