import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { capsule, endpoint, endpointFor, requireAuth, mutation } from '../dist/server.js';
import { extractEndpoints, openDevDatabase, resolveAnonymousSession, runEndpoint, runMutation } from '../dist/server-runtime-source.js';
import { createEndpointFileResponseApi } from '../dist/endpoint-file-response.js';

const allowed = ['app', 'env', 'log', 'rateLimit', 'request', 'signal'];
const options = { method: 'POST', path: '/health', session: 'none' };
const request = (headers = {}, body = '', signal) => Object.assign(Readable.from([body]), { method: 'POST', headers, signal });
async function withDatabase(definition, run) {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-sessionless-'));
  let db;
  try {
    db = await openDevDatabase(path.join(root, 'data.db'), '', { HEALTH: 'ok' }, { name: 'sessionless', http: { maxBodyBytes: 64 } }, definition);
    await run(db);
  } finally { await db?.close(); await rm(root, { recursive: true, force: true }); }
}
function authSnapshot(db, prepare = db.adapter.prepare.bind(db.adapter)) {
  return Object.fromEntries(prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sporades_auth_%' ORDER BY name").all()
    .map(({ name }) => [name, prepare(`SELECT * FROM [${name}] ORDER BY rowid`).all()]));
}

test('sessionless declarations reject incompatible authority in helpers, raw Capsule startup and dispatch', async () => {
  const handler = () => null;
  const invalid = [
    ...[undefined, null, false, 'auto', 'required', {}].map(session => ({ options: { ...options, session }, handler })),
    ...[{ body: { multipart: {} } }, { response: { fileAttachment: true } }, { mcp: true }].map(extra => ({ options: { ...options, ...extra }, handler })),
    { options, handler: requireAuth(handler) },
    { options, runtimeOwnedStripeCallback: true, handler },
    { options, runtimeOwnedEmailEvent: true, handler },
  ];
  for (const definition of invalid) {
    if (!definition.runtimeOwnedStripeCallback && !definition.runtimeOwnedEmailEvent) {
      assert.throws(() => endpoint(definition.options, definition.handler), { code: 'INVALID_ENDPOINT_SESSION_DECLARATION' });
      assert.throws(() => endpointFor({})(definition.options, definition.handler), { code: 'INVALID_ENDPOINT_SESSION_DECLARATION' });
    }
    const raw = { kind: 'endpoint', ...definition };
    assert.throws(() => capsule({ name: 'invalid', endpoints: { health: raw } }), { code: 'INVALID_ENDPOINT_SESSION_DECLARATION' });
    await assert.rejects(withDatabase({ endpoints: { health: raw } }, () => {}), { code: 'INVALID_ENDPOINT_SESSION_DECLARATION' });
    await assert.rejects(runEndpoint({}, raw, new URL('http://localhost/health'), request()), { code: 'INVALID_ENDPOINT_SESSION_DECLARATION' });
  }
});

test('sessionless requests never read or touch auth storage, enter transactions or run middleware', async () => {
  let retained;
  globalThis.__sessionlessMiddlewareRuns = 0;
  const definition = capsule({ name: 'sessionless', schema: {}, middleware: [(ctx) => { globalThis.__sessionlessMiddlewareRuns++; ctx.identityLeak = ctx.auth; return ctx; }],
    mutations: { issue: mutation((ctx, name) => ctx.accessKeys.issue({ name })) },
    endpoints: { health: endpoint(options, ctx => {
      retained = ctx;
      assert.deepEqual(Object.keys(ctx).sort(), allowed);
      assert.deepEqual(Object.getOwnPropertySymbols(ctx), []);
      assert.equal(ctx.env.HEALTH, 'ok');
      ctx.log.info('Public health requested');
      return { body: { healthy: true, limited: !ctx.rateLimit('health', { limit: 1, windowMs: 60000 }).ok } };
    }) },
  });
  await withDatabase(definition, async db => {
    const valid = await resolveAnonymousSession(db, null);
    const expired = await resolveAnonymousSession(db, null);
    db.adapter.prepare('UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', expired.token);
    const owner = { userId: 'key-owner', displayName: 'Owner', email: 'owner@example.test', picture: null, isAuthenticated: true, isGuest: false, provider: 'email' };
    await db.adapter.insertAuthUser({ id: owner.userId, ...owner, isAuthenticated: 1, isGuest: 0, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.adapter.insertAuthSession({ token: 'owner-token', userId: owner.userId, provider: 'email', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const issued = await runMutation(db, owner, 'issue', ['ignored-key'], { sessionToken: 'owner-token' });
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const expiredKey = await runMutation(db, owner, 'issue', ['expired-key'], { sessionToken: 'owner-token' });
    const revokedKey = await runMutation(db, owner, 'issue', ['revoked-key'], { sessionToken: 'owner-token' });
    assert.equal(expiredKey.ok, true, JSON.stringify(expiredKey));
    assert.equal(revokedKey.ok, true, JSON.stringify(revokedKey));
    db.adapter.prepare('UPDATE sporades_auth_access_keys SET expiresAt = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiredKey.data.accessKey.id);
    db.adapter.prepare('UPDATE sporades_auth_access_keys SET revokedAt = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', revokedKey.data.accessKey.id);
    await db.adapter.insertPasswordResetCode({ selector: 'reset-sentinel', verifierHash: 'dummy', email: owner.email, userId: owner.userId, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' });
    await db.adapter.replaceReauthenticationProof({ id: 'proof-sentinel', userId: owner.userId, sessionToken: expired.token, purpose: 'test', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' });
    globalThis.__sessionlessMiddlewareRuns = 0;
    const before = authSnapshot(db);
    const events = [];
    db.log.emit = event => { events.push(event); };
    const originalTransaction = db.adapter.withTransaction;
    const originalPrepare = db.adapter.prepare.bind(db.adapter);
    const snapshot = () => authSnapshot(db, originalPrepare);
    db.adapter.withTransaction = () => { throw new Error('sessionless transaction'); };
    db.adapter.prepare = sql => {
      assert.doesNotMatch(sql, /sporades_auth_/i, 'sessionless dispatch must not even read auth storage');
      return originalPrepare(sql);
    };
    const heads = [{}, {}, {}, { 'x-sporades-session-token': valid.token }, { 'x-sporades-session-token': 'unknown' },
      { 'x-sporades-session-token': expired.token }, { cookie: `sporades_session=${valid.token}` },
      { authorization: `Bearer ${issued.data.token}` }, { authorization: `Bearer ${expiredKey.data.token}` },
      { authorization: `Bearer ${revokedKey.data.token}` }, { authorization: 'Bearer unknown' }];
    try {
      for (const [index, headers] of heads.entries()) {
        const result = await runEndpoint(db, db.endpoints[0], new URL('http://localhost/health'), request(headers));
        assert.deepEqual(result.body, { healthy: true, limited: index > 0 });
        assert.deepEqual(snapshot(), before);
      }
      const concurrent = await Promise.all(heads.map(headers => runEndpoint(db, db.endpoints[0], new URL('http://localhost/health'), request(headers))));
      assert.ok(concurrent.every(result => result.body.healthy && result.body.limited));
      assert.deepEqual(snapshot(), before, 'concurrent callers cannot introduce identity or credential usage state');
      assert.equal(globalThis.__sessionlessMiddlewareRuns, 0);
      assert.equal(retained.auth, undefined);
      assert.deepEqual(Object.keys(retained).sort(), allowed);
      assert.equal(events.filter(e => e.event?.startsWith('access-key.')).length, 0);
      assert.ok(events.some(e => e.event === 'ctx.log'));
      const failing = { options, handler() { throw new Error('handler failed'); } };
      await assert.rejects(runEndpoint(db, failing, new URL('http://localhost/health'), request()), /handler failed/);
      const consumeThenFail = { options, handler(ctx) { ctx.rateLimit('failed-health', { limit: 1, windowMs: 60000 }); throw new Error('failed after limiting'); } };
      await assert.rejects(runEndpoint(db, consumeThenFail, new URL('http://localhost/health'), request()), /failed after limiting/);
      assert.equal(await runEndpoint(db, { options, handler: ctx => ctx.rateLimit('failed-health', { limit: 1, windowMs: 60000 }).ok }, new URL('http://localhost/health'), request()), false, 'a handler error does not refund a limiter bucket');
      const controller = new AbortController();
      const pending = runEndpoint(db, { options, handler: ctx => new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve('aborted'), { once: true })) }, new URL('http://localhost/health'), request({}, '', controller.signal));
      setImmediate(() => controller.abort());
      await pending;
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(runEndpoint(db, db.endpoints[0], new URL('http://localhost/health'), request({}, '', aborted.signal)), { name: 'AbortError' });
      const attachmentApi = createEndpointFileResponseApi({}, true);
      const descriptor = attachmentApi.files.attachment({ id: 'retained-file', version: 'v1' }, { filename: 'retained.txt' });
      await assert.rejects(runEndpoint(db, { options, handler: () => descriptor }, new URL('http://localhost/health'), request()), { code: 'INVALID_ENDPOINT_RESPONSE' });
      const sealed = attachmentApi.sealCommittedResult(descriptor);
      await assert.rejects(runEndpoint(db, { options, handler: () => sealed }, new URL('http://localhost/health'), request()), { code: 'INVALID_ENDPOINT_RESPONSE' });
      await assert.rejects(runEndpoint(db, db.endpoints[0], new URL('http://localhost/health'), request({ 'content-type': 'application/json' }, '{')), { code: 'INVALID_JSON_REQUEST' });
      await assert.rejects(runEndpoint(db, db.endpoints[0], new URL('http://localhost/health'), request({}, 'x'.repeat(65))), { code: 'PAYLOAD_TOO_LARGE' });
      assert.deepEqual(snapshot(), before);
    } finally { db.adapter.withTransaction = originalTransaction; db.adapter.prepare = originalPrepare; }
    assert.equal(await runEndpoint(db, { handler: ctx => ctx.auth.userId }, new URL('http://localhost/ordinary'), request({ 'x-sporades-session-token': valid.token })), valid.auth.userId);
    await runEndpoint(db, { handler: ctx => ctx.auth.userId }, new URL('http://localhost/ordinary'), request());
    assert.equal(globalThis.__sessionlessMiddlewareRuns, 2);
    assert.equal(authSnapshot(db).sporades_auth_users.length, before.sporades_auth_users.length + 1);
    assert.equal(authSnapshot(db).sporades_auth_sessions.length, before.sporades_auth_sessions.length + 1);
  });
});

test('legacy source routes preserve the explicit session discriminant', () => {
  const [route] = extractEndpoints(`{ endpoints: { health: endpoint({ method: 'GET', path: '/health', session: 'none' }, ctx => ctx.request.path) } }`);
  assert.equal(route.options.session, 'none');
});

test('sessionless allowed capabilities cannot inherit middleware-retained identity objects', async () => {
  const definition = capsule({ name: 'sessionless-retention', middleware: [ctx => {
    ctx.env.retainedContext = ctx;
    ctx.rateLimit.retainedContext = ctx;
    return ctx;
  }], endpoints: {
    ordinary: endpoint({ method: 'POST', path: '/ordinary' }, () => null),
    health: endpoint(options, ctx => ({
      envIdentity: ctx.env.retainedContext?.auth?.userId ?? null,
      limiterIdentity: ctx.rateLimit.retainedContext?.auth?.userId ?? null,
    })),
  } });
  await withDatabase(definition, async db => {
    try {
      await runEndpoint(db, db.endpoints[0], new URL('http://localhost/ordinary'), request());
      assert.ok(db.serverEnv.retainedContext.auth.userId);
      const before = authSnapshot(db);
      assert.deepEqual(await runEndpoint(db, db.endpoints[1], new URL('http://localhost/health'), request()), { envIdentity: null, limiterIdentity: null });
      assert.deepEqual(authSnapshot(db), before);
    } finally {
      delete db.serverEnv.retainedContext;
      delete db.capsuleRateLimiter.consume.retainedContext;
    }
  });
});
