import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createControllableRuntimeClock, createWebSocketHub, openDevDatabase, resolveAnonymousSession, signUpWithEmail, signInWithEmail, runMutation, runQuery, runEndpoint, sendEmailPasswordResetLink } from '../dist/server-runtime-source.js';
import { capsule, job, mutation, query } from '../dist/server.js';
import { readProjectConfig } from '../dist/cli/project-config.js';
import { resolveRegistrationThrottle } from '../dist/capsule-rate-limit.js';
import { currentEmailSignInThrottleState, PASSWORD_RESET_THROTTLE_FIELD } from '../dist/auth-runtime.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

const config = { name: 'limiter', auth: { providers: { anonymous: true, email: true } } };
async function withDatabase(configuration, definition, run) {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-capsule-limits-'));
  const clock = createControllableRuntimeClock('2030-01-01T00:00:00.000Z');
  const db = await openDevDatabase(path.join(root, 'data.db'), '', {}, configuration, definition, { clock });
  try { await run(db, clock); } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
}
const credentials = email => ({ email, password: 'correct horse battery staple' });
const options = { limit: 1, windowMs: 60000 };

test('mutations, endpoints, ordinary and privileged Jobs share quota without rollback refunds or inherited addresses', async () => {
  const seen = [];
  const definition = capsule({ name: 'limiter', schema: {}, jobs: {
    ordinary: job(ctx => { seen.push([ctx.rateLimit('shared', options).ok, ctx.auth.clientAddress]); }),
    privileged: job(ctx => { seen.push([ctx.rateLimit('shared', options).ok, ctx.auth.clientAddress]); }),
  }, mutations: {
    consumeThenFail: mutation(ctx => { ctx.rateLimit('shared', { limit: 1, windowMs: 60000 }); throw new Error('rollback'); }),
    enqueue: mutation(async ctx => { await ctx.jobs.enqueue('ordinary', null); await ctx.privileged.run({ operation: 'limit-test.enqueue', targetResourceKind: 'job-queue' }, p => p.jobs.enqueue('privileged', null)); }),
  }, queries: { address: query(ctx => ctx.auth.clientAddress ?? null) } });
  await withDatabase(config, definition, async (db, clock) => {
    const session = await resolveAnonymousSession(db, null);
    const failed = await runMutation(db, session.auth, 'consumeThenFail', []);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.message, 'rollback');
    db.securitySession = 'hosted'; db.runtimeProbeToken = 'a'.repeat(64);
    const result = await runEndpoint(db, { handler: ctx => ({ result: ctx.rateLimit('shared', options), address: ctx.request.clientAddress }) }, new URL('http://capsule.test/limited'), {
      method: 'GET', headers: { 'x-sporades-client-address': '192.0.2.1', 'x-sporades-client-address-token': clientAddressBoundaryToken(db.runtimeProbeToken) }, async *[Symbol.asyncIterator]() {},
    });
    assert.equal(result.result.ok, false); assert.equal(result.address, '192.0.2.1');
    const queued = await runMutation(db, session.auth, 'enqueue', [], { clientAddress: '192.0.2.1' });
    assert.equal(queued.ok, true, queued.error?.message);
    await db.init();
    await clock.runDueTimers();
    assert.deepEqual(seen, [[false, undefined], [false, undefined]]);
    const queried = await runQuery(db, session.auth, 'address', [], { clientAddress: '192.0.2.1' });
    assert.equal(queried.data, '192.0.2.1');
    const withoutRequest = await runQuery(db, { ...session.auth, clientAddress: 'forged-persisted-address' }, 'address');
    assert.equal(withoutRequest.data, null);
  });
});

test('Hosted sign-in and password-reset address quotas survive session and email rotation', async () => {
  await withDatabase(config, {}, async db => {
    const registered = await signUpWithEmail(db, await resolveAnonymousSession(db, null), 'email', credentials('valid@example.test'));
    assert.equal(registered.ok, true);
    db.securitySession = 'hosted';
    const caller = async address => ({ ...await resolveAnonymousSession(db, null), clientAddress: address });
    for (let i = 0; i < 5; i++) {
      assert.equal((await signInWithEmail(db, await caller('192.0.2.1'), credentials(`wrong-${i}@example.test`))).ok, false);
    }
    assert.equal((await signInWithEmail(db, await caller('192.0.2.1'), credentials('valid@example.test'))).error.code, 'INVALID_EMAIL_CREDENTIALS');
    assert.equal((await signInWithEmail(db, await caller('192.0.2.2'), credentials('valid@example.test'))).ok, true);
    for (let i = 0; i < 4; i++) await signInWithEmail(db, await caller('192.0.2.5'), credentials(`before-success-${i}@example.test`));
    assert.equal((await signInWithEmail(db, await caller('192.0.2.5'), credentials('valid@example.test'))).ok, true);
    await signInWithEmail(db, await caller('192.0.2.5'), credentials('after-success@example.test'));
    assert.equal((await signInWithEmail(db, await caller('192.0.2.5'), credentials('valid@example.test'))).error.code, 'INVALID_EMAIL_CREDENTIALS', 'a known account cannot refund address-wide failures');
    // A local fake mail transport allows request enqueue without external delivery.
    db.mail.enabled = true;
    for (let i = 0; i < 5; i++) assert.equal((await sendEmailPasswordResetLink(db, await caller('192.0.2.3'), `reset-${i}@example.test`)).ok, true);
    const count = db.adapter.prepare('SELECT COUNT(*) AS n FROM sporades_jobs').get().n;
    assert.equal((await sendEmailPasswordResetLink(db, await caller('192.0.2.3'), 'next@example.test')).ok, true, 'reset response remains opaque');
    assert.equal(db.adapter.prepare('SELECT COUNT(*) AS n FROM sporades_jobs').get().n, count);
    const blocked = currentEmailSignInThrottleState(db, 'next@example.test', await caller('192.0.2.3'), PASSWORD_RESET_THROTTLE_FIELD);
    assert.equal(blocked.throttled, true);
    assert.equal((await sendEmailPasswordResetLink(db, await caller('192.0.2.4'), 'next@example.test')).ok, true);
    assert.equal(db.adapter.prepare('SELECT COUNT(*) AS n FROM sporades_jobs').get().n, count + 1);
  });
});

test('registration throttles normalize email, count duplicate attempts and limit rotating sessions per trusted address', async () => {
  const configured = { ...config, auth: { ...config.auth, email: { registration: { throttle: { email: { limit: 1, windowMs: 60000 }, address: { limit: 2, windowMs: 60000 } } } } } };
  await withDatabase(configured, {}, async db => {
    db.securitySession = 'hosted';
    const signup = async (email, address) => signUpWithEmail(db, { ...await resolveAnonymousSession(db, null), clientAddress: address }, 'email', credentials(email));
    assert.equal((await signup('first@example.test', '192.0.2.1')).ok, true);
    const repeated = await signup(' FIRST@example.test ', '192.0.2.2');
    assert.equal(repeated.error.code, 'REGISTRATION_THROTTLED');
    assert.ok(repeated.error.retryAfterMs > 0 && repeated.error.retryAfterMs <= 60000);
    assert.equal((await signup('second@example.test', '192.0.2.1')).ok, true);
    assert.equal((await signup('third@example.test', '192.0.2.1')).error.code, 'REGISTRATION_THROTTLED');
    assert.equal((await signup('fourth@example.test', '192.0.2.3')).ok, true);
    db.securitySession = 'dev';
    for (let i = 0; i < 3; i++) assert.equal((await signup(`local-${i}@example.test`, '192.0.2.1')).ok, true, 'Dev does not trust supplied address metadata');
  });
});

test('registration throttle is opt-in and invalid configuration fails at runtime startup', async () => {
  assert.equal(resolveRegistrationThrottle({}), null);
  assert.equal(resolveRegistrationThrottle({ email: { registration: { throttle: false } } }), null);
  assert.deepEqual(resolveRegistrationThrottle({ email: { registration: { throttle: {} } } }), { email: { limit: 5, windowMs: 900000 }, address: { limit: 20, windowMs: 900000 } });
  for (const value of [true, null, [], { typo: {} }, { email: { limit: 0, windowMs: 1 } }, { address: { limit: 1, windowMs: 86400001 } }]) {
    assert.throws(() => resolveRegistrationThrottle({ email: { registration: { throttle: value } } }), { code: 'INVALID_AUTH_CONFIG' });
  }
});


test('WebSocket queries, mutations and auth use the connection address across fresh Sessions', { timeout: 10000 }, async () => {
  const definition = capsule({ name: 'limiter', schema: {}, queries: { address: query(ctx => ctx.auth.clientAddress) }, mutations: { address: mutation(ctx => ctx.auth.clientAddress) } });
  await withDatabase(config, definition, async db => {
    assert.equal((await signUpWithEmail(db, await resolveAnonymousSession(db, null), 'email', credentials('websocket@example.test'))).ok, true);
    db.securitySession = 'hosted'; db.runtimeProbeToken = 'a'.repeat(64);
    const hub = createWebSocketHub(() => db);
    const server = createServer();
    // Local fake proxy: the real Hosted renderer overwrites these exact internal headers.
    server.on('upgrade', (request, socket) => {
      for (const [key, value] of Object.entries({ 'x-sporades-client-address': '192.0.2.25', 'x-sporades-client-address-token': clientAddressBoundaryToken(db.runtimeProbeToken) })) {
        request.headers[key] = value; request.rawHeaders.push(key, value);
      }
      request.headers['x-forwarded-for'] = '203.0.113.55';
      void hub.accept(request, socket);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/__sporades/ws?connectionToken=${hub.createConnectionToken()}`);
    let sequence = 0;
    const request = message => new Promise((resolve, reject) => {
      const id = `request-${++sequence}`;
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('No WebSocket response')); }, 3000);
      function receive(event) {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        clearTimeout(timer); socket.removeEventListener('message', receive); resolve(response);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, ...message, clientAddress: '203.0.113.55' }));
    });
    try {
      await once(socket, 'open');
      const q = await request({ type: 'query.subscribe', query: 'address', args: [] });
      assert.equal(q.error, null); assert.equal(q.data, '192.0.2.25');
      const m = await request({ type: 'mutation.run', mutation: 'address', args: [] });
      assert.equal(m.error, null); assert.equal(m.data, '192.0.2.25');
      for (let i = 0; i < 5; i++) {
        const failure = await request({ type: 'auth.signIn', provider: 'email', credentials: credentials(`fresh-${i}@example.test`), sessionToken: `missing-${i}` });
        assert.ok(failure.error);
      }
      const blocked = await request({ type: 'auth.signIn', provider: 'email', credentials: credentials('websocket@example.test'), sessionToken: 'another-fresh-session' });
      assert.equal(blocked.error.code, 'INVALID_EMAIL_CREDENTIALS');
    } finally {
      socket.close(); hub.disconnectAll();
      await new Promise(resolve => server.close(resolve));
    }
  });
});


test('CLI configuration and direct runtime startup reject invalid registration throttle options', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-throttle-config-'));
  try {
    const invalid = { ...config, auth: { ...config.auth, email: { registration: { throttle: { address: { limit: 0, windowMs: 1 } } } } } };
    await writeFile(path.join(root, 'sporades.json'), JSON.stringify(invalid));
    await assert.rejects(readProjectConfig(root), { code: 'INVALID_AUTH_CONFIG' });
    await assert.rejects(openDevDatabase(path.join(root, 'data.db'), '', {}, invalid), { code: 'INVALID_AUTH_CONFIG' });
    const enabled = { ...config, auth: { ...config.auth, email: { registration: { throttle: {} } } } };
    await writeFile(path.join(root, 'sporades.json'), JSON.stringify(enabled));
    assert.deepEqual((await readProjectConfig(root)).auth.email.registration.throttle, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('mutation password-reset throttles belong to the root runtime across transaction wrappers', async () => {
  const definition = capsule({ name: 'limiter', schema: {}, mutations: { reset: mutation((ctx, email) => ctx.serverAuth.sendEmailPasswordResetLink(email)) } });
  await withDatabase(config, definition, async db => {
    db.securitySession = 'hosted'; db.mail.enabled = true;
    for (let i = 0; i < 6; i++) {
      const session = await resolveAnonymousSession(db, null);
      const result = await runMutation(db, session.auth, 'reset', [`person-${i}@example.test`], { clientAddress: '192.0.2.60' });
      assert.equal(result.ok, true, result.error?.message);
    }
    assert.equal(db.adapter.prepare('SELECT COUNT(*) AS n FROM sporades_jobs').get().n, 5);
  });
});
