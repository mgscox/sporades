import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { openDevDatabase, createSqliteDatabaseAdapter } from '../dist/server-runtime-source.js';
import { table, String as Text } from '../dist/server.js';

function worker(file) {
  const child = fork(new URL('./support/resource-process-worker.js', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const backlog = new Map(); const waiting = new Map();
  child.on('message', message => {
    if (waiting.has(message.kind)) { waiting.get(message.kind)(message); waiting.delete(message.kind); }
    else backlog.set(message.kind, message);
  });
  return {
    child,
    send(kind, data = {}) { child.send({ kind, ...data }); },
    async wait(kind) {
      if (backlog.has(kind)) { const message = backlog.get(kind); backlog.delete(kind); return message; }
      let timer;
      try { return await Promise.race([
        new Promise(resolve => waiting.set(kind, resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`worker barrier timeout: ${kind}`)), 10_000); }),
      ]); } finally { clearTimeout(timer); }
    },
  };
}
async function stopAtBarrier(worker) {
  worker.child.kill('SIGSTOP');
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(worker.child.pid)], { encoding: 'utf8' });
    if (state.includes('T')) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('owner did not enter the OS stopped state');
}
async function setup(fail = false, sameOperation = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'resource-process-'));
  const file = path.join(dir, 'data.db');
  const database = await openDevDatabase(file, '', {}, { name: 'resource-process' }, { schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) } });
  const time = '2030-01-01T00:00:00.000Z';
  database.adapter.prepare('INSERT INTO anchors VALUES (?,?,?,?)').run('anchor', time, time, 'original');
  database.adapter.prepare('INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)').run('actor', time, 'Actor', null, null, 0, 1, 'anonymous');
  for (const id of ['a', 'b']) database.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory) VALUES (?,'work','actor','actor',?,'queued',?,0,?,?, '[]')").run(id, JSON.stringify({ operation: sameOperation ? 'shared' : id, fail: id === 'a' && fail }), time, time, '{"maxAttempts":2,"delayMs":0}');
  await database.close();
  const a = worker(file); await a.wait('ready');
  const b = worker(file); await b.wait('ready');
  a.send('start'); await a.wait('claimed');
  b.send('start'); await b.wait('claimed');
  const read = await createSqliteDatabaseAdapter(file, { readOnly: true });
  return { a, b, read, file, async close() {
    for (const w of [a, b]) { if (w.child.exitCode === null && w.child.signalCode === null) { const exited = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exited; } }
    await read.close(); await rm(dir, { recursive: true, force: true });
  } };
}

for (const fail of [false, true]) test(`independent runtime workers: deterministic winner, immediate busy loser, ${fail ? 'rollback' : 'commit'}`, async () => {
  const f = await setup(fail);
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    f.b.send('acquire');
    assert.equal((await f.b.wait('outcome')).code, 'RESOURCE_BUSY');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.a.send('release');
    assert.equal((await f.a.wait('outcome')).code, fail ? 'CALLBACK_FAILED' : 'COMMITTED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, fail ? 0 : 1);
    f.a.send('late'); assert.equal((await f.a.wait('late')).code, 'RESOURCE_SCOPE_INACTIVE');
    f.a.send('settle'); await f.a.wait('settled'); f.b.send('settle'); await f.b.wait('settled');
  } finally { await f.close(); }
});

test('stopped owner holds SQLite authority beyond the fixed deadline; kill releases engine, restart retains claim', async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    await stopAtBarrier(f.a);
    f.b.send('advance', { ms: 30_001 }); await f.b.wait('advanced');
    // Both resource and cancellation writers remain excluded, even though the
    // independent observer's logical clock has passed the original deadline.
    const competing = await createSqliteDatabaseAdapter(f.file);
    assert.throws(() => competing.prepare("UPDATE sporades_jobs SET cancelRequestedAt=? WHERE id='a'").run('2030-01-01T00:00:30.001Z'), error => error.errcode === 5);
    await assert.rejects(competing.withResourceTransaction(() => null), { code: 'RESOURCE_BUSY' });
    await competing.close();
    const exited = once(f.a.child, 'exit'); f.a.child.kill('SIGKILL'); await exited;
    const restarted = worker(f.file); await restarted.wait('ready');
    assert.equal(f.read.prepare("SELECT claimToken IS NOT NULL present FROM sporades_jobs WHERE id='a'").get().present, 1);
    const postKill = await createSqliteDatabaseAdapter(f.file);
    await postKill.withResourceTransaction(() => null);
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    await postKill.close();
    const stopped = once(restarted.child, 'exit'); restarted.child.kill('SIGKILL'); await stopped;
  } finally { await f.close(); }
});

test('cancellation committed before acquisition prevents callback entry', async () => {
  const f = await setup();
  try {
    const writer = await createSqliteDatabaseAdapter(f.file);
    writer.prepare("UPDATE sporades_jobs SET cancelRequestedAt=? WHERE id='a'").run('2030-01-01T00:00:00.001Z');
    await writer.close();
    f.a.send('acquire');
    assert.equal((await f.a.wait('outcome')).code, 'ABORTED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.a.send('settle'); await f.a.wait('settled');
  } finally { await f.close(); }
});

test('independent Grant revocation before Job acquisition denies current authority without callback work', async () => {
  const f = await setup();
  try {
    f.b.send('grant-change', { action: 'revoke' });
    assert.deepEqual(await f.b.wait('grant-change'), { kind: 'grant-change', code: 'COMMITTED', action: 'revoke' });
    f.a.send('acquire');
    assert.equal((await f.a.wait('outcome')).code, 'DENIED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.a.send('settle'); await f.a.wait('settled');
  } finally { await f.close(); }
});

test('independent Grant rotation before Job acquisition is observed before protected work begins', async () => {
  const f = await setup();
  try {
    f.b.send('grant-change', { action: 'rotate' });
    assert.equal((await f.b.wait('grant-change')).code, 'COMMITTED');
    assert.equal(f.read.prepare("SELECT value FROM anchors WHERE id='anchor'").get().value, 'rotated');
    f.a.send('acquire'); await f.a.wait('entered');
    f.a.send('release');
    assert.equal((await f.a.wait('outcome')).code, 'COMMITTED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 1);
    f.a.send('settle'); await f.a.wait('settled');
  } finally { await f.close(); }
});

for (const action of ['rotate', 'revoke']) test(`independent Grant ${action} after Job acquisition serializes until the resource commit`, async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    f.b.send('grant-change', { action });
    assert.equal((await f.b.wait('grant-change')).code, 'SQLITE_BUSY');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.a.send('release');
    assert.equal((await f.a.wait('outcome')).code, 'COMMITTED');
    f.b.send('grant-change', { action });
    assert.equal((await f.b.wait('grant-change')).code, 'COMMITTED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 1);
    if (action === 'revoke') assert.equal(f.read.prepare("SELECT count(*) n FROM anchors WHERE id='anchor'").get().n, 0);
    else assert.equal(f.read.prepare("SELECT value FROM anchors WHERE id='anchor'").get().value, 'rotated');
    f.a.send('settle'); await f.a.wait('settled');
  } finally { await f.close(); }
});

test('graceful shutdown rolls back an unsettled scope and rejects its late handle', async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    f.a.send('shutdown');
    assert.equal((await f.a.wait('outcome')).code, 'ABORTED');
    f.a.send('settle'); await f.a.wait('shutdown');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.a.send('late'); assert.equal((await f.a.wait('late')).code, 'RESOURCE_SCOPE_INACTIVE');
    const writer = await createSqliteDatabaseAdapter(f.file);
    await writer.withResourceTransaction(() => null); await writer.close();
  } finally { await f.close(); }
});

test('resumed owner past deadline rolls back instead of committing stale work', async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    await stopAtBarrier(f.a);
    // Queue the original-lease clock advance while the process is stopped.
    f.a.send('advance', { ms: 30_000, timers: false });
    f.a.child.kill('SIGCONT'); await f.a.wait('advanced');
    f.a.send('release');
    assert.equal((await f.a.wait('outcome')).code, 'RESOURCE_DEADLINE_EXCEEDED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
    f.b.send('acquire'); await f.b.wait('entered');
    f.b.send('release'); assert.equal((await f.b.wait('outcome')).code, 'COMMITTED');
  } finally { await f.close(); }
});

test('lost commit response followed by process death reconciles on an independent owned claim', async () => {
  const f = await setup(false, true);
  try {
    f.a.send('lose-response'); await f.a.wait('configured');
    f.a.send('acquire'); await f.a.wait('entered');
    f.a.send('release'); await f.a.wait('commit-response-lost');
    const exited = once(f.a.child, 'exit'); f.a.child.kill('SIGKILL'); await exited;
    f.b.send('acquire');
    assert.equal((await f.b.wait('outcome')).code, 'COMMITTED');
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 1);
    assert.equal(f.read.prepare('SELECT count(*) n FROM sporades_resource_receipts').get().n, 1);
    f.b.send('settle'); await f.b.wait('settled');
  } finally { await f.close(); }
});

test('independent cancellation cannot commit during scope; explicit retry after release cannot undo receipt', async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    f.b.send('acquire', { action: 'cancel' });
    assert.equal((await f.b.wait('cancel-first')).code, 'SQLITE_BUSY');
    assert.equal(f.read.prepare("SELECT cancelRequestedAt FROM sporades_jobs WHERE id='a'").get().cancelRequestedAt, null);
    f.a.send('release'); assert.equal((await f.a.wait('outcome')).code, 'COMMITTED');
    f.b.send('retry-cancel'); await f.b.wait('cancel-committed');
    assert.notEqual(f.read.prepare("SELECT cancelRequestedAt FROM sporades_jobs WHERE id='a'").get().cancelRequestedAt, null);
    assert.equal(f.read.prepare('SELECT count(*) n FROM sporades_resource_receipts').get().n, 1);
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 1);
  } finally { await f.close(); }
});

test('expired lease recovery cannot transfer a stopped owner claim before engine release', async () => {
  const f = await setup();
  try {
    f.a.send('acquire'); await f.a.wait('entered');
    await stopAtBarrier(f.a);
    f.b.send('advance', { ms: 30_001 }); await f.b.wait('advanced');
    f.b.send('recover'); assert.equal((await f.b.wait('recovered')).code, 'SQLITE_BUSY');
    assert.equal(f.read.prepare("SELECT status FROM sporades_jobs WHERE id='a'").get().status, 'running');
    const exited = once(f.a.child, 'exit'); f.a.child.kill('SIGKILL'); await exited;
    f.b.send('recover'); assert.equal((await f.b.wait('recovered')).code, 'COMMITTED');
    const recovered = f.read.prepare("SELECT status, claimToken FROM sporades_jobs WHERE id='a'").get();
    assert.equal(recovered.status, 'delayed'); assert.equal(recovered.claimToken, null);
    assert.equal(f.read.prepare('SELECT count(*) n FROM writes').get().n, 0);
  } finally { await f.close(); }
});
