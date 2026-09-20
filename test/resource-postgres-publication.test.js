import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createControllableRuntimeClock, createPostgresDatabaseAdapter, openDevDatabase, runEndpoint, runMutation } from '../dist/server-runtime-source.js';
import { endpoint, mutation, String as Text, table } from '../dist/server.js';
import { resolveAnonymousSession } from '../dist/auth-runtime.js';
import { runNotificationIntentDeliveryPass, stopNotificationIntentWorker } from '../dist/notification-intent-runtime.js';
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from './support/database-adapter-engines.js';

const CALLBACK_TIMEOUT_MS = 2_000;
const actor = { userId: 'publication-actor', displayName: 'Publication actor', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const RESOURCE_SCHEMAS = [
  ['sporades_resource_locks', ['resourceTable', 'resourceId']],
  ['sporades_resource_receipts', ['resourceTable', 'resourceId', 'operationId', 'inputDigest', 'actorDigest', 'resultJson', 'intentIdsJson', 'committedAt']],
  ['sporades_notification_intents', ['resourceTable', 'resourceId', 'operationId', 'intentId', 'payloadDigest', 'payloadJson', 'messageId', 'acceptedAt']],
  ['sporades_notification_recipients', ['resourceTable', 'resourceId', 'operationId', 'intentId', 'recipient', 'state', 'attemptCount', 'currentAttemptToken', 'currentAttemptDeadline', 'nextAttemptAt', 'lastOutcomeCategory', 'updatedAt']],
  ['sporades_notification_attempts', ['resourceTable', 'resourceId', 'operationId', 'intentId', 'recipient', 'attemptToken', 'sequence', 'reservedAt', 'deadline', 'completedAt', 'outcomeCategory']],
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
    await reset.exec('DROP TABLE IF EXISTS sporades_notification_attempts, sporades_notification_recipients, sporades_notification_intents, sporades_resource_receipts, sporades_resource_locks');
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

test('Postgres resource notification acceptance and per-recipient delivery use the shared durable schema', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['anchors']);
  await reset.exec('DROP TABLE IF EXISTS sporades_notification_attempts, sporades_notification_recipients, sporades_notification_intents, sporades_resource_receipts, sporades_resource_locks');
  await reset.close();
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const deliveries = [];
  const config = { name: 'postgres-notification-intent', services: { database: { engine: 'postgres' } }, mail: { smtp: { vendor: 'generic', host: '127.0.0.1', port: 2525, tls: { mode: 'disabled' }, auth: { method: 'none' }, defaultFrom: 'sender@example.com' } } };
  const database = await openDevDatabase('postgres-notification-intent', '', { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() }, config, {
    schema: { anchors: table({ value: Text() }) },
    mutations: {
      accept: mutation(ctx => ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'notify', input: null }, scope => scope.notifications.accept({ id: 'notice', to: ['one@example.com'], subject: 'Notice', text: 'Body' }))),
      status: mutation(ctx => ctx.resources.status({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'notify' })),
    },
  }, { clock, mailTransportFactoryTrusted: true, mailTransportFactory: () => ({ async send(message) { deliveries.push(message); return { messageId: message.messageId, accepted: [message.to[0].email], rejected: [] }; }, close() {} }) });
  try {
    await database.init(); await stopNotificationIntentWorker(database);
    await database.adapter.prepare('INSERT INTO anchors (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'postgres');
    assert.deepEqual(await runMutation(database, actor, 'accept', []), { ok: true, data: { id: 'notice', state: 'staged' }, error: null });
    assert.equal(await runNotificationIntentDeliveryPass(database), true);
    const status = (await runMutation(database, actor, 'status', [])).data;
    assert.equal(status.intents[0].state, 'acknowledged');
    assert.equal(deliveries.length, 1);
  } finally { await database.shutdown(); await database.close(); }
});
