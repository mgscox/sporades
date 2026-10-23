import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createRuntimeObservability, routeCollection } from '../dist/observability-runtime.js';

const config = {
  observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } },
  analytics: { provider: 'umami', endpointEnv: 'ANALYTICS', websiteIdEnv: 'WEBSITE' },
};
const env = { DSN: 'http://dummy@127.0.0.1:5299/1', ANALYTICS: 'http://127.0.0.1:5299/analytics', WEBSITE: 'dummy' };
const origin = 'http://localhost:5203';
const request = { headers: {} };
const client = { type: 'error', message: 'client failure', surface: 'mutation', provenance: 'server' };
const pageview = { type: 'pageview', url: origin + '/page?token=private' };
const violation = { directive: 'script-src', blocked: 'inline' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, transport = async () => ({ body: { cancel: async () => {} } })) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), ...options });
    return transport(url, options);
  });
  const obs = createRuntimeObservability(config, env);
  t.after(() => obs.close());
  return { obs, calls, advance: ms => { now += ms; } };
}
const serverError = obs => obs.capture(new Error('original application failure'), 'mutation');
const publicError = obs => obs.collect(client, origin, request, {});
const analytics = obs => obs.collect(pageview, origin, request, {});
const event = call => JSON.parse(call.body.trim().split('\n')[2]);

// This reproduces the original capturing-transport starvation independently of HTTP.
test('invalid ingress reservations cannot exhaust trusted delivery and ingress releases are single-use', async t => {
  const { obs, calls, advance } = setup(t);
  serverError(obs); await obs.flush();
  for (let i = 0; i < 120; i++) {
    const release = obs.acquireIngress();
    assert.equal(typeof release, 'function');
    release(); release();
  }
  assert.equal(obs.acquireIngress(), null);
  serverError(obs); await obs.flush();
  assert.equal(calls.length, 2);
  advance(60000);
  const releases = Array.from({ length: 8 }, () => obs.acquireIngress());
  assert(releases.every(release => typeof release === 'function'));
  assert.equal(obs.acquireIngress(), null);
  serverError(obs); await obs.flush();
  assert.equal(calls.length, 3);
  releases[0](); releases[0]();
  const replacement = obs.acquireIngress();
  assert.equal(typeof replacement, 'function');
  assert.equal(obs.acquireIngress(), null, 'duplicate release cannot create extra ingress capacity');
  releases.forEach(release => release()); replacement();
});

test('client errors, CSP and analytics share only the public outbound window, charged once per event', async t => {
  const { obs, calls, advance } = setup(t);
  for (let i = 0; i < 20; i++) {
    await publicError(obs); await obs.flush();
    obs.captureCspViolation(violation); await obs.flush();
    await analytics(obs);
  }
  assert.equal(calls.length, 60);
  assert.equal(calls.filter(call => call.url.endsWith('/analytics')).length, 20);
  assert.equal(calls.filter(call => !call.url.endsWith('/analytics') && event(call).tags.surface === 'client').length, 20);
  assert.equal(calls.filter(call => !call.url.endsWith('/analytics') && event(call).tags.surface === 'csp').length, 20);
  await publicError(obs); obs.captureCspViolation(violation); await analytics(obs); await obs.flush();
  assert.equal(calls.length, 60);
  for (let i = 0; i < 61; i++) { serverError(obs); await obs.flush(); }
  assert.equal(calls.length, 120, 'each outbound lane reserves exactly 60 sends');
  advance(59999);
  serverError(obs); await publicError(obs); await obs.flush();
  assert.equal(calls.length, 120);
  advance(1);
  serverError(obs); await publicError(obs); await obs.flush();
  assert.equal(calls.length, 122, 'fixed windows recover at the boundary');
});

test('outbound windows share an epoch even when their first events arrive at different times', async t => {
  const { obs, calls, advance } = setup(t);
  for (let i = 0; i < 60; i++) { serverError(obs); await obs.flush(); }
  advance(30000);
  for (let i = 0; i < 60; i++) { await publicError(obs); await obs.flush(); }
  assert.equal(calls.length, 120);
  advance(30000);
  for (let i = 0; i < 60; i++) { serverError(obs); await obs.flush(); await publicError(obs); await obs.flush(); }
  assert.equal(calls.length, 240);
  advance(30000);
  serverError(obs); await publicError(obs); await obs.flush();
  assert.equal(calls.length, 240, 'neither lane drifts into a different fixed window');
});

test('each outbound lane caps concurrency at four and together at eight with no queued sends', async t => {
  const finish = [];
  const { obs, calls } = setup(t, () => new Promise(resolve => finish.push(() => resolve({ body: { cancel: async () => {} } }))));
  const pages = [analytics(obs), analytics(obs)];
  await publicError(obs); obs.captureCspViolation(violation);
  for (let i = 0; i < 10; i++) { await publicError(obs); obs.captureCspViolation(violation); }
  assert.equal(calls.length, 4);
  for (let i = 0; i < 10; i++) serverError(obs);
  assert.equal(calls.length, 8);
  finish[0](); await pages[0];
  await publicError(obs);
  assert.equal(calls.length, 9, 'one completed send admits one replacement');
  await analytics(obs);
  assert.equal(calls.length, 9, 'completion releases the slot only once');
  finish.forEach(resolve => resolve()); await Promise.all(pages); await obs.flush();
  assert.equal(calls.length, 9, 'dropped sends are never queued');
});

test('provider rejection, response cancellation failure and abort release both outbound lanes without refunds', { timeout: 10000 }, async t => {
  for (const mode of ['reject', 'cancel', 'timeout']) await t.test(mode, async t => {
    const timeouts = [];
    if (mode === 'timeout') t.mock.method(AbortSignal, 'timeout', ms => {
      assert.equal(ms, 2000);
      const controller = new AbortController(); timeouts.push(controller); return controller.signal;
    });
    const { obs, calls, advance } = setup(t, (_url, { signal }) => {
      if (mode === 'reject') return Promise.reject(new Error('private provider failure'));
      if (mode === 'cancel') return Promise.resolve({ body: { cancel: async () => { throw new Error('private cancellation failure'); } } });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    for (let batch = 0; batch < 15; batch++) {
      const pages = Array.from({ length: 4 }, () => analytics(obs));
      for (let i = 0; i < 4; i++) serverError(obs);
      if (mode === 'timeout') timeouts.splice(0).forEach(controller => controller.abort(new DOMException('Timeout', 'TimeoutError')));
      await Promise.allSettled(pages); await obs.flush();
      assert.equal(calls.length, (batch + 1) * 8);
    }
    serverError(obs); await analytics(obs); await obs.flush();
    assert.equal(calls.length, 120, 'failures release concurrency without refunding the window');
    advance(60000);
    const recovery = analytics(obs); serverError(obs);
    if (mode === 'timeout') timeouts.splice(0).forEach(controller => controller.abort());
    await Promise.allSettled([recovery]); await obs.flush();
    assert.equal(calls.length, 122);
  });
});

test('outstanding sends retain concurrency across a window boundary', async t => {
  const finish = [];
  const { obs, calls, advance } = setup(t, () => new Promise(resolve => finish.push(() => resolve({}))));
  for (let i = 0; i < 4; i++) { serverError(obs); await publicError(obs); }
  advance(60000);
  serverError(obs); await publicError(obs);
  assert.equal(calls.length, 8, 'window rollover never resets active sends');
  finish[0](); await tick();
  await publicError(obs); assert.equal(calls.length, 8, 'a server completion cannot release public capacity');
  serverError(obs); assert.equal(calls.length, 9);
  finish.forEach(resolve => resolve()); await obs.flush();
});

test('shutdown aborts both outbound lanes, flush tracks analytics, and later captures cannot send', async t => {
  const signals = [], finishServer = [];
  const { obs, calls } = setup(t, (url, { signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => {
      if (!String(url).endsWith('/analytics')) finishServer.push(() => resolve({}));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const pages = Array.from({ length: 4 }, () => analytics(obs));
  for (let i = 0; i < 4; i++) serverError(obs);
  finishServer.forEach(resolve => resolve()); await tick();
  let flushed = false;
  const flushing = obs.flush().then(() => { flushed = true; });
  await tick(); assert.equal(flushed, false);
  obs.close(); obs.close();
  await Promise.allSettled(pages); await flushing;
  assert(signals.every(signal => signal.aborted));
  serverError(obs); await publicError(obs); obs.captureCspViolation(violation); await analytics(obs); await obs.flush();
  assert.equal(calls.length, 8);
  assert.equal(obs.acquireIngress(), null);
});

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// Use real sockets for collection ingress; only the provider transport and clock are fake.
async function httpFixture(t) {
  const nativeFetch = globalThis.fetch;
  const fixture = setup(t);
  const database = { observability: fixture.obs, securityPolicy: { csp: { reportTo: 'observability' } } };
  const origin = await listen(t, (req, res) => routeCollection(database, req, res));
  const post = (body, path = '/__sporades/collect') => nativeFetch(origin + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { ...fixture, origin, post };
}

test('real invalid-body flood counts all 120 ingress attempts and preserves server errors', async t => {
  const { obs, calls, advance, post } = await httpFixture(t);
  for (let i = 0; i < 120; i++) {
    const response = await post('{invalid', i % 2 ? '/__sporades/csp-report' : '/__sporades/collect');
    assert.equal(response.status, 400); assert.equal(await response.text(), '');
  }
  assert.equal((await post(client)).status, 429);
  serverError(obs); await obs.flush(); assert.equal(calls.length, 1);
  advance(60000);
  assert.equal((await post(client)).status, 204);
  await obs.flush(); assert.equal(calls.length, 2);
});

test('eight real held bodies reserve ingress without blocking server errors; abort and timeout recover', { timeout: 10000 }, async t => {
  const { obs, calls, origin, post } = await httpFixture(t);
  const held = [];
  for (let i = 0; i < 8; i++) {
    const req = httpRequest(origin + (i % 2 ? '/__sporades/csp-report' : '/__sporades/collect'), {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': 100 },
    });
    req.on('error', () => {}); req.write('{'); held.push(req);
  }
  t.after(() => held.forEach(req => req.destroy()));
  // A probe returning 429 proves that all eight bodies have entered the actual route.
  let status;
  for (let i = 0; i < 100; i++) { status = (await post('{')).status; if (status === 429) break; await tick(); }
  assert.equal(status, 429);
  serverError(obs); await obs.flush(); assert.equal(calls.length, 1);
  held.slice(0, 4).forEach(req => req.destroy());
  for (let i = 0; i < 100; i++) { status = (await post('{')).status; if (status === 400) break; await tick(); }
  assert.equal(status, 400, 'client abort releases ingress');
  await new Promise(resolve => setTimeout(resolve, 2100));
  const more = [];
  for (let i = 0; i < 8; i++) more.push(obs.acquireIngress());
  assert(more.every(release => typeof release === 'function'), 'timeouts release the remaining held requests');
  assert.equal(obs.acquireIngress(), null);
  more.forEach(release => release());
  assert.equal((await post(client)).status, 204); await obs.flush();
  assert.equal(calls.length, 2);
});

test('real client/CSP batches and analytics consume one shared public delivery window, never trusted capacity', async t => {
  const { obs, calls, post, origin } = await httpFixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await post(client)).status, 204); await obs.flush();
    const batch = Array.from({ length: 4 }, () => ({ type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'inline' } }));
    assert.equal((await post(batch, '/__sporades/csp-report')).status, 204); await obs.flush();
    assert.equal((await post({ type: 'pageview', url: origin })).status, 204);
  }
  assert.equal(calls.length, 60);
  assert.equal((await post(client)).status, 204); await obs.flush();
  assert.equal(calls.length, 60);
  for (let i = 0; i < 60; i++) { serverError(obs); await obs.flush(); }
  assert.equal(calls.length, 120);
  assert.equal(calls.filter(call => !call.url.endsWith('/analytics') && event(call).tags.surface === 'mutation').length, 60);
});

test('failed reporting preserves the original endpoint failure and mutation rollback', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { openDevDatabase, runQuery, runMutation, runEndpoint, resolveAnonymousSession } = await import('../dist/server-runtime-source.js');
  const { mutation, table, String: StringField } = await import('../dist/server.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'budget-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); throw new Error('private provider failure'); });
  const original = new Error('original application failure');
  const db = await openDevDatabase(path.join(root, 'data.db'), '', env, config, {
    schema: { notes: table({ text: StringField() }) },
    mutations: { fail: mutation(async ctx => { await ctx.db.notes.insert({ text: 'rolled-back' }); throw original; }) },
  });
  t.after(() => db.close());
  await db.init();
  const { auth } = await resolveAnonymousSession(db);
  const result = await runMutation(db, auth, 'fail', []);
  assert.equal(result.ok, false);
  assert.equal((await runQuery(db, auth, 'notes')).rows.length, 0);
  await assert.rejects(() => runEndpoint(db, { handler: () => { throw original; } }, new URL(origin + '/failure'), {
    method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {},
  }), error => error === original);
  await db.observability.flush();
  assert.equal(calls.length, 2);
});
