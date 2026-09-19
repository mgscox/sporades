import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPostgresDatabaseAdapter } from '../dist/server-runtime-source.js';
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from './support/database-adapter-engines.js';

const BARRIER_TIMEOUT_MS = 5_000;

function childWorker() {
  const child = fork(new URL('./support/resource-postgres-process-worker.js', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, SPORADES_POSTGRES_TEST_URL: postgresTestUrl() },
  });
  const backlog = new Map();
  const waiting = new Map();
  let stderr = '';
  let exited;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    const resolve = waiting.get(message.kind);
    if (resolve) { waiting.delete(message.kind); resolve(message); }
    else backlog.set(message.kind, message);
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('error', error => { exited = error; });
  child.on('disconnect', () => { exited ??= new Error('worker IPC disconnected'); });
  const wait = async (kind) => {
    if (backlog.has(kind)) { const message = backlog.get(kind); backlog.delete(kind); return message; }
    let timer;
    try {
      return await Promise.race([
        new Promise(resolve => waiting.set(kind, resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`PostgreSQL worker timed out at ${kind}; stderr: ${stderr}`)), BARRIER_TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(timer); waiting.delete(kind); }
  };
  return {
    child, wait, exit,
    send(kind) { if (child.connected) child.send({ kind }); },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, BARRIER_TIMEOUT_MS))]);
      if (exited && !(exited instanceof Error && exited.message === 'worker IPC disconnected')) throw exited;
    },
  };
}

test('real PostgreSQL process death releases the resource lock and rolls back protected writes and receipt', { skip: POSTGRES_SKIP_REASON }, async () => {
  const setup = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  const owner = childWorker();
  try {
    await resetPostgresSchema(setup, ['ticket04_process_writes']);
    await setup.exec('CREATE TABLE ticket04_process_writes (owner TEXT NOT NULL)');
    await setup.exec('CREATE TABLE sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))');
    await owner.wait('ready'); owner.send('start'); await owner.wait('entered');

    owner.child.kill('SIGKILL');
    const termination = await owner.exit;
    assert.equal(termination.signal, 'SIGKILL');

    const successor = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try {
      await successor.withResourceTransaction(async transaction => {
        await transaction.prepare("INSERT INTO ticket04_process_writes (owner) VALUES ('B')").run();
      }, undefined, { table: 'anchors', id: 'anchor' });
      assert.equal(Number((await successor.prepare("SELECT count(*) AS n FROM ticket04_process_writes WHERE owner LIKE 'A%'").get()).n), 0);
      assert.equal(Number((await successor.prepare("SELECT count(*) AS n FROM sporades_resource_receipts WHERE operationId='process-death'").get()).n), 0);
      assert.equal(Number((await successor.prepare("SELECT count(*) AS n FROM ticket04_process_writes WHERE owner='B'").get()).n), 1);
    } finally { await successor.close(); }
  } finally {
    await owner.stop();
    await setup.close();
  }
});
