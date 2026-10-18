import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createEndpointDatabaseApi, openDevDatabase } from '../dist/server-runtime-source.js';
import { String, table } from '../dist/server.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

// A child keeps the real unhandled-rejection path observable without teaching the
// test runner to swallow it. The connection gate, query cleanup and ACL are real.
async function queuedReadProbe({ openDevDatabase, runQuery, query, String, table }) {
  const { default: assert } = await import('node:assert/strict');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-read-lifecycle-'));
  const unhandled = [];
  process.on('unhandledRejection', error => unhandled.push(error.stack));
  const actor = { userId: 'owner', displayName: 'Owner', email: null, picture: null,
    isAuthenticated: true, isGuest: false, provider: 'email' };
  let aclCalls = 0;
  const definition = { schema: { notes: table({ ownerId: String(), text: String() }).acl({
    read: ({ row, ctx }) => { aclCalls++; return row.ownerId === ctx.auth.userId; },
  }) }, queries: {
    discarded: query((ctx, method) => { ctx.db.notes[method](); return 'handler finished'; }),
  } };
  const db = await openDevDatabase(path.join(root, 'data.db'), '', {}, { name: 'read-lifecycle' }, definition);
  try {
    await db.adapter.insertAppRow(db.schema.tables[0], { id: 'note', ownerId: 'owner', text: 'private-row',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    for (const method of ['get', 'all']) {
      let release, entered;
      const held = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      const transaction = db.adapter.withTransaction(async () => { entered(); await held; });
      await ready;
      try {
        const result = await runQuery(db, actor, 'discarded', [method]);
        assert.equal(result.error, null);
        assert.equal(result.data, 'handler finished');
      } finally { release(); await transaction; }
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(JSON.stringify({ unhandled, aclCalls }));
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
}

for (const bundled of [false, true]) {
  test(`discarded reads queued behind a transaction cannot outlive query authority or crash (${bundled ? 'shipped Bundle' : 'modules'})`, async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-read-lifecycle-'));
    try {
      const imports = `
        import { openDevDatabase as probeOpen, runQuery as probeRun } from ${JSON.stringify(path.join(process.cwd(), 'dist/server-runtime-source.js'))};
        import { query as probeQuery, String as probeString, table as probeTable } from ${JSON.stringify(path.join(process.cwd(), 'dist/server.js'))};
      `;
      const probe = `${queuedReadProbe.toString()}
        await queuedReadProbe({ openDevDatabase: probeOpen, runQuery: probeRun,
          query: probeQuery, String: probeString, table: probeTable });`;
      const program = bundled ? await createServerBundleModuleSource({
        config: { name: 'read-lifecycle' }, serverEnv: {}, serverSource: '',
        serverModuleSource: 'export default { name: "read-lifecycle" };',
        epilogue: imports + probe + '\nawait shutdown();',
      }) : imports + probe;
      const filename = path.join(root, 'probe.mjs');
      await writeFile(filename, program);
      const child = spawnSync(process.execPath, [filename], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: {
        ...process.env, PORT: '0', SPORADES_DATABASE_PATH: path.join(root, 'entry.db'),
        SPORADES_CONFIG_DIR: path.join(root, 'config'),
      } });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const result = JSON.parse(child.stdout.trim());
      assert.deepEqual(result.unhandled, [], 'abandoned reads must never reach the fatal-restart policy');
      assert.equal(result.aclCalls, 0, 'expired reads must fail closed before invoking Capsule ACL code');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

async function withReadDatabase(read, run) {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-read-lifecycle-'));
  const notes = table({ ownerId: String(), text: String() });
  const db = await openDevDatabase(path.join(root, 'data.db'), '', {}, { name: 'read-lifecycle' }, {
    schema: { notes: read ? notes.acl({ read }) : notes },
  });
  try {
    await db.adapter.insertAppRow(db.schema.tables[0], { id: 'note', ownerId: 'owner', text: 'private-row',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await run(db);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
}

for (const method of ['get', 'all']) {
  test(`${method} preserves awaited ACL allow, deny and rejection`, async () => {
    const failure = new Error('private-policy-failure');
    await withReadDatabase(async ({ row, ctx }) => {
      if (ctx.auth.userId === 'broken') throw failure;
      return row.ownerId === ctx.auth.userId;
    }, async db => {
      const forActor = userId => createEndpointDatabaseApi(db, () => ({ auth: { userId } })).notes[method]();
      const allowed = await forActor('owner');
      assert.equal((method === 'get' ? allowed : allowed[0]).text, 'private-row');
      assert.deepEqual(await forActor('other'), method === 'get' ? null : []);
      await assert.rejects(forActor('broken'), error => error === failure);
    });
  });

  test(`${method} rejects opaquely if its context expires during an async ACL`, async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await withReadDatabase(async () => { await held; return true; }, async db => {
      let context = { auth: { userId: 'owner' } };
      const api = createEndpointDatabaseApi(db, () => context).notes;
      const read = api[method]();
      context = null;
      release();
      await assert.rejects(read, error => {
        assert.equal(error.code, 'DENIED');
        assert.equal(error.message, 'Denied.');
        assert.doesNotMatch(error.message + error.hint, /owner|private-row|notes/);
        return true;
      });
      assert.throws(() => api[method](), { code: 'DENIED', message: 'Denied.' });
    });
  });

  test(`${method} cannot return unprotected rows after its handler expires`, async () => {
    await withReadDatabase(undefined, async db => {
      let context = { auth: { userId: 'owner' } };
      let release, entered;
      const held = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      const transaction = db.adapter.withTransaction(async () => { entered(); await held; });
      await ready;
      const read = createEndpointDatabaseApi(db, () => context).notes[method]();
      context = null;
      release();
      await transaction;
      await assert.rejects(read, { code: 'DENIED', message: 'Denied.' });
    });
  });
}
