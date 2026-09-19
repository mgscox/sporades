import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPostgresDatabaseAdapter, openDevDatabase, runMutation } from '../dist/server-runtime-source.js';
import { createPublicFileUrl, deletePrivateFile } from '../dist/file-storage-runtime.js';
import { mutation, String as Text, table } from '../dist/server.js';
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from './support/database-adapter-engines.js';

const actor = {
  userId: 'acl-contention-user',
  displayName: 'ACL contention user',
  email: null,
  picture: null,
  isAuthenticated: true,
  isGuest: false,
  provider: 'email',
};

const busyError = {
  code: 'RESOURCE_BUSY',
  message: 'Resource transaction is busy.',
};

async function settlePromptly(promise, label) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 500)),
  ]);
}

async function openAclDatabase(name, definition) {
  const database = await openDevDatabase(
    name,
    '',
    {
      SPORADES_SERVICE_DATABASE_ENGINE: 'postgres',
      SPORADES_SERVICE_DATABASE_URL: postgresTestUrl(),
    },
    { name, services: { database: { engine: 'postgres' } } },
    definition,
  );
  await database.init();
  return database;
}

test('ordinary Postgres ACL dependency contention returns an opaque busy mutation result', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['documents', 'policies']);
  await reset.close();
  const database = await openAclDatabase('ordinary-acl-contention', {
    schema: {
      documents: table({ value: Text() }).acl({
        update: ({ ctx }) => ctx.acl.db.exists('policies', 'allow'),
      }),
      policies: table({ value: Text() }),
    },
    mutations: {
      update: mutation(ctx => ctx.db.documents.update('document', { value: 'changed' })),
    },
  });
  let blocker;
  try {
    const now = '2030-01-01T00:00:00.000Z';
    await database.adapter.prepare('INSERT INTO documents (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('document', now, now, 'original');
    await database.adapter.prepare('INSERT INTO policies (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('allow', now, now, 'allowed');
    blocker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await blocker.exec('BEGIN');
    await blocker.exec('LOCK TABLE policies IN ACCESS EXCLUSIVE MODE');

    const result = await settlePromptly(runMutation(database, actor, 'update', []), 'ordinary ACL contention');
    assert.equal(result.ok, false);
    assert.deepEqual({ code: result.error.code, message: result.error.message }, busyError);
    assert.equal('detail' in result.error, false);
    assert.equal('relation' in result.error, false);
    assert.equal((await database.adapter.prepare('SELECT value FROM documents WHERE id=?').get('document')).value, 'original');
  } finally {
    await blocker?.exec('ROLLBACK').catch(() => {});
    await blocker?.close();
    await database.shutdown();
    await database.close();
  }
});

for (const operation of ['publicUrl', 'delete']) {
  test(`Postgres File ${operation} ACL dependency contention returns an opaque busy error`, { skip: POSTGRES_SKIP_REASON }, async () => {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    await resetPostgresSchema(reset, []);
    await reset.close();
    const database = await openAclDatabase(`file-${operation}-acl-contention`, {
      files: {
        acl: {
          [operation]: ({ ctx }) => ctx.acl.teams.isMember('55555555-5555-4555-8555-555555555555'),
        },
      },
    });
    let blocker;
    let byteDeletes = 0;
    try {
      database.fileStorage = { async deleteFileVersion() { byteDeletes++; }, close() {} };
      const now = '2030-01-01T00:00:00.000Z';
      await database.adapter.prepare('INSERT INTO sporades_teams (id,name,"createdAt","createdByUserId") VALUES (?,?,?,?)').run('55555555-5555-4555-8555-555555555555', 'Contention Team', now, actor.userId);
      await database.adapter.prepare('INSERT INTO sporades_team_memberships ("teamId","userId",role,"createdAt") VALUES (?,?,?,?)').run('55555555-5555-4555-8555-555555555555', actor.userId, 'member', now);
      await database.adapter.createFileBucket({ id: `bucket-${operation}`, ownerId: 'owner', name: 'default', createdAt: now });
      await database.adapter.insertFileRow({ id: `file-${operation}`, ownerId: 'owner', bucketId: `bucket-${operation}`, bucketName: 'default', path: `/shared/${operation}.txt`, name: `${operation}.txt`, type: 'text/plain', size: 5, version: 'version-1', status: 'uploaded', createdAt: now, updatedAt: now });
      blocker = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
      await blocker.exec('BEGIN');
      await blocker.exec('LOCK TABLE sporades_team_memberships IN ACCESS EXCLUSIVE MODE');

      const attempt = operation === 'publicUrl'
        ? createPublicFileUrl(database, actor, `file-${operation}`, { noExpiry: true })
        : deletePrivateFile(database, actor, `file-${operation}`);
      await assert.rejects(
        settlePromptly(attempt, `File ${operation} ACL contention`),
        error => {
          assert.deepEqual({ code: error?.code, message: error?.message }, busyError);
          assert.equal(error?.retryable, true);
          assert.equal('detail' in error, false);
          assert.equal('relation' in error, false);
          return true;
        },
      );
      assert.equal(Number((await database.adapter.prepare('SELECT count(*) n FROM sporades_file_public_urls WHERE "fileId"=?').get(`file-${operation}`)).n), 0);
      assert.equal((await database.adapter.prepare('SELECT "deletedAt" FROM sporades_files WHERE id=?').get(`file-${operation}`)).deletedAt, null);
      assert.equal(byteDeletes, 0);
    } finally {
      await blocker?.exec('ROLLBACK').catch(() => {});
      await blocker?.close();
      await database.shutdown();
      await database.close();
    }
  });
}

test('an unrelated Postgres 55P03 raised after ACL dependency locking retains its existing mutation error', { skip: POSTGRES_SKIP_REASON }, async () => {
  const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  await resetPostgresSchema(reset, ['documents', 'policies']);
  await reset.close();
  const database = await openAclDatabase('unrelated-lock-error', {
    schema: {
      documents: table({ value: Text() }).acl({
        update: ({ ctx }) => ctx.acl.db.exists('policies', 'allow'),
      }),
      policies: table({ value: Text() }),
    },
    mutations: {
      update: mutation(ctx => ctx.db.documents.update('document', { value: 'changed' })),
    },
  });
  try {
    const now = '2030-01-01T00:00:00.000Z';
    await database.adapter.prepare('INSERT INTO documents (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('document', now, now, 'original');
    await database.adapter.prepare('INSERT INTO policies (id,"createdAt","updatedAt",value) VALUES (?,?,?,?)').run('allow', now, now, 'allowed');
    await database.adapter.exec(`CREATE OR REPLACE FUNCTION sporades_test_unrelated_lock_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unrelated write lock marker' USING ERRCODE = '55P03'; END $$`);
    await database.adapter.exec('CREATE TRIGGER sporades_test_unrelated_lock_error BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION sporades_test_unrelated_lock_error()');

    const result = await runMutation(database, actor, 'update', []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, '55P03');
    assert.match(result.error.message, /unrelated write lock marker/);
    assert.notEqual(result.error.message, busyError.message);
    assert.equal((await database.adapter.prepare('SELECT value FROM documents WHERE id=?').get('document')).value, 'original');
  } finally {
    await database.shutdown();
    await database.close();
  }
});
