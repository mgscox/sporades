// EXPERIMENT ONLY: counterexamples, not production resource-fence conformance.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSqliteDatabaseAdapter } from '../../dist/server-runtime-source.js';
import { withPostgresAdapter } from '../../test/support/database-adapter-engines.js';
import { receiver } from './smtp.mjs';

const trace = process.env.SPORADES_FENCE_TRACE;
let sequence = 0;
function record(scenario, event, details = {}) {
  const row = { sequence: ++sequence, scenario, event, ...details };
  if (trace) appendFileSync(trace, `${JSON.stringify(row)}\n`);
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Barrier timed out: ${label}`);
    await delay(5); // Wait for observed state, never choose a concurrency winner by timing.
  }
}
async function worker(engine, file, owner, log) {
  const child = fork(new URL('./worker.mjs', import.meta.url), [engine, file, owner], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let id = 0;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker readiness timeout')), 10000);
    child.on('message', message => {
      if (message.ready) { clearTimeout(timeout); resolve(message); return; }
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id); clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('worker exited before ready')); });
  });
  child.on('exit', () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timeout); pending.reject(new Error('worker exited')); }
    waiting.clear();
  });
  // Do not relay arbitrary stderr (connection errors can contain URLs).
  child.stderr.resume();
  let info;
  try { info = await ready; } catch (error) { child.kill('SIGKILL'); throw error; }
  log('worker-ready', { owner, ...info });
  return {
    ...info, child,
    async call(op, args = {}) {
      const request = ++id;
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(request); reject(new Error(`worker ${owner} ${op} timeout`)); }, 10000);
        waiting.set(request, { resolve, reject, timeout });
        child.send({ id: request, op, ...args });
      });
      log(`worker-${op}`, { owner, ...result });
      return result;
    },
    async stop() {
      child.kill('SIGSTOP');
      await until(() => execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).includes('T'), 'OS process stopped');
      log('process-stopped', { owner, pid: child.pid });
    },
    resume() { child.kill('SIGCONT'); log('process-resumed', { owner, pid: child.pid }); },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL');
      await exited; log('process-dead', { owner, pid: child.pid });
    },
  };
}
async function fixture(engine, name, body, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sporades-fence-proof-'));
  const file = path.join(dir, 'proof.db');
  const log = (event, details) => record(`${engine}/${name}`, event, details);
  async function exercise(db) {
    const sql = db.dialect.sql;
    const get = (query, ...args) => db.prepare(sql(query)).get(...args);
    await db.exec('CREATE TABLE experiment_resource (id INTEGER PRIMARY KEY, owner TEXT, generation INTEGER NOT NULL, expires BIGINT NOT NULL, value INTEGER NOT NULL)');
    await db.exec('INSERT INTO experiment_resource VALUES (1, NULL, 0, 0, 0)');
    const workers = [];
    const smtp = await receiver(log, options);
    const spawn = async owner => { const w = await worker(engine, file, owner, log); workers.push(w); return w; };
    try {
      const a = await spawn('A'), b = await spawn('B');
      assert.notEqual(a.pid, b.pid);
      if (engine === 'postgres') assert.notEqual(a.backend, b.backend);
      const observe = async () => { const row = await get('SELECT * FROM [experiment_resource] WHERE [id]=1'); log('database-observed', row); return row; };
      const loseConnection = async () => {
        assert.equal(engine, 'postgres');
        const result = await get('SELECT pg_terminate_backend(?) AS terminated', a.backend);
        assert.equal(result.terminated, true);
        await until(async () => Number((await get('SELECT COUNT(*) AS n FROM pg_stat_activity WHERE pid=?', a.backend)).n) === 0, 'database backend terminated');
        log('database-connection-lost', { owner: 'A', backend: a.backend });
      };
      await body({ a, b, smtp, spawn, observe, loseConnection, log });
    } finally {
      for (const w of workers) await w.kill();
      await smtp.close();
      await db.exec('DROP TABLE experiment_resource');
    }
  }
  try {
    if (engine === 'postgres') {
      // Required, never skipped: same dedicated URL/reset guard as the repository harness.
      await withPostgresAdapter(exercise, { appTableNames: ['experiment_resource'] });
    } else {
      const db = await createSqliteDatabaseAdapter(file);
      try { await exercise(db); } finally { await db.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function check(w, now = 0) { assert.equal((await w.call('check', { now })).authorized, true); }
async function send(w, smtp, extra = {}) { return w.call('submit', { port: smtp.port, operation: 'same-effect', ...extra }); }
async function transaction(w) { assert.equal((await w.call('begin')).acquired, true); }
async function lease(w, now = 0) { assert.equal((await w.call('lease', { now })).acquired, true); }

for (const engine of ['sqlite', 'postgres']) {
  test(`${engine}: independent transaction winner/loser and no partial state`, { timeout: 30000 }, () => fixture(engine, 'contention', async ({ a, b, smtp, observe }) => {
    await transaction(a); await check(a);
    const loser = await b.call('begin'); assert.equal(loser.acquired, false); assert.equal(loser.reason, 'contended');
    await assert.rejects(send(b, smtp), /callback barrier was not entered/);
    assert.equal((await observe()).owner, null);
    assert.equal((await send(a, smtp)).acknowledged, true);
    assert.equal((await a.call('mutate')).changed, 1); await a.call('commit');
    await transaction(b); await check(b); await b.call('rollback');
    const row = await observe(); assert.equal(row.owner, 'A'); assert.equal(Number(row.value), 1);
    assert.deepEqual(smtp.accepted.map(x => x.owner), ['A']);
  }));
  test(`${engine}: process death releases transaction; new process recovers`, { timeout: 30000 }, () => fixture(engine, 'death', async ({ a, b, smtp, spawn, observe }) => {
    await transaction(a); await check(a);
    assert.equal((await b.call('begin')).acquired, false);
    await a.kill();
    const restarted = await spawn('A-restarted');
    await transaction(b); await check(b);
    assert.equal((await restarted.call('begin')).acquired, false);
    await send(b, smtp); await b.call('commit');
    assert.equal((await observe()).owner, 'B');
    assert.deepEqual(smtp.accepted.map(x => x.owner), ['B']);
  }));
  test(`${engine}: live SIGSTOP owner outlives lease; conditional DB write fenced, SMTP not fenced`, { timeout: 30000 }, () => fixture(engine, 'paused-expiry', async ({ a, b, smtp, observe, log }) => {
    await lease(a); await check(a); // Last ownership check, immediately before submission.
    assert.equal((await b.call('lease', { now: 29999 })).acquired, false);
    await a.stop();
    log('logical-clock-advanced', { now: 30001, leaseDuration: 30000 });
    await lease(b, 30001); await check(b, 30001); await send(b, smtp);
    assert.equal((await observe()).owner, 'B');
    a.resume();
    const stale = await send(a, smtp, { abort: true });
    assert.equal(stale.callbackContinued, true); assert.equal(stale.abortObserved, true); assert.equal(stale.acknowledged, true);
    assert.equal((await a.call('mutate', { now: 30001 })).changed, 0);
    assert.deepEqual(smtp.accepted.map(x => x.owner), ['B', 'A']);
    assert.equal((await observe()).owner, 'B');
  }));
  test(`${engine}: restart retains durable lease until expiry`, { timeout: 30000 }, () => fixture(engine, 'restart', async ({ a, b, smtp, spawn, observe }) => {
    await lease(a); await check(a); await a.kill();
    assert.equal((await observe()).owner, 'A');
    const restarted = await spawn('A-restarted');
    assert.equal((await restarted.call('lease', { now: 29999 })).acquired, false);
    await lease(b, 30001); await check(b, 30001);
    assert.equal((await restarted.call('lease', { now: 30001 })).acquired, false);
    await send(b, smtp); assert.deepEqual(smtp.accepted.map(x => x.owner), ['B']);
  }));
  test(`${engine}: held transaction cannot honor a new 30-second lease takeover`, { timeout: 30000 }, () => fixture(engine, 'held-expiry', async ({ a, b, log }) => {
    await transaction(a); await check(a); await a.stop();
    log('logical-job-lease-expired', { now: 30001 });
    assert.equal((await b.call('begin')).acquired, false);
    a.resume(); await a.call('rollback'); await transaction(b); await b.call('rollback');
  }));
  test(`${engine}: accepted message survives rollback and lost acknowledgement repeats acceptance`, { timeout: 30000 }, () => fixture(engine, 'acknowledgement-lost', async ({ a, b, smtp, observe }) => {
    await transaction(a); await check(a); assert.equal((await a.call('mutate')).changed, 1);
    assert.equal((await send(a, smtp)).outcome, 'unknown'); await a.call('rollback');
    const rolledBack = await observe(); assert.equal(Number(rolledBack.value), 0); assert.equal(rolledBack.owner, null);
    assert.equal(smtp.accepted.length, 1);
    await transaction(b); await check(b); assert.equal((await send(b, smtp)).outcome, 'unknown'); await b.call('rollback');
    assert.deepEqual(smtp.accepted.map(x => x.owner), ['A', 'B']);
    assert.equal(smtp.accepted[0].operation, smtp.accepted[1].operation);
  }, { loseAcknowledgement: true }));
  test(`${engine}: no acceptance produces the same unknown sender outcome`, { timeout: 30000 }, () => fixture(engine, 'not-accepted', async ({ a, smtp, observe }) => {
    await transaction(a); await check(a); assert.equal((await a.call('mutate')).changed, 1);
    const result = await send(a, smtp);
    assert.equal(result.acknowledged, false); assert.equal(result.outcome, 'unknown');
    await a.call('rollback');
    assert.equal(Number((await observe()).value), 0);
    assert.equal(smtp.accepted.length, 0);
  }, { dropBeforeAcceptance: true }));
}
for (const stopped of [false, true]) {
  test(`postgres: ${stopped ? 'OS-paused' : 'live barrier-paused'} callback sends after database connection loss and B takeover`, { timeout: 30000 }, () => fixture('postgres', `connection-loss-${stopped ? 'stopped' : 'live'}`, async ({ a, b, smtp, observe, loseConnection }) => {
    await transaction(a); await check(a);
    assert.equal((await b.call('begin')).acquired, false);
    if (stopped) await a.stop();
    await loseConnection();
    await transaction(b); await check(b); await send(b, smtp); await b.call('commit');
    assert.equal((await observe()).owner, 'B');
    if (stopped) a.resume();
    assert.equal((await send(a, smtp, { abort: true })).acknowledged, true);
    const mutation = await a.call('mutate'); assert.equal(mutation.changed, 0); assert.equal(mutation.connectionLost, true);
    assert.deepEqual(smtp.accepted.map(x => x.owner), ['B', 'A']);
    assert.equal((await observe()).owner, 'B');
  }));
}
