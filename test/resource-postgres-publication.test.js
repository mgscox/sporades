import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createControllableRuntimeClock, createPostgresDatabaseAdapter, openDevDatabase, runEndpoint, runMutation } from '../dist/server-runtime-source.js';
import { endpoint, mutation, String as Text, table } from '../dist/server.js';
import { resolveAnonymousSession } from '../dist/auth-runtime.js';
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from './support/database-adapter-engines.js';

const CALLBACK_TIMEOUT_MS = 2_000;
const actor = { userId: 'publication-actor', displayName: 'Publication actor', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const RESOURCE_SCHEMAS = [
  ['sporades_resource_locks', ['resourceTable', 'resourceId']],
  ['sporades_resource_receipts', ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt']],
];

async function waitFor(callbackEntered, label) {
  await Promise.race([
    callbackEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not enter its protected callback`)), CALLBACK_TIMEOUT_MS)),
  ]);
}

async function assertPublishedResourceSchemaAndHiddenWrite(probe, writeTable, writeValue) {
  for (const [tableName, expectedColumns] of RESOURCE_SCHEMAS) {
    const columns = await probe.prepare(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position',
    ).all(tableName);
    assert.deepEqual(columns.map(row => row.column_name), expectedColumns, `${tableName} is published with its exact declared columns before the callback is released`);
  }
  assert.equal(Number((await probe.prepare(`SELECT count(*) AS n FROM ${writeTable} WHERE value=?`).get(writeValue)).n), 0, 'the held callback write remains uncommitted to an independent connection');
}

test('Postgres dedicated resource first use publishes lock and receipt schema before its held callback, while hiding application writes', { skip: POSTGRES_SKIP_REASON }, async () => {
  const setup = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  let release;
  const callbackEntered = Promise.withResolvers();
  const callbackRelease = new Promise(resolve => { release = resolve; });
  try {
    await resetPostgresSchema(setup, ['ticket04_publication_adapter_writes']);
    await setup.exec('CREATE TABLE ticket04_publication_adapter_writes (value TEXT NOT NULL)');
    const owner = setup.withResourceTransaction(async transaction => {
      await transaction.prepare('INSERT INTO ticket04_publication_adapter_writes (value) VALUES (?)').run('adapter-held');
      callbackEntered.resolve();
      await callbackRelease;
      return 'adapter-committed';
    }, undefined, { table: 'publication-adapter', id: 'owner' });
    await waitFor(callbackEntered.promise, 'dedicated resource owner');

    const probe = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await assertPublishedResourceSchemaAndHiddenWrite(probe, 'ticket04_publication_adapter_writes', 'adapter-held');
      assert.equal(await probe.withResourceTransaction(async () => 'distinct-resource-entered', undefined, { table: 'publication-adapter', id: 'distinct' }), 'distinct-resource-entered');
    } finally { await probe.close(); }

    release();
    assert.equal(await owner, 'adapter-committed');
    assert.equal(Number((await setup.prepare("SELECT count(*) AS n FROM ticket04_publication_adapter_writes WHERE value='adapter-held'").get()).n), 1);
  } finally {
    release?.();
    await setup.close();
  }
});

test('Postgres public mutation and endpoint first use publish schema before held callbacks while hiding outer writes', { skip: POSTGRES_SKIP_REASON }, async () => {
  for (const kind of ['mutation', 'endpoint']) {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, ['anchors', 'writes']);
    await reset.exec('DROP TABLE IF EXISTS sporades_resource_receipts, sporades_resource_locks');
    await reset.close();

    const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
    let release;
    const callbackEntered = Promise.withResolvers();
    const callbackRelease = new Promise(resolve => { release = resolve; });
    const writeValue = `${kind}-held`;
    const runProtected = async ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: `publication-${kind}`, input: { kind } }, async scope => {
      await scope.db.writes.insert({ value: writeValue });
      callbackEntered.resolve();
      await callbackRelease;
      return `${kind}-committed`;
    });
    const database = await openDevDatabase(`postgres-publication-${kind}`, '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, { name: `postgres-publication-${kind}`, services: { database: { engine: 'postgres' } } }, {
      schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
      mutations: kind === 'mutation' ? { write: mutation(runProtected) } : {},
      endpoints: kind === 'endpoint' ? { write: endpoint({ method: 'POST', path: '/publication' }, runProtected) } : {},
    }, { clock });
    try {
      await database.init();
      await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'publication');
      let invocation;
      if (kind === 'mutation') invocation = runMutation(database, actor, 'write', []);
      else {
        const session = await resolveAnonymousSession(database, null);
        const route = database.endpoints.find(item => item.path === '/publication');
        invocation = runEndpoint(database, route, new URL('http://capsule.test/publication'), { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} });
      }
      await waitFor(callbackEntered.promise, `public ${kind}`);

      const probe = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      try {
        await assertPublishedResourceSchemaAndHiddenWrite(probe, 'writes', writeValue);
      } finally { await probe.close(); }

      release();
      if (kind === 'mutation') assert.deepEqual(await invocation, { ok: true, data: 'mutation-committed', error: null });
      else assert.equal(await invocation, 'endpoint-committed');
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) AS n FROM writes WHERE value=?').get(writeValue)).n), 1);
    } finally {
      release?.();
      await database.shutdown();
      await database.close();
    }
  }
});
