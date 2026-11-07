import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeObservability } from '../dist/observability-runtime.js';

const transports = new WeakMap();
function receivedEnvelopes(t) {
  if (!transports.has(t)) {
    const envelopes = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => { envelopes.push(options.body); return new Response(null); });
    transports.set(t, envelopes);
  }
  return transports.get(t);
}

async function captured(t, error, context, serverEnv = {}) {
  const envelopes = receivedEnvelopes(t), before = envelopes.length;
  const collector = createRuntimeObservability({ name: 'quality', release: { id: 'quality-release' }, observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } }, { DSN: 'http://synthetic@127.0.0.1:5218/1', SECRET: 'synthetic-private-marker', ...serverEnv });
  t.after(() => collector.close());
  collector.capture(error, 'query', undefined, context);
  await collector.flush();
  assert.equal(envelopes.length, before + 1);
  return { event: JSON.parse(envelopes.at(-1).trim().split('\n')[2]), envelope: envelopes.at(-1), collector };
}

test('caught exception from a large embedded module preserves original coordinates without source', async t => {
  const source = '/*' + 'synthetic-private-marker'.repeat(600) + '*/\nexport function fail(){throw new TypeError("synthetic capsule exception")}';
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let caught;
  try { mod.fail(); } catch (error) { caught = error; }
  const { event, envelope } = await captured(t, caught, { handler: 'fail' });
  assert.equal(event.exception.values[0].type, 'TypeError');
  assert.deepEqual(event.exception.values[0].stacktrace.frames.at(-1), { filename: 'sporades://capsule/server.mjs', function: 'Module.fail', lineno: 2, colno: 30 });
  assert.equal(event.tags.handler, 'fail');
  assert.equal(event.tags.correlation_id, event.event_id);
  assert.doesNotMatch(envelope, /data:text|base64|synthetic-private-marker/);
});

test('nested eval in a data module never sends encoded source in browser collection requests', async t => {
  const { Window } = await import('happy-dom');
  const { collectionLoaderSource } = await import('../dist/templates/observability-loader.js');
  const source = `export function fail() { eval('eval(\\'throw new TypeError("nested eval failure")\\')'); } // synthetic-inline-source`;
  const encoded = Buffer.from(source).toString('base64');
  const module = await import('data:text/javascript;base64,' + encoded);
  let caught;
  try { module.fail(); } catch (error) { caught = error; }
  assert(caught instanceof TypeError);
  assert.match(caught.stack, /eval at/);
  assert(caught.stack.includes(encoded), 'exercise a genuine stack containing encoded module source');
  const window = new Window({ url: 'http://localhost:5218' });
  t.after(() => window.happyDOM.abort());
  const requests = [];
  window.fetch = async (url, options) => {
    assert.equal(url, '/__sporades/collect');
    requests.push(options.body);
    return new Response(null);
  };
  window.eval(collectionLoaderSource(true, false));
  window.dispatchEvent(new window.ErrorEvent('error', { error: caught }));
  window.dispatchEvent(new window.ErrorEvent('error', { error: new RangeError('independent browser failure', { cause: caught }) }));
  assert.equal(requests.length, 2, 'both genuine errors still report');
  for (const body of requests) {
    assert(!body.includes(encoded), 'collection POST must exclude encoded module source');
    assert.doesNotMatch(body, /data:|blob:|base64|synthetic-inline-source/);
  }
  const [nested, independent] = requests.map(body => JSON.parse(body));
  assert.equal(nested.name, 'TypeError');
  assert.equal(nested.message, 'nested eval failure');
  assert.match(nested.stack, /sporades:\/\/embedded\/module:1:\d+/);
  assert.equal(independent.name, 'RangeError');
  assert.equal(independent.causes[0].name, 'TypeError');
});

test('browser collection normalizes nested blob locations and rejects embedded function labels', async t => {
  const { Window } = await import('happy-dom');
  const { collectionLoaderSource } = await import('../dist/templates/observability-loader.js');
  const window = new Window({ url: 'http://localhost:5218' });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = async (_url, options) => { sends.push(JSON.parse(options.body)); return new Response(null); };
  window.eval(collectionLoaderSource(true, false));
  const stacks = [
    '    at eval (eval at run (blob:http://localhost/private-module:4:5), <anonymous>:2:3)',
    '    at eval (eval at run (DaTa:text/javascript,private-module:4:5), <anonymous>:2:3)',
    '    at blob:private-module (/safe.js:2:3)',
  ];
  for (const stack of stacks) window.dispatchEvent(new window.ErrorEvent('error', { error: Object.assign(new Error('synthetic eval'), { stack }) }));
  assert.equal(sends.length, 3);
  for (const event of sends.slice(0, 2)) assert.equal(event.stack, '    at eval (sporades://embedded/module:2:3)\n');
  assert.equal(sends[2].stack, undefined);
  assert.doesNotMatch(JSON.stringify(sends), /private-module|data:|blob:/i);
});

for (const [format, stack, frames] of [
  ['Safari', 'fail@https://example.test:8443/a:b.js?secret=synthetic-private-marker:12:9\n@file:///C:/capsule/a:b.js:7:3', [
    { filename: 'file:///C:/capsule/a:b.js', function: '<anonymous>', lineno: 7, colno: 3 },
    { filename: 'https://example.test:8443/a:b.js', function: 'fail', lineno: 12, colno: 9 },
  ]],
  ['Firefox', 'fail@https://example.test:8443/a:b.js:12:9\nouter@http://example.test/c:d.js:7:3', [
    { filename: 'http://example.test/c:d.js', function: 'outer', lineno: 7, colno: 3 },
    { filename: 'https://example.test:8443/a:b.js', function: 'fail', lineno: 12, colno: 9 },
  ]],
]) test(`${format} frames without an Error header preserve colon filenames`, async t => {
  const { event } = await captured(t, { name: 'RangeError', message: 'synthetic', stack });
  assert.deepEqual(event.exception.values[0].stacktrace.frames, frames);
});

test('causes retain types and redacted stacks with cycle, depth and aggregate frame limits', async t => {
  const root = Object.assign(new TypeError('synthetic-private-marker root'), { stack: 'TypeError: root\n    at root (/safe/a.js:3:4)', code: 'SAFE_FAILURE' });
  const outer = new RangeError('outer', { cause: root });
  outer.stack = 'RangeError: outer\n    at outer (/safe/b.js:5:6)';
  root.cause = outer;
  const { event, envelope } = await captured(t, outer);
  assert.deepEqual(event.exception.values.map(value => value.type), ['TypeError', 'RangeError']);
  assert.deepEqual(event.exception.values.map(value => value.stacktrace.frames[0].lineno), [3, 5]);
  assert.doesNotMatch(envelope, /synthetic-private-marker/);
  let deep = new Error('leaf');
  for (let i = 0; i < 12; i++) deep = new Error('wrapper', { cause: deep });
  const second = await captured(t, deep);
  assert.equal(second.event.exception.values.length, 4);
  assert(second.event.exception.values.reduce((sum, value) => sum + value.stacktrace.frames.length, 0) <= 20);
});

test('privileged wrappers export audit-safe cause codes without raw cause diagnostics', async t => {
  const { createPrivilegedRunPublicError } = await import('../dist/acl-runtime.js');
  const cause = Object.assign(new Error('synthetic-private-marker private cause'), { code: 'SAFE_PROVIDER_REFUSAL', stack: 'Error: private\n    at private (https://private.test/private.js:4:5)' });
  const { event, envelope } = await captured(t, createPrivilegedRunPublicError(cause), { handler: 'protectedJob', args: 'synthetic-private-marker' });
  assert.equal(event.exception.values.length, 1);
  assert.equal(event.tags.error_code, 'PRIVILEGED_RUN_FAILED');
  assert.equal(event.tags.cause_code, 'SAFE_PROVIDER_REFUSAL');
  assert.equal(event.tags.handler, 'protectedJob');
  assert.doesNotMatch(envelope, /synthetic-private-marker|private cause|private\.test|args/);
});

for (const wrapper of ['run', 'audit']) for (const nested of [false, true]) {
  for (const kind of ['primitive', 'explicit code', 'safe code']) {
    test(`${wrapper} privileged ${kind} is redacted before normalization (nested=${nested})`, async t => {
      const { createPrivilegedRunPublicError, createPrivilegedAuditEmissionPublicError } = await import('../dist/acl-runtime.js');
      const secret = 'abcDef123-token';
      const cause = kind === 'primitive' ? secret : Object.assign(new Error('raw private cause'), {
        code: kind === 'explicit code' ? secret : 'safe.provider-refusal',
      });
      const wrapped = (wrapper === 'run' ? createPrivilegedRunPublicError : createPrivilegedAuditEmissionPublicError)(cause);
      const error = nested ? new Error('ordinary outer', { cause: wrapped }) : wrapped;
      const { event, envelope } = await captured(t, error, undefined, { SERVICE_SECRET: secret });
      const expected = kind === 'safe code' ? 'SAFE.PROVIDER-REFUSAL' : 'UNKNOWN_ERROR';
      assert.equal(event.exception.values[0].mechanism.data.cause_code, expected);
      assert.equal(event.tags.cause_code, nested ? wrapped.code : expected);
      assert.equal(event.exception.values.length, nested ? 2 : 1);
      assert.doesNotMatch(envelope, /abcdef123-token|raw private cause/i);
    });
  }
}

test('nested privileged wrappers stop before secret causes for both wrapper orders', async t => {
  const { createPrivilegedRunPublicError, createPrivilegedAuditEmissionPublicError } = await import('../dist/acl-runtime.js');
  for (const [outer, inner] of [[createPrivilegedRunPublicError, createPrivilegedAuditEmissionPublicError], [createPrivilegedAuditEmissionPublicError, createPrivilegedRunPublicError]]) {
    const wrapped = inner(Object.assign(new Error('raw private cause'), { code: 'abcDef123-token' }));
    const { event, envelope } = await captured(t, outer(wrapped), undefined, { SERVICE_SECRET: 'abcDef123-token' });
    assert.equal(event.exception.values.length, 1);
    assert.equal(event.tags.cause_code, wrapped.code);
    assert.equal(event.exception.values[0].mechanism.data.cause_code, wrapped.code);
    assert.doesNotMatch(envelope, /abcdef123-token|raw private cause/i);
  }
});

test('privileged cause codes reject nonstring and oversized candidates without coercion', async t => {
  const { createPrivilegedRunPublicError } = await import('../dist/acl-runtime.js');
  for (const code of [undefined, 42, { toString() { throw new Error('must not coerce'); } }, 'x'.repeat(65537)]) {
    const { event } = await captured(t, createPrivilegedRunPublicError({ code }));
    assert.equal(event.tags.cause_code, 'UNKNOWN_ERROR');
    assert.equal(event.exception.values[0].mechanism.data.cause_code, 'UNKNOWN_ERROR');
  }
});

test('mutations throwing mixed-case Server env secrets through Privileged export no secret variants', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { openDevDatabase, runMutation, resolveAnonymousSession } = await import('../dist/server-runtime-source.js');
  const { mutation } = await import('../dist/server.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'quality-privileged-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { DSN: 'http://synthetic@127.0.0.1:5218/1', SERVICE_SECRET: 'abcDef123-token' };
  const envelopes = receivedEnvelopes(t);
  const db = await openDevDatabase(path.join(root, 'data.db'), '', env, { name: 'quality-privileged-secret', observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, {
    mutations: {
      primitive: mutation(ctx => ctx.privileged.run({ operation: 'quality.primitive', targetResourceKind: 'quality-resource' }, () => { throw ctx.env.SERVICE_SECRET; })),
      code: mutation(ctx => ctx.privileged.run({ operation: 'quality.code', targetResourceKind: 'quality-resource' }, () => { throw Object.assign(new Error('raw private cause'), { code: ctx.env.SERVICE_SECRET }); })),
    },
  });
  t.after(() => db.close());
  await db.init();
  const { auth } = await resolveAnonymousSession(db);
  for (const name of ['primitive', 'code']) {
    const before = envelopes.length;
    const result = await runMutation(db, auth, name, []);
    await db.observability.flush();
    assert.equal(result.error.code, 'PRIVILEGED_RUN_FAILED');
    assert.equal(envelopes.length, before + 1);
    const envelope = envelopes.at(-1), event = JSON.parse(envelope.trim().split('\n')[2]);
    assert.equal(event.exception.values.length, 1);
    assert.equal(event.tags.cause_code, 'UNKNOWN_ERROR');
    assert.equal(event.exception.values[0].mechanism.data.cause_code, 'UNKNOWN_ERROR');
    assert.doesNotMatch(JSON.stringify({ result, envelope }), /abcdef123-token|raw private cause/i);
  }
});

for (const thrown of ['plain rejection', 42, null, { arbitrary: 'synthetic-private-marker' }]) {
  test(`non-Error thrown value ${typeof thrown} stays bounded without arbitrary properties`, async t => {
    const { event, envelope } = await captured(t, thrown);
    assert.equal(event.exception.values[0].stacktrace.frames.length, 0);
    assert.equal(event.exception.values[0].mechanism.data.stack_source, 'absent');
    assert.doesNotMatch(envelope, /synthetic-private-marker/);
  });
}

test('hostile, malformed and oversized stacks have bounded output and no inline source', async t => {
  for (const stack of [null, {}, 'at nonsense', 'at data:text/javascript,' + 'x'.repeat(1024 * 1024 - 'at data:text/javascript,'.length - ':7:9'.length) + ':7:9' + 'trailing', 'at ' + ':'.repeat(1_100_000), 'at data:text/javascript,' + 'x'.repeat(1_100_000) + ':1:1']) {
    const { event, envelope } = await captured(t, { message: 'hostile stack', stack });
    assert.equal(event.exception.values[0].stacktrace.frames.length, 0);
    assert(envelope.length < 4096);
    assert.doesNotMatch(envelope, /data:text/);
  }
});

test('browser mirrors consume no error budget; genuine errors, causes and ErrorEvent coordinates survive', async t => {
  const { Window } = await import('happy-dom');
  const { collectionLoaderSource } = await import('../dist/templates/observability-loader.js');
  const window = new Window({ url: 'http://localhost:5218' });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = async (_url, options) => { sends.push(JSON.parse(options.body)); return new Response(null); };
  window.eval(collectionLoaderSource(true, false));
  for (let i = 0; i < 25; i++) window.dispatchEvent(new window.CustomEvent('sporades:error', { detail: { message: 'server mirror', sporadesSource: 'server' } }));
  assert.equal(sends.length, 0);
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'location only', filename: 'https://user:pass@example.test/a:b.js?secret=hidden#hidden', lineno: 13, colno: 7 }));
  const rejection = new window.Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: Object.assign(new TypeError('browser error', { cause: new RangeError('browser cause') }), { eventId: 'a'.repeat(32) }) });
  window.dispatchEvent(rejection);
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'Script error.' }));
  assert.equal(sends.length, 3);
  assert.doesNotMatch(JSON.stringify(sends), /user:pass|hidden/);
  const { collector } = await captured(t, new Error('setup'));
  const envelopes = receivedEnvelopes(t); envelopes.length = 0;
  for (const input of sends) { await collector.collect({ ...input, surface: 'job', handler: 'forged', code: 'FORGED', event_id: 'forged', release: 'forged' }, 'http://localhost:5218', { headers: {} }, {}); await collector.flush(); }
  const collected = envelopes.map(body => JSON.parse(body.trim().split('\n')[2]));
  assert.deepEqual(collected[0].exception.values[0].stacktrace.frames, [{ filename: 'https://example.test/a:b.js', function: '<anonymous>', lineno: 13, colno: 7 }]);
  assert.equal(collected[0].exception.values[0].mechanism.data.stack_source, 'error_event');
  assert.deepEqual(collected[1].exception.values.map(value => value.type), ['RangeError', 'TypeError']);
  assert.equal(collected[2].exception.values[0].stacktrace.frames.length, 0);
  assert.equal(collected[2].exception.values[0].mechanism.data.stack_source, 'absent');
  for (const event of collected) {
    assert.equal(event.tags.surface, 'client');
    assert.equal(event.tags.handler, undefined);
    assert.equal(event.tags.error_code, undefined);
    assert.equal(event.release, 'quality-release');
    assert.notEqual(event.event_id, 'forged');
  }
});

test('actual privileged Job failures keep retry semantics and export only the safe cause code', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { openDevDatabase, runMutation, resolveAnonymousSession } = await import('../dist/server-runtime-source.js');
  const { mutation, job } = await import('../dist/server.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'quality-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { events.push(JSON.parse(options.body.trim().split('\n')[2])); return new Response(null); });
  let attempts = 0;
  const db = await openDevDatabase(path.join(root, 'data.db'), '', { DSN: 'http://synthetic@127.0.0.1:5218/1' }, { name: 'quality-job', observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, {
    jobs: { protectedJob: job(ctx => ctx.privileged.run({ operation: 'quality.fail', targetResourceKind: 'job-queue' }, () => {
      attempts++;
      throw Object.assign(new TypeError('raw privileged cause must stay private'), { code: 'SAFE_JOB_REFUSAL' });
    })) },
    mutations: {
      enqueue: mutation(ctx => ctx.jobs.enqueue('protectedJob', {}, { retry: { maxAttempts: 2, delayMs: 1 } })),
      state: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  });
  t.after(() => db.close());
  await db.init();
  const { auth } = await resolveAnonymousSession(db);
  const queued = await runMutation(db, auth, 'enqueue', []);
  assert.equal(queued.ok, true);
  let state;
  for (let i = 0; i < 200; i++) {
    state = (await runMutation(db, auth, 'state', [queued.data.id])).data;
    if (state.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.status, 'failed');
  assert.equal(attempts, 2);
  await db.observability.flush();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.tags.surface, 'job');
    assert.equal(event.tags.handler, 'protectedJob');
    assert.equal(event.tags.error_code, 'PRIVILEGED_RUN_FAILED');
    assert.equal(event.tags.cause_code, 'SAFE_JOB_REFUSAL');
    assert.equal(event.tags.correlation_id, event.event_id);
    assert.equal(event.exception.values.length, 1);
  }
  assert.doesNotMatch(JSON.stringify({ events, state }), /raw privileged cause/);
});

test('nested privileged wrapper remains an opaque boundary in an ordinary cause chain', async t => {
  const { createPrivilegedRunPublicError } = await import('../dist/acl-runtime.js');
  const secret = Object.assign(new Error('synthetic-private-marker nested cause'), { code: 'SAFE_NESTED_FAILURE' });
  const { event, envelope } = await captured(t, new Error('ordinary outer', { cause: createPrivilegedRunPublicError(secret) }));
  assert.deepEqual(event.exception.values.map(value => value.value), ['Privileged run failed.', 'ordinary outer']);
  assert.equal(event.exception.values[0].mechanism.data.cause_code, 'SAFE_NESTED_FAILURE');
  assert.doesNotMatch(envelope, /synthetic-private-marker|nested cause/);
});

for (const location of [{ filename: 'https://example.test/line.js?private', lineno: 9, colno: 0 }, { filename: 'https://example.test/file.js#private', lineno: 0, colno: 0 }]) {
  test('ErrorEvent preserves partial source coordinates without inventing missing fields', async t => {
    const { collector } = await captured(t, new Error('setup'));
    const envelopes = receivedEnvelopes(t); envelopes.length = 0;
    await collector.collect({ type: 'error', message: 'partial location', location }, 'http://localhost:5218', { headers: {} }, {});
    await collector.flush();
    const events = envelopes.map(body => JSON.parse(body.trim().split('\n')[2]));
    assert.deepEqual(events[0].exception.values[0].stacktrace.frames, [{ filename: location.filename.split(/[?#]/)[0], function: '<anonymous>', ...(location.lineno ? { lineno: 9 } : {}) }]);
    assert.equal(events[0].exception.values[0].mechanism.data.stack_source, 'error_event');
  });
}

test('caught query, mutation and app-message originals correlate safe DTOs with one server event', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { openDevDatabase, runQuery, runMutation, runAppMessage, resolveAnonymousSession } = await import('../dist/server-runtime-source.js');
  const { query, mutation, message } = await import('../dist/server.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'quality-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { events.push(JSON.parse(options.body.trim().split('\n')[2])); return new Response(null); });
  const fail = () => { throw Object.assign(new TypeError('safe failure'), { code: 'SAFE_FAILURE', arbitrary: 'private property' }); };
  const db = await openDevDatabase(path.join(root, 'data.db'), '', { DSN: 'http://synthetic@127.0.0.1:5218/1' }, { name: 'quality-context', observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, {
    queries: { queryFail: query(fail) }, mutations: { mutationFail: mutation(fail) }, messages: { messageFail: message(fail) },
  });
  t.after(() => db.close());
  await db.init();
  const { auth } = await resolveAnonymousSession(db);
  const results = [await runQuery(db, auth, 'queryFail'), await runMutation(db, auth, 'mutationFail', []), await runAppMessage(db, auth, 'messageFail', {})];
  await db.observability.flush();
  assert.equal(events.length, 3);
  for (const [index, result] of results.entries()) {
    assert.equal(result.error.eventId, events[index].event_id);
    assert.equal(events[index].tags.correlation_id, result.error.eventId);
    assert.equal(events[index].tags.handler, ['queryFail', 'mutationFail', 'messageFail'][index]);
    assert.equal(events[index].exception.values[0].type, 'TypeError');
    assert(events[index].exception.values[0].stacktrace.frames.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(results), /stack|private property|at fail|base64/);
  const { Window } = await import('happy-dom');
  const { collectionLoaderSource } = await import('../dist/templates/observability-loader.js');
  const window = new Window({ url: 'http://localhost:5218' });
  t.after(() => window.happyDOM.abort());
  const browserReports = [];
  window.fetch = async (_url, options) => { browserReports.push(JSON.parse(options.body)); return new Response(null); };
  window.eval(collectionLoaderSource(true, false));
  for (const result of results) {
    window.dispatchEvent(new window.CustomEvent('sporades:error', { detail: result.error }));
    const rejection = new window.Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: result.error });
    window.dispatchEvent(rejection);
  }
  assert.equal(browserReports.length, 0, 'one captured server failure must not create a browser mirror exception');
  window.dispatchEvent(new window.ErrorEvent('error', { error: new TypeError('independent failure') }));
  assert.equal(browserReports.length, 1);
});


test('generated Capsule handler preserves exact embedded-module coordinates and safe context', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { startCollectionCapsule, assertCollectionBusinessSemantics } = await import('./support/collection-capsule.mjs');
  const events = [];
  const receiver = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    events.push(JSON.parse(body.trim().split('\n')[2])); response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => new Promise(resolve => { receiver.closeAllConnections(); receiver.close(resolve); }));
  const config = { name: 'quality-generated', release: { id: 'quality-release' }, observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } };
  const { origin, expectedFailureFrame } = await startCollectionCapsule(t, { config, serverEnv: { DSN: `http://synthetic@127.0.0.1:${receiver.address().port}/1` }, failureMarker: 'quality-generated-handler' });
  await assertCollectionBusinessSemantics(origin);
  for (let i = 0; i < 200 && events.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.exception.values[0].type, 'Error');
  assert.equal(event.exception.values[0].value, 'quality-generated-handler');
  assert.deepEqual(event.exception.values[0].stacktrace.frames.at(-1), { ...expectedFailureFrame, function: '<anonymous>' });
  assert.equal(event.tags.handler, 'fail');
  assert.equal(event.tags.surface, 'endpoint');
  assert.equal(event.tags.capsule, config.name);
  assert.equal(event.release, config.release.id);
  assert.equal(event.tags.correlation_id, event.event_id);
  assert.doesNotMatch(JSON.stringify(event), /data:text|base64|sourcesContent|rolled-back/);
});
