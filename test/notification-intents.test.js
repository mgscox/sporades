import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { openDevDatabase, resolveAnonymousSession, runCurrentUserJobWorker, runEndpoint, runMutation, createControllableRuntimeClock } from '../dist/server-runtime-source.js';
import { endpoint, job, mutation, String as Text, table } from '../dist/server.js';
import { createMailRuntime } from '../dist/mail-runtime.js';
import { NOTIFICATION_MAX_BACKOFF_MS, notificationRetryDelay, runNotificationIntentDeliveryPass, startNotificationIntentWorker, stopNotificationIntentWorker } from '../dist/notification-intent-runtime.js';

const actor = { userId: 'notification-actor', displayName: 'Notification actor', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const resource = { table: 'anchors', id: 'anchor' };
const notification = (overrides = {}) => ({ id: 'welcome', to: ['one@example.com'], subject: 'Welcome', text: 'Hello', ...overrides });
// The worker's recovery poll interval, asserted here rather than imported so
// the wake-bound test fails on behavior instead of on a missing export.
const recoveryScanMs = 30_000;
const mailConfig = {
  name: 'notification-intents',
  mail: { smtp: { vendor: 'generic', host: '127.0.0.1', port: 2525, tls: { mode: 'disabled' }, auth: { method: 'none' }, defaultFrom: 'sender@example.com', connectionTimeoutMs: 100, socketTimeoutMs: 100 } },
};

async function fixture({ outcomes = [], fault, extra = {}, smtpPort = null, smtp = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notification-intents-'));
  const databasePath = path.join(dir, 'data.db');
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const deliveries = [];
  const config = { ...mailConfig, mail: { smtp: { ...mailConfig.mail.smtp, ...(smtpPort === null ? {} : { port: smtpPort }), ...smtp } } };
  const capsuleDefinition = {
    schema: { anchors: table({ value: Text() }), writes: table({ value: Text() }) },
    mutations: {
      accept: mutation((ctx, input = notification()) => ctx.resources.run({ resource, operationId: 'accept', input: { version: 1 } }, async scope => {
        const staged = await scope.notifications.accept(input);
        await scope.db.writes.insert({ value: 'accepted' });
        return staged;
      })),
      status: mutation(ctx => ctx.resources.status({ resource, operationId: 'accept' })),
      rollback: mutation(async ctx => {
        await ctx.resources.run({ resource, operationId: 'rollback', input: null }, scope => scope.notifications.accept(notification({ id: 'rollback' })));
        throw new Error('outer rollback');
      }),
      conflict: mutation(ctx => ctx.resources.run({ resource, operationId: 'conflict', input: null }, async scope => {
        await scope.notifications.accept(notification());
        await scope.notifications.accept(notification({ subject: 'Changed' }));
        return null;
      })),
      enqueue: mutation(ctx => ctx.jobs.enqueue('accept-job', notification({ id: 'job' }), { retry: { maxAttempts: 1, delayMs: 0 } })),
      ...extra.mutations,
    },
    jobs: {
      'accept-job': job((ctx, input) => ctx.resources.run({ resource, operationId: 'job-accept', input: null }, scope => scope.notifications.accept(input))),
      ...extra.jobs,
    },
    endpoints: extra.endpoints,
  };
  const runtimeOptions = {
    clock,
    notificationIntentFault: fault,
    ...(smtpPort === null ? { mailTransportFactoryTrusted: true, mailTransportFactory: () => ({
      async send(message) {
        deliveries.push(structuredClone(message));
        const outcome = outcomes.shift();
        if (typeof outcome === 'function') return outcome(message);
        if (outcome instanceof Error) throw outcome;
        return outcome ?? { messageId: message.messageId, accepted: message.to.map(entry => entry.email), rejected: [] };
      },
      close() {},
    }) } : {}),
  };
  const database = await openDevDatabase(databasePath, '', {}, config, capsuleDefinition, runtimeOptions);
  database.adapter.prepare('INSERT INTO anchors (id,createdAt,updatedAt,value) VALUES (?,?,?,?)').run('anchor', clock.now().toISOString(), clock.now().toISOString(), 'anchor');
  await database.init();
  await stopNotificationIntentWorker(database);
  return {
    database, clock, deliveries, dir,
    reopen: () => openDevDatabase(databasePath, '', {}, config, capsuleDefinition, runtimeOptions),
    close: async () => { await database.shutdown(); await database.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function settlesWithin(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`cleanup did not settle within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function controlledReceiver(modes) {
  const messages = [];
  let connection = 0;
  const server = createServer(socket => {
    const mode = modes[connection++] ?? 'accept';
    let buffer = ''; let data = false;
    socket.setEncoding('utf8'); socket.write('220 test ESMTP\r\n');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false;
          if (mode === 'accept-lost-reply') return socket.destroy();
          socket.write('250 queued <controlled@test>\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const command = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (/^EHLO /i.test(command)) socket.write('250 test\r\n');
        else if (/^MAIL FROM:/i.test(command)) socket.write(mode === 'mail-from-550' ? '550 sender rejected\r\n' : '250 ok\r\n');
        else if (/^RCPT TO:/i.test(command)) socket.write('250 ok\r\n');
        else if (command === 'DATA') {
          if (mode === 'drop-before-data') return socket.destroy();
          if (mode === 'data-554') { socket.write('554 transaction rejected\r\n'); continue; }
          data = true; socket.write('354 continue\r\n');
        } else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { messages, port: server.address().port, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('resource notification acceptance is atomic, immutable, deduplicated, and staged in mutation and Job scopes', async () => {
  let raceCallbacks = 0;
  const f = await fixture({ extra: { mutations: { race: mutation(ctx => ctx.resources.run({ resource, operationId: 'race', input: null }, async scope => {
    raceCallbacks++;
    return scope.notifications.accept(notification({ id: 'race' }));
  })) } } });
  try {
    const accepted = await runMutation(f.database, actor, 'accept', [notification()]);
    assert.deepEqual(accepted, { ok: true, data: { id: 'welcome', state: 'staged' }, error: null });
    assert.equal(f.deliveries.length, 0, 'no SMTP before the owning commit');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_intents').get().n, 1);

    const raced = await Promise.all([runMutation(f.database, actor, 'race', []), runMutation(f.database, actor, 'race', [])]);
    assert.equal(raced.every(result => result.ok && result.data.id === 'race'), true);
    assert.equal(raceCallbacks, 1, 'receipt replay resolves a deterministic same-identity acceptance race');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='race'").get().n, 1);
    assert.equal(f.database.adapter.prepare('SELECT intentIdsJson FROM sporades_resource_receipts WHERE operationId=?').get('accept').intentIdsJson, '["welcome"]');

    const replay = await runMutation(f.database, actor, 'accept', [notification()]);
    assert.deepEqual(replay, accepted);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_intents').get().n, 2);

    const conflict = await runMutation(f.database, actor, 'conflict', []);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'RESOURCE_OPERATION_CONFLICT');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='conflict'").get().n, 0);

    const enqueued = await runMutation(f.database, actor, 'enqueue', []);
    assert.equal(enqueued.ok, true);
    await runCurrentUserJobWorker(f.database);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='job-accept'").get().n, 1);
  } finally { await f.close(); }
});

test('concurrent identical notification acceptance deduplicates without poisoning the resource transaction', async () => {
  const f = await fixture({ extra: { mutations: { concurrentAccept: mutation(ctx => ctx.resources.run(
    { resource, operationId: 'concurrent-accept', input: null },
    async scope => Promise.all([
      scope.notifications.accept(notification({ id: 'concurrent' })),
      scope.notifications.accept(notification({ id: 'concurrent' })),
    ]),
  )) } } });
  try {
    const result = await runMutation(f.database, actor, 'concurrentAccept', []);
    assert.deepEqual(result, {
      ok: true,
      data: [{ id: 'concurrent', state: 'staged' }, { id: 'concurrent', state: 'staged' }],
      error: null,
    });
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='concurrent-accept'").get().n, 1);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_recipients WHERE operationId='concurrent-accept'").get().n, 1);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_attempt_keys WHERE operationId='concurrent-accept'").get().n, 1);
  } finally { await f.close(); }
});

test('concurrent differing notification acceptance reports an operation conflict and rolls back staging', async () => {
  const f = await fixture({ extra: { mutations: { concurrentConflict: mutation(ctx => ctx.resources.run(
    { resource, operationId: 'concurrent-conflict', input: null },
    async scope => Promise.all([
      scope.notifications.accept(notification({ id: 'concurrent-conflict' })),
      scope.notifications.accept(notification({ id: 'concurrent-conflict', subject: 'Changed' })),
    ]),
  )) } } });
  try {
    const result = await runMutation(f.database, actor, 'concurrentConflict', []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RESOURCE_OPERATION_CONFLICT');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='concurrent-conflict'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_recipients WHERE operationId='concurrent-conflict'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_attempt_keys WHERE operationId='concurrent-conflict'").get().n, 0);
  } finally { await f.close(); }
});

test('an explicitly undefined optional html body is accepted as omitted', async () => {
  const f = await fixture();
  try {
    const accepted = await runMutation(f.database, actor, 'accept', [notification({ html: undefined })]);
    assert.deepEqual(accepted, { ok: true, data: { id: 'welcome', state: 'staged' }, error: null });
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 1, 'the enclosing transaction commits');
    const payload = JSON.parse(f.database.adapter.prepare('SELECT payloadJson FROM sporades_notification_intents').get().payloadJson);
    assert.equal(Object.hasOwn(payload, 'html'), false);
  } finally { await f.close(); }
});

test('notification intent identity rejects an unpaired UTF-16 surrogate before staging', async () => {
  const f = await fixture();
  try {
    const rejected = await runMutation(f.database, actor, 'accept', [notification({ id: '\uD800' })]);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'RESOURCE_INVALID_INPUT');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_intents').get().n, 0);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0,
      'invalid notification identity rolls back the enclosing resource transaction');
  } finally { await f.close(); }
});

test('notification intent identity rejects NUL before staging', async () => {
  const f = await fixture();
  try {
    const rejected = await runMutation(f.database, actor, 'accept', [notification({ id: 'welcome\0hidden' })]);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'RESOURCE_INVALID_INPUT');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_intents').get().n, 0);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0,
      'invalid notification identity rolls back before staging or protected writes');
  } finally { await f.close(); }
});

test('independent intent acceptances mint globally unique persisted Message-IDs', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    await runMutation(first.database, actor, 'accept', [notification({ to: ['first@example.com'], text: 'First deployment' })]);
    await runMutation(second.database, actor, 'accept', [notification({ to: ['second@example.com'], text: 'Second deployment' })]);
    const firstMessageId = first.database.adapter.prepare('SELECT messageId FROM sporades_notification_intents').get().messageId;
    const secondMessageId = second.database.adapter.prepare('SELECT messageId FROM sporades_notification_intents').get().messageId;
    assert.match(firstMessageId, /^<[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@sporades\.local>$/);
    assert.match(secondMessageId, /^<[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@sporades\.local>$/);
    assert.notEqual(firstMessageId, secondMessageId);
  } finally { await first.close(); await second.close(); }
});

test('outer rollback removes notification, recipients, receipt, and protected writes', async () => {
  const f = await fixture();
  try {
    const result = await runMutation(f.database, actor, 'rollback', []);
    assert.equal(result.ok, false);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='rollback'").get().n, 0);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='sporades_resource_receipts'").get().n, 0);
    assert.equal(f.deliveries.length, 0);
  } finally { await f.close(); }
});

test('Custom endpoint acceptance joins commit and rolls back with its outer transaction', async () => {
  const f = await fixture({ extra: { endpoints: {
    acceptEndpoint: endpoint({ method: 'POST', path: '/accept-notification' }, ctx => ctx.resources.run({ resource, operationId: 'endpoint-accept', input: null }, scope => scope.notifications.accept(notification({ id: 'endpoint' })))),
    rollbackEndpoint: endpoint({ method: 'POST', path: '/rollback-notification' }, async ctx => {
      await ctx.resources.run({ resource, operationId: 'endpoint-rollback', input: null }, scope => scope.notifications.accept(notification({ id: 'endpoint-rollback' })));
      throw new Error('endpoint rollback');
    }),
  } } });
  const session = await resolveAnonymousSession(f.database, null);
  const request = { method: 'POST', headers: { 'x-sporades-session-token': session.token }, async *[Symbol.asyncIterator]() {} };
  try {
    await runEndpoint(f.database, f.database.endpoints.find(item => item.path === '/accept-notification'), new URL('http://capsule.test/accept-notification'), request);
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='endpoint-accept'").get().n, 1);
    await assert.rejects(runEndpoint(f.database, f.database.endpoints.find(item => item.path === '/rollback-notification'), new URL('http://capsule.test/rollback-notification'), request));
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='endpoint-rollback'").get().n, 0);
  } finally { await f.close(); }
});

test('an independent delivery scan cannot observe a staged intent before its owning commit', async () => {
  let entered;
  let release;
  const staged = new Promise(resolve => { entered = resolve; });
  const commit = new Promise(resolve => { release = resolve; });
  const f = await fixture({ extra: { mutations: { hold: mutation(ctx => ctx.resources.run({ resource, operationId: 'held', input: null }, async scope => {
    const result = await scope.notifications.accept(notification({ id: 'held' }));
    entered(); await commit; return result;
  })) } } });
  try {
    const accepting = runMutation(f.database, actor, 'hold', []);
    await staged;
    const scanning = runNotificationIntentDeliveryPass(f.database);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.deliveries.length, 0);
    release();
    assert.equal((await accepting).ok, true);
    assert.equal(await scanning, true);
    assert.equal(f.deliveries.length, 1);
  } finally { release(); await f.close(); }
});

test('recipient delivery is isolated, retries uncertainty with persisted backoff, and keeps acknowledgement monotonic', async () => {
  const unknown = Object.assign(new Error('lost reply'), { code: 'ECONNECTION' });
  const f = await fixture({ outcomes: [undefined, unknown, undefined] });
  try {
    await runMutation(f.database, actor, 'accept', [notification({ to: ['a@example.com', 'b@example.com'] })]);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    let status = (await runMutation(f.database, actor, 'status', [])).data;
    assert.deepEqual(status.intents[0].recipients.map(row => [row.recipient, row.state, row.attemptCount]), [
      ['a@example.com', 'acknowledged', 1], ['b@example.com', 'retry-wait', 1],
    ]);
    assert.equal(f.deliveries.length, 2);
    assert.equal(new Set(f.deliveries.map(message => message.messageId)).size, 1, 'immutable Message-ID across recipients and attempts');
    f.clock.advanceBy(30_000);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    status = (await runMutation(f.database, actor, 'status', [])).data;
    assert.equal(status.intents[0].state, 'acknowledged');
    assert.deepEqual(status.intents[0].recipients.map(row => row.attemptCount), [1, 2]);
    assert.equal(f.deliveries.filter(message => message.to[0].email === 'a@example.com').length, 1, 'acknowledged recipient is not resent');
  } finally { await f.close(); }
});

test('crash before SMTP and crash after receiver acceptance recover after the durable reservation deadline', async () => {
  for (const crashPhase of ['before-submit', 'after-submit']) {
    let crashed = false;
    const fault = phase => {
      if (!crashed && phase === crashPhase) {
        crashed = true;
        throw Object.assign(new Error(`crash ${phase}`), { notificationIntentCrash: true });
      }
    };
    const f = await fixture({ fault });
    try {
      await runMutation(f.database, actor, 'accept', [notification()]);
      await assert.rejects(runNotificationIntentDeliveryPass(f.database), { notificationIntentCrash: true });
      assert.equal(f.database.adapter.prepare('SELECT state FROM sporades_notification_recipients').get().state, 'submitting');
      assert.equal(f.deliveries.length, crashPhase === 'after-submit' ? 1 : 0);
      f.clock.advanceBy(30_000);
      assert.equal(await runNotificationIntentDeliveryPass(f.database), false, 'expiry records uncertainty and persisted backoff');
      f.clock.advanceBy(30_000);
      assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
      assert.equal(f.database.adapter.prepare('SELECT state FROM sporades_notification_recipients').get().state, 'acknowledged');
      assert.equal(f.deliveries.length, crashPhase === 'after-submit' ? 2 : 1, 'post-acceptance crash may duplicate receiver acceptance');
    } finally { await f.close(); }
  }
});

test('a late positive report from an expired attempt wins over a newer stale failure', async () => {
  let resolveFirst;
  let rejectSecond;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const second = new Promise((_, reject) => { rejectSecond = reject; });
  const f = await fixture({ outcomes: [() => first, () => second] });
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    const oldAttempt = runNotificationIntentDeliveryPass(f.database);
    while (f.deliveries.length < 1) await new Promise(resolve => setImmediate(resolve));
    f.clock.advanceBy(30_000);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), false, 'expired attempt enters retry wait');
    f.clock.advanceBy(30_000);
    const newerAttempt = runNotificationIntentDeliveryPass(f.database);
    while (f.deliveries.length < 2) await new Promise(resolve => setImmediate(resolve));
    const attempts = f.database.adapter.prepare('SELECT attemptToken,sequence FROM sporades_notification_attempts ORDER BY sequence').all();
    assert.deepEqual(attempts.map(row => row.sequence), ['2'], 'the previous recipient-bearing diagnostic is compacted');
    resolveFirst({ messageId: f.deliveries[0].messageId, accepted: ['one@example.com'], rejected: [] });
    await oldAttempt;
    rejectSecond(Object.assign(new Error('stale failure'), { code: 'ECONNECTION' }));
    await newerAttempt;
    const row = f.database.adapter.prepare('SELECT state,lastOutcomeCategory FROM sporades_notification_recipients').get();
    assert.equal(row.state, 'acknowledged');
    assert.equal(row.lastOutcomeCategory, 'acknowledged');
    assert.equal(await runNotificationIntentDeliveryPass(f.database), false, 'late success suppresses future reservation');
  } finally { await f.close(); }
});

test('persistent completed SMTP failures retain one bounded attempt diagnostic per recipient', async () => {
  const uncertain = () => Object.assign(new Error('SMTP unavailable'), { code: 'ECONNECTION' });
  const f = await fixture({ outcomes: Array.from({ length: 20 }, uncertain) });
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
      const diagnostics = f.database.adapter.prepare('SELECT sequence,outcomeCategory FROM sporades_notification_attempts ORDER BY CAST(sequence AS INTEGER)').all()
        .map(row => ({ sequence: row.sequence, outcomeCategory: row.outcomeCategory }));
      assert.deepEqual(diagnostics, [{ sequence: String(attempt), outcomeCategory: 'unknown' }]);
      if (attempt < 20) f.clock.advanceBy(notificationRetryDelay(attempt));
    }
    const recipient = f.database.adapter.prepare('SELECT state,attemptCount,lastOutcomeCategory FROM sporades_notification_recipients').get();
    assert.deepEqual(
      { state: recipient.state, attemptCount: recipient.attemptCount, lastOutcomeCategory: recipient.lastOutcomeCategory },
      { state: 'retry-wait', attemptCount: '20', lastOutcomeCategory: 'unknown' },
    );
  } finally { await f.close(); }
});

test('compaction retains bounded durable authentication for an arbitrarily late positive acknowledgement', async () => {
  const pending = Array.from({ length: 3 }, () => Promise.withResolvers());
  const f = await fixture({ outcomes: pending.map(item => () => item.promise) });
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    const passes = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      passes.push(runNotificationIntentDeliveryPass(f.database));
      while (f.deliveries.length < attempt) await new Promise(resolve => setImmediate(resolve));
      if (attempt < 3) {
        f.clock.advanceBy(30_000);
        assert.equal(await runNotificationIntentDeliveryPass(f.database), false);
        f.clock.advanceBy(notificationRetryDelay(attempt));
      }
    }
    assert.deepEqual(
      f.database.adapter.prepare('SELECT sequence,completedAt FROM sporades_notification_attempts ORDER BY CAST(sequence AS INTEGER)').all()
        .map(row => [row.sequence, row.completedAt]),
      [['3', '']],
      'expired recipient-bearing diagnostics compact while durable recipient sequence remains',
    );
    pending[0].resolve({ messageId: f.deliveries[0].messageId, accepted: ['one@example.com'], rejected: [] });
    await passes[0];
    pending[1].reject(Object.assign(new Error('late stale failure'), { code: 'ECONNECTION' }));
    pending[2].reject(Object.assign(new Error('newer stale failure'), { code: 'ECONNECTION' }));
    await Promise.all([passes[1], passes[2]]);
    assert.equal(f.database.adapter.prepare('SELECT state FROM sporades_notification_recipients').get().state, 'acknowledged');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_attempts').get().n, 1, 'terminal late settlements leave bounded diagnostics');
  } finally { await f.close(); }
});

test('restart retains uncertain attempt identity, due time, and accepted receipt independently of source Job state', async () => {
  const f = await fixture({ fault: phase => {
    if (phase === 'after-reservation') throw Object.assign(new Error('process death'), { notificationIntentCrash: true });
  } });
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    await assert.rejects(runNotificationIntentDeliveryPass(f.database));
    const before = f.database.adapter.prepare('SELECT currentAttemptToken,currentAttemptDeadline,attemptCount FROM sporades_notification_recipients').get();
    assert.ok(before.currentAttemptToken);
    assert.equal(before.attemptCount, '1');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_resource_receipts WHERE operationId='accept'").get().n, 1);
    await f.database.shutdown();
    await f.database.init();
    await stopNotificationIntentWorker(f.database);
    const after = f.database.adapter.prepare('SELECT currentAttemptToken,currentAttemptDeadline,attemptCount,state FROM sporades_notification_recipients').get();
    assert.equal(after.currentAttemptToken, before.currentAttemptToken);
    assert.equal(after.currentAttemptDeadline, before.currentAttemptDeadline);
    assert.equal(after.attemptCount, before.attemptCount);
    assert.equal(after.state, 'submitting');
    f.clock.advanceBy(30_000);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), false);
    const retry = f.database.adapter.prepare('SELECT state,nextAttemptAt FROM sporades_notification_recipients').get();
    assert.equal(retry.state, 'retry-wait');
    assert.equal(retry.nextAttemptAt, '2030-01-01T00:01:00.000Z');
    await f.database.shutdown(); await f.database.init(); await stopNotificationIntentWorker(f.database);
    assert.deepEqual(f.database.adapter.prepare('SELECT state,nextAttemptAt FROM sporades_notification_recipients').get(), retry);
  } finally { await f.close(); }
});

test('shutdown aborts an active SMTP send before awaiting its worker and retains the durable reservation', async () => {
  const f = await fixture();
  let rejectSend;
  let markSendStarted;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  const events = [];
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    f.database.mail = {
      enabled: true,
      sendIntent() {
        events.push('send-started');
        markSendStarted();
        return new Promise((_, reject) => { rejectSend = reject; });
      },
      close() {
        events.push('transport-closed');
        rejectSend(Object.assign(new Error('SMTP transport closed for shutdown'), { code: 'ECONNECTION' }));
      },
    };
    void startNotificationIntentWorker(f.database);
    await sendStarted;
    const reserved = f.database.adapter.prepare('SELECT state,currentAttemptToken,currentAttemptDeadline FROM sporades_notification_recipients').get();
    assert.equal(reserved.state, 'submitting');
    assert.ok(reserved.currentAttemptToken);

    await f.database.shutdown();

    assert.deepEqual(events, ['send-started', 'transport-closed'], 'transport closure releases the active worker during shutdown');
    assert.deepEqual(
      { ...f.database.adapter.prepare('SELECT state,currentAttemptToken,currentAttemptDeadline FROM sporades_notification_recipients').get() },
      { ...reserved },
      'shutdown leaves the uncertain reservation for deadline-based restart recovery',
    );
  } finally { await f.close(); }
});

test('init-failure cleanup aborts an active SMTP send before awaiting its worker and preserves restart recovery', async () => {
  const f = await fixture();
  let rejectSend;
  let markSendStarted;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  const initFailure = new Error('injected publication failure');
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    await f.database.shutdown();
    f.database.mail = {
      enabled: true,
      sendIntent() {
        markSendStarted();
        return new Promise((_, reject) => { rejectSend = reject; });
      },
      close() {
        rejectSend(Object.assign(new Error('SMTP transport closed for failed init'), { code: 'ECONNECTION' }));
      },
    };
    f.database.__publishAccessKeyScopes = async () => {
      await sendStarted;
      throw initFailure;
    };

    await assert.rejects(settlesWithin(f.database.init()), error => error === initFailure);
    const reserved = f.database.adapter.prepare('SELECT state,currentAttemptToken,currentAttemptDeadline FROM sporades_notification_recipients').get();
    assert.equal(reserved.state, 'submitting', 'failed init leaves the active reservation uncertain');
    assert.ok(reserved.currentAttemptToken);

    f.database.__deferJobExecution();
    f.database.__publishAccessKeyScopes = async () => {};
    f.database.mail = { enabled: true, async sendIntent() {}, close() {} };
    f.clock.advanceBy(30_000);
    await f.database.init();
    assert.equal(await runNotificationIntentDeliveryPass(f.database), false);
    assert.deepEqual(
      { ...f.database.adapter.prepare('SELECT state,nextAttemptAt FROM sporades_notification_recipients').get() },
      { state: 'retry-wait', nextAttemptAt: '2030-01-01T00:01:00.000Z' },
      'the retained reservation recovers after its durable deadline',
    );
  } finally {
    rejectSend?.(Object.assign(new Error('test cleanup'), { code: 'ECONNECTION' }));
    await f.close();
  }
});

test('direct database close aborts an active SMTP send before awaiting its worker and preserves restart recovery', async () => {
  const f = await fixture();
  let rejectSend;
  let markSendStarted;
  let closePromise;
  let restarted;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    f.database.mail = {
      enabled: true,
      sendIntent() {
        markSendStarted();
        return new Promise((_, reject) => { rejectSend = reject; });
      },
      close() {
        rejectSend(Object.assign(new Error('SMTP transport closed for database close'), { code: 'ECONNECTION' }));
      },
    };
    void startNotificationIntentWorker(f.database);
    await sendStarted;
    const reserved = f.database.adapter.prepare('SELECT state,currentAttemptToken,currentAttemptDeadline FROM sporades_notification_recipients').get();
    assert.equal(reserved.state, 'submitting');

    closePromise = f.database.close();
    await settlesWithin(closePromise);

    f.clock.advanceBy(30_000);
    restarted = await f.reopen();
    restarted.__deferJobExecution();
    await restarted.init();
    assert.equal(await runNotificationIntentDeliveryPass(restarted), false);
    assert.deepEqual(
      { ...restarted.adapter.prepare('SELECT state,nextAttemptAt FROM sporades_notification_recipients').get() },
      { state: 'retry-wait', nextAttemptAt: '2030-01-01T00:01:00.000Z' },
      'the retained reservation recovers after reopening the database',
    );
  } finally {
    rejectSend?.(Object.assign(new Error('test cleanup'), { code: 'ECONNECTION' }));
    await closePromise?.catch(() => {});
    if (restarted) { await restarted.shutdown(); await restarted.close(); }
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('restart additively upgrades a pre-authenticator notification database without losing pending work', async () => {
  const f = await fixture();
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    await f.database.adapter.exec('DROP TABLE sporades_notification_attempt_keys');
    await f.database.shutdown();
    f.database.mail = {
      enabled: false,
      async sendIntent() { throw Object.assign(new Error('mail disabled'), { smtpOutcome: 'rejected' }); },
      close() {},
    };
    await f.database.init();
    await stopNotificationIntentWorker(f.database);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_attempt_keys').get().n, 1, 'the first post-upgrade reservation seeds one durable authenticator');
    assert.equal(f.database.adapter.prepare('SELECT state FROM sporades_notification_recipients').get().state, 'rejected');
    assert.equal(f.deliveries.length, 0);
  } finally { await f.close(); }
});

test('restart terminally rejects an accepted intent when the SMTP sender is no longer configured', async () => {
  const f = await fixture();
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    await f.database.shutdown();
    f.database.mail = createMailRuntime(
      { smtp: { ...mailConfig.mail.smtp, defaultFrom: undefined } },
      {},
      { mailTransportFactoryTrusted: true, mailTransportFactory: () => ({
        async send() { throw new Error('invalid intent must not reach SMTP'); },
        close() {},
      }) },
    );
    await f.database.init();
    await stopNotificationIntentWorker(f.database);
    assert.deepEqual(
      { ...f.database.adapter.prepare('SELECT state,lastOutcomeCategory,nextAttemptAt FROM sporades_notification_recipients').get() },
      { state: 'rejected', lastOutcomeCategory: 'rejected', nextAttemptAt: '' },
      'pre-send validation is permanent and must not enter the retry loop',
    );
  } finally { await f.close(); }
});

test('controlled SMTP receiver proves lost-reply duplicate acceptance and no-acceptance retry twins', async () => {
  const receiver = await controlledReceiver(['accept-lost-reply', 'drop-before-data', 'accept', 'accept']);
  const f = await fixture({ smtpPort: receiver.port });
  try {
    await runMutation(f.database, actor, 'accept', [notification({ to: ['accepted-twin@example.com', 'not-accepted-twin@example.com'] })]);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(receiver.messages.length, 1, 'only the lost-reply twin reached receiver acceptance');
    assert.deepEqual(f.database.adapter.prepare('SELECT outcomeCategory FROM sporades_notification_attempts ORDER BY recipient').all().map(row => row.outcomeCategory), ['unknown', 'unknown']);
    f.clock.advanceBy(30_000);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(receiver.messages.length, 3, 'accepted twin is duplicated and the not-accepted twin succeeds');
    const messageIds = receiver.messages.map(raw => raw.match(/^Message-ID: (.+)$/m)?.[1]?.trim());
    assert.equal(new Set(messageIds).size, 1, 'all retry envelopes retain the immutable intent Message-ID');
    const status = (await runMutation(f.database, actor, 'status', [])).data;
    assert.equal(status.intents[0].state, 'acknowledged');
    assert.deepEqual(status.intents[0].recipients.map(row => row.attemptCount), [2, 2]);
  } finally { await f.close(); await receiver.close(); }
});

test('permanent rejection is retained, validation is bounded, and exponential retry has no finite exhaustion', async () => {
  const rejected = Object.assign(new Error('definitive SMTP rejection'), { code: 'EREJECTED', smtpCode: 550 });
  const f = await fixture({ outcomes: [rejected] });
  try {
    for (const bad of [
      { ...notification(), extra: true },
      notification({ id: '' }),
      notification({ to: [] }),
      notification({ text: '', html: '' }),
      notification({ to: ['not-an-address'] }),
      notification({ text: 'x'.repeat(65_536) }),
    ]) {
      const result = await runMutation(f.database, actor, 'accept', [bad]);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'RESOURCE_INVALID_INPUT');
    }
    const accepted = await runMutation(f.database, actor, 'accept', [notification()]);
    assert.equal(accepted.ok, true);
    await runNotificationIntentDeliveryPass(f.database);
    const status = (await runMutation(f.database, actor, 'status', [])).data;
    assert.equal(status.intents[0].state, 'rejected');
    assert.equal(status.intents[0].recipients[0].lastOutcomeCategory, 'rejected');
    assert.equal(await runNotificationIntentDeliveryPass(f.database), false);
    assert.deepEqual([1, 2, 3, 8, 9, 100].map(notificationRetryDelay), [30_000, 60_000, 120_000, 3_600_000, 3_600_000, 3_600_000]);
  } finally { await f.close(); }
});

test('SMTP normalization keeps 5xx envelope and authentication failures terminal', async () => {
  for (const scenario of [
    { mode: 'mail-from-550' },
    { mode: 'data-554' },
  ]) {
    const receiver = await controlledReceiver([scenario.mode]);
    const f = await fixture({ smtpPort: receiver.port });
    try {
      assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
      assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
      assert.deepEqual(
        { ...f.database.adapter.prepare('SELECT state,lastOutcomeCategory,nextAttemptAt FROM sporades_notification_recipients').get() },
        { state: 'rejected', lastOutcomeCategory: 'rejected', nextAttemptAt: '' },
        `${scenario.mode} is permanent and must not retry forever`,
      );
      assert.equal(await runNotificationIntentDeliveryPass(f.database), false);
    } finally { await f.close(); await receiver.close(); }
  }
  const authFailure = Object.assign(new Error('provider authentication detail'), { code: 'EAUTH', smtpCode: 535 });
  const auth = await fixture({ outcomes: [authFailure] });
  try {
    assert.equal((await runMutation(auth.database, actor, 'accept', [notification()])).ok, true);
    assert.equal(await runNotificationIntentDeliveryPass(auth.database), true);
    assert.deepEqual(
      { ...auth.database.adapter.prepare('SELECT state,lastOutcomeCategory,nextAttemptAt FROM sporades_notification_recipients').get() },
      { state: 'rejected', lastOutcomeCategory: 'rejected', nextAttemptAt: '' },
      'SMTP 535 is permanent and must not retry forever',
    );
  } finally { await auth.close(); }
});

test('recipient scheduling indexes are installed additively and survive retained terminal rows', async () => {
  const f = await fixture();
  try {
    await runMutation(f.database, actor, 'accept', [notification()]);
    const expected = [
      ['sporades_notification_recipients_due', ['state', 'nextAttemptAt', 'resourceTable', 'resourceId', 'operationId', 'intentId', 'recipient']],
      ['sporades_notification_recipients_reservations', ['state', 'currentAttemptDeadline', 'resourceTable', 'resourceId', 'operationId', 'intentId', 'recipient']],
    ];
    const assertIndexes = () => {
      const indexes = f.database.adapter.prepare("PRAGMA index_list('sporades_notification_recipients')").all();
      for (const [name, columns] of expected) {
        assert.ok(indexes.some(row => row.name === name), `${name} exists`);
        assert.deepEqual(
          f.database.adapter.prepare(`PRAGMA index_info('${name}')`).all().map(row => row.name),
          columns,
        );
      }
    };
    assertIndexes();
    for (const [name] of expected) f.database.adapter.exec(`DROP INDEX ${name}`);
    await f.database.shutdown();
    await f.database.init();
    await stopNotificationIntentWorker(f.database);
    assertIndexes();
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_recipients').get().n, 1, 'additive index repair retains recipient rows');
  } finally { await f.close(); }
});

test('SMTP 4xx remains uncertain and revocation after acceptance does not retract delivery', async () => {
  const transient = Object.assign(new Error('temporary SMTP rejection'), { code: 'EREJECTED', smtpCode: 451 });
  const f = await fixture({ outcomes: [transient] });
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    f.database.adapter.prepare('DELETE FROM anchors WHERE id=?').run('anchor');
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    const recipient = f.database.adapter.prepare('SELECT state,lastOutcomeCategory,nextAttemptAt FROM sporades_notification_recipients').get();
    assert.equal(recipient.state, 'retry-wait');
    assert.equal(recipient.lastOutcomeCategory, 'unknown');
    assert.equal(recipient.nextAttemptAt, '2030-01-01T00:00:30.000Z');
    assert.equal(f.deliveries.length, 1, 'committed acceptance survives later resource revocation');
  } finally { await f.close(); }
});

test('an uncertain settle lands on retry-wait without an unfiltered full-table UPDATE', async () => {
  const transient = Object.assign(new Error('temporary SMTP rejection'), { code: 'EREJECTED', smtpCode: 451 });
  const f = await fixture({ outcomes: [transient] });
  const originalPrepare = f.database.adapter.prepare;
  const unfilteredStatements = [];
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    f.database.adapter.prepare = function (sqlText, ...args) {
      // Identifiers reach adapter.prepare already quoted (dialect.sql() turns
      // `[state]` into `"state"`), so match the quoted form. This WHERE
      // clause shape — bare on `state`, no key predicate — is unique to the
      // old full-table sweep; every keyed update in this file filters on
      // resourceTable/resourceId/operationId/intentId/recipient first.
      if (typeof sqlText === 'string' && sqlText.includes('WHERE "state"=\'unknown\'')) {
        unfilteredStatements.push(sqlText);
      }
      return originalPrepare.call(this, sqlText, ...args);
    };
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    const recipient = f.database.adapter.prepare('SELECT state,lastOutcomeCategory FROM sporades_notification_recipients').get();
    assert.equal(recipient.state, 'retry-wait', 'an uncertain outcome still lands on the reservation-eligible state');
    assert.equal(recipient.lastOutcomeCategory, 'unknown');
    assert.deepEqual(unfilteredStatements, [], 'no UPDATE ... WHERE state=\'unknown\' full-table scan runs during the pass');
  } finally {
    f.database.adapter.prepare = originalPrepare;
    await f.close();
  }
});

test('source Job exhaustion after committed acceptance does not discard delivery work', async () => {
  const f = await fixture({ extra: {
    mutations: {
      enqueueFailing: mutation(ctx => ctx.jobs.enqueue('accept-then-fail', null, { retry: { maxAttempts: 1, delayMs: 0 } })),
      getJob: mutation((ctx, id) => ctx.jobs.get(id)),
    },
    jobs: {
      'accept-then-fail': job(async ctx => {
        await ctx.resources.run({ resource, operationId: 'accepted-before-exhaustion', input: null }, scope => scope.notifications.accept(notification({ id: 'survives-exhaustion' })));
        throw new Error('source Job fails after acceptance');
      }),
    },
  } });
  try {
    const queued = await runMutation(f.database, actor, 'enqueueFailing', []);
    await runCurrentUserJobWorker(f.database);
    assert.equal((await runMutation(f.database, actor, 'getJob', [queued.data.id])).data.status, 'failed');
    assert.equal(f.database.adapter.prepare("SELECT count(*) n FROM sporades_notification_intents WHERE operationId='accepted-before-exhaustion'").get().n, 1);
    assert.equal(await runNotificationIntentDeliveryPass(f.database), true);
    assert.equal(f.deliveries.length, 1);
  } finally { await f.close(); }
});

test('a persistence failure rejects the observed scan but arms another durable recovery scan', async () => {
  const f = await fixture();
  const original = f.database.adapter.withTransaction;
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    let failed = false;
    f.database.adapter.withTransaction = async (...args) => {
      if (!failed) { failed = true; throw new Error('injected persistence failure'); }
      return original.apply(f.database.adapter, args);
    };
    await assert.rejects(startNotificationIntentWorker(f.database), /injected persistence failure/);
    assert.equal(f.database.__notificationIntentNativeTimer, true);
    assert.ok(f.database.__notificationIntentTimer);
  } finally {
    f.database.adapter.withTransaction = original;
    await stopNotificationIntentWorker(f.database);
    await f.close();
  }
});

test('a rejected startup notification scan neither blocks nor aborts Capsule init', async () => {
  let faulted = false;
  const f = await fixture({ fault: phase => {
    if (phase === 'after-reservation' && !faulted) {
      faulted = true;
      throw Object.assign(new Error('startup scan failure'), { notificationIntentCrash: true });
    }
  } });
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    await f.database.shutdown();
    faulted = false;
    await f.database.init();
    assert.equal(f.database.__runtimeInitialized, true, 'a failing mail scan is not a fatal startup failure');
    while (!faulted) await new Promise(resolve => setImmediate(resolve));
    await stopNotificationIntentWorker(f.database);
    assert.equal(f.database.adapter.prepare('SELECT state FROM sporades_notification_recipients').get().state, 'submitting');
    assert.equal((await runMutation(f.database, actor, 'status', [])).ok, true, 'init did not close the database');
  } finally { await f.close(); }
});

test('a failed notification storage bootstrap does not reject init()', async () => {
  const f = await fixture();
  const originalExec = f.database.adapter.exec;
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    await f.database.shutdown();
    let broken = true;
    f.database.adapter.exec = async (sqlText, ...args) => {
      if (broken && typeof sqlText === 'string' && sqlText.includes('sporades_notification_intents')) {
        broken = false;
        throw Object.assign(new Error('storage bootstrap contention'), { code: 'RESOURCE_BUSY', retryable: true });
      }
      return originalExec.call(f.database.adapter, sqlText, ...args);
    };
    await f.database.init();
    assert.equal(f.database.__runtimeInitialized, true, 'a failed storage bootstrap is not a fatal startup failure');
    assert.equal(broken, false, 'the injected failure actually fired');
    f.database.adapter.exec = originalExec;
    assert.equal((await runMutation(f.database, actor, 'status', [])).ok, true, 'init did not close the database');
  } finally {
    f.database.adapter.exec = originalExec;
    await stopNotificationIntentWorker(f.database);
    await f.close();
  }
});

test('a repeated recipient address is invalid input, not an opaque storage failure', async () => {
  const f = await fixture();
  try {
    const duplicate = await runMutation(f.database, actor, 'accept', [notification({ to: ['one@example.com', 'one@example.com'] })]);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, 'RESOURCE_INVALID_INPUT');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_recipients').get().n, 0);
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM writes').get().n, 0, 'the outer transaction rolled back intact');
    const accepted = await runMutation(f.database, actor, 'accept', [notification()]);
    assert.equal(accepted.ok, true, 'the enclosing transaction was never poisoned');
    assert.equal(f.database.adapter.prepare('SELECT count(*) n FROM sporades_notification_recipients').get().n, 1);
  } finally { await f.close(); }
});

test('the post-drain wake is bounded by the recovery scan interval', async () => {
  const f = await fixture();
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    const farFuture = new Date(f.clock.now().getTime() + NOTIFICATION_MAX_BACKOFF_MS).toISOString();
    f.database.adapter.prepare("UPDATE sporades_notification_recipients SET state='retry-wait',nextAttemptAt=?").run(farFuture);

    await startNotificationIntentWorker(f.database);
    assert.equal(f.deliveries.length, 0, 'the backed-off recipient is not due');
    assert.ok(f.database.__notificationIntentTimer);
    assert.equal(f.database.__notificationIntentNativeTimer, true,
      'an hour of backoff must not shadow an intent committed a second later');
    await stopNotificationIntentWorker(f.database);

    const near = new Date(f.clock.now().getTime() + recoveryScanMs - 5_000).toISOString();
    f.database.adapter.prepare("UPDATE sporades_notification_recipients SET state='retry-wait',nextAttemptAt=?").run(near);
    await startNotificationIntentWorker(f.database);
    assert.equal(f.database.__notificationIntentNativeTimer, false, 'the bound is a ceiling, not a replacement');
  } finally { await stopNotificationIntentWorker(f.database); await f.close(); }
});

test('the reservation deadline is derived from the configured SMTP timeouts, not a fixed constant', async () => {
  for (const [connectionTimeoutMs, socketTimeoutMs, expectedWindowMs] of [
    [10_000, 30_000, 370_000],
    [5_000, 50_000, 605_000],
  ]) {
    const f = await fixture({
      smtp: { connectionTimeoutMs, socketTimeoutMs },
      fault: phase => { if (phase === 'before-submit') throw Object.assign(new Error('crash before submit'), { notificationIntentCrash: true }); },
    });
    try {
      assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
      await assert.rejects(runNotificationIntentDeliveryPass(f.database), /crash before submit/);
      const row = f.database.adapter.prepare('SELECT state,currentAttemptDeadline FROM sporades_notification_recipients').get();
      assert.equal(row.state, 'submitting');
      const windowMs = Date.parse(row.currentAttemptDeadline) - f.clock.now().getTime();
      assert.ok(windowMs > 30_000, `a slow-but-configured-that-way SMTP conversation must outlive the fixed 30s constant, got ${windowMs}ms`);
      assert.equal(windowMs, expectedWindowMs, 'the window is derived from connectionTimeoutMs + socketTimeoutMs * round-trip margin');
    } finally { await f.close(); }
  }
});

test('stopping the worker during the near-wake lookup wins the race against arming a stray timer', async () => {
  const f = await fixture();
  const originalPrepare = f.database.adapter.prepare;
  try {
    assert.equal((await runMutation(f.database, actor, 'accept', [notification()])).ok, true);
    const near = new Date(f.clock.now().getTime() + 5_000).toISOString();
    f.database.adapter.prepare("UPDATE sporades_notification_recipients SET state='retry-wait',nextAttemptAt=?").run(near);

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.database.adapter.prepare = function (sqlText, ...args) {
      const statement = originalPrepare.call(this, sqlText, ...args);
      if (typeof sqlText === 'string' && sqlText.includes('ORDER BY CASE WHEN') && sqlText.includes('currentAttemptDeadline')) {
        return { ...statement, get: async (...getArgs) => { await gate; return statement.get(...getArgs); } };
      }
      return statement;
    };

    const runPromise = startNotificationIntentWorker(f.database);
    // Let the drain loop reach and block inside the near-wake lookup before requesting a stop.
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    stopNotificationIntentWorker(f.database);
    release();
    await runPromise;

    assert.equal(f.database.__notificationIntentTimer, null, 'a stop request must not be clobbered by a timer armed after it landed');
  } finally {
    f.database.adapter.prepare = originalPrepare;
    await stopNotificationIntentWorker(f.database);
    await f.close();
  }
});
