// EXPERIMENT ONLY. Raw engine operations, not a proposed Capsule capability.
import net from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createPostgresDatabaseAdapter, createSqliteDatabaseAdapter } from '../../dist/server-runtime-source.js';

const [engine, file, owner] = process.argv.slice(2);
const db = engine === 'postgres'
  ? await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL })
  : await createSqliteDatabaseAdapter(file);
const sql = db.dialect.sql;
const run = (query, ...params) => db.prepare(sql(query)).run(...params);
const get = (query, ...params) => db.prepare(sql(query)).get(...params);
let generation;
let inTransaction = false;
let callbackResult;
let resumeCallback;
const abort = new AbortController();

async function submit(port, operation) {
  // The final authority check has ALREADY returned at the explicit parent barrier.
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(5000, () => socket.destroy(new Error('SMTP timeout')));
  const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  socket.on('error', () => {});
  const read = async (prefix) => {
    const line = await lines.next();
    if (line.done || !line.value.startsWith(prefix)) throw new Error('SMTP acknowledgement unavailable');
  };
  try {
    await once(socket, 'connect');
    await read('220');
    for (const [command, reply] of [
      ['EHLO experiment.invalid', '250'], ['MAIL FROM:<sender@example.invalid>', '250'],
      ['RCPT TO:<receiver@example.invalid>', '250'], ['DATA', '354'],
    ]) { socket.write(`${command}\r\n`); await read(reply); }
    socket.write(`Message-ID: <${operation}@example.invalid>\r\nX-Worker: ${owner}\r\n\r\nfixture\r\n.\r\n`);
    await read('250');
    return { acknowledged: true, abortObserved: abort.signal.aborted };
  } catch {
    return { acknowledged: false, outcome: 'unknown', abortObserved: abort.signal.aborted };
  } finally { socket.destroy(); }
}

async function command(message) {
  const { op, now = 0 } = message;
  if (op === 'begin') {
    try {
      await db.exec(engine === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      inTransaction = true;
      if (engine === 'postgres') await db.exec('SELECT * FROM experiment_resource WHERE id=1 FOR UPDATE NOWAIT');
      await run('UPDATE [experiment_resource] SET [owner]=?, [generation]=[generation]+1 WHERE [id]=1', owner);
      generation = Number((await get('SELECT [generation] FROM [experiment_resource] WHERE [id]=1')).generation);
      return { acquired: true, generation };
    } catch (error) {
      if (inTransaction) await db.exec('ROLLBACK');
      inTransaction = false;
      return { acquired: false, reason: /lock|busy/i.test(error.message) ? 'contended' : error.message };
    }
  }
  if (op === 'lease') {
    const result = await run('UPDATE [experiment_resource] SET [owner]=?, [generation]=[generation]+1, [expires]=? WHERE [id]=1 AND ([owner] IS NULL OR [expires]<=?)', owner, now + 30000, now);
    if (result.changes) generation = Number((await get('SELECT [generation] FROM [experiment_resource] WHERE [id]=1')).generation);
    return { acquired: result.changes === 1, generation };
  }
  if (op === 'check') {
    let reportBarrier;
    const barrier = new Promise(resolve => { reportBarrier = resolve; });
    const continuation = new Promise(resolve => { resumeCallback = resolve; });
    callbackResult = (async function candidateCallback() {
      try {
        const row = await get('SELECT * FROM [experiment_resource] WHERE [id]=1');
        const authorized = row.owner === owner && Number(row.generation) === generation && (inTransaction || Number(row.expires) > now);
        reportBarrier({ authorized, callback: authorized, generation, pid: process.pid });
        if (!authorized) return { callbackContinued: false };
        // Last ownership check finished. Parent controls this exact instruction gap.
        const submission = await continuation;
        if (submission.abort) abort.abort();
        return { callbackContinued: true, ...await submit(submission.port, submission.operation) };
      } catch (error) { reportBarrier({ authorized: false }); throw error; }
    })();
    callbackResult.catch(() => {});
    return barrier;
  }
  if (op === 'submit') {
    if (!resumeCallback) throw new Error('callback barrier was not entered');
    resumeCallback(message);
    resumeCallback = null;
    return callbackResult;
  }
  if (op === 'mutate') {
    try {
      const result = await run('UPDATE [experiment_resource] SET [value]=[value]+1 WHERE [id]=1 AND [owner]=? AND [generation]=? AND ([expires]>? OR [expires]=0)', owner, generation, now);
      return { changed: Number(result.changes) };
    } catch { return { changed: 0, connectionLost: true }; }
  }
  if (op === 'commit' || op === 'rollback') {
    await db.exec(op.toUpperCase()); inTransaction = false; return { settled: op };
  }
  if (op === 'close') { await db.close(); return { closed: true }; }
  throw new Error('Unknown experiment command');
}
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    try { process.send({ id: message.id, result: await command(message) }); }
    catch (error) { process.send({ id: message.id, error: error.message }); }
  });
});
const backend = engine === 'postgres' ? Number((await get('SELECT pg_backend_pid() AS pid')).pid) : null;
process.send({ ready: true, pid: process.pid, backend });
