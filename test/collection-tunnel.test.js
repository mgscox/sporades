import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRuntimeObservability, routeCollection } from '../dist/observability-runtime.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, provider = 'umami') {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push({ path: request.url, headers: request.headers, body });
    response.writeHead(200).end('provider-private-response');
  });
  const config = { name: 'collection-test', analytics: { provider, endpointEnv: 'ANALYTICS_URL', websiteIdEnv: 'WEBSITE_ID' } };
  const database = { config, securitySession: 'hosted', runtimeProbeToken: 'a'.repeat(64), observability: createRuntimeObservability(config, { ANALYTICS_URL: receiver + '/ingest', WEBSITE_ID: 'example.test' }) };
  const origin = await listen(t, (request, response) => routeCollection(database, request, response).then(handled => { if (!handled) response.writeHead(404).end(); }));
  return { database, origin, received };
}

test('same-origin analytics translates provider protocols and strips capability query and fragment', async t => {
  for (const provider of ['umami', 'plausible']) await t.test(provider, async t => {
    const { origin, received } = await fixture(t, provider);
    const response = await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'user-agent': 'test-browser', 'x-forwarded-for': '198.51.100.99', 'x-sporades-client-address': '203.0.113.8', 'x-sporades-client-address-token': clientAddressBoundaryToken('a'.repeat(64)) }, body: JSON.stringify({ type: 'pageview', url: origin + '/inbox?request=capability-secret#fragment-secret', referrer: origin + '/?token=ref-secret#ref-fragment', website: 'attacker', endpoint: 'http://attacker.invalid' }) });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-forwarded-for'], '203.0.113.8');
    assert.equal(received[0].headers['user-agent'], 'test-browser');
    const event = JSON.parse(received[0].body);
    if (provider === 'umami') {
      assert.equal(event.type, 'event'); assert.equal(event.payload.website, 'example.test');
      assert.equal(event.payload.url, '/inbox'); assert.equal(event.payload.referrer, origin + '/');
    } else { assert.equal(event.name, 'pageview'); assert.equal(event.domain, 'example.test'); assert.equal(event.url, origin + '/inbox'); }
    assert.doesNotMatch(received[0].body, /secret|attacker|request=|#/);
  });
});

test('Sentry envelopes contain redacted errors, stack frames and Capsule/release tags without leaking credentials', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push({ path: request.url, body }); response.writeHead(200).end();
  });
  const config = { name: 'errors-test', release: { id: 'release-234' }, observability: { errors: { protocol: 'sentry', dsnEnv: 'ERROR_DSN', environment: 'staging', client: true } } };
  const observability = createRuntimeObservability(config, { ERROR_DSN: receiver.replace('http://', 'http://public-key@') + '/prefix/42', API_SECRET: 'sealed-secret' });
  const error = new Error('failed with sealed-secret https://example.test/inbox?request="capability-secret"#fragment-secret');
  error.stack = 'Error: ' + error.message + '\n    at execute (https://example.test/client.js?request=stack-secret#fragment:12:8)';
  observability.capture(error, 'mutation');
  await observability.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/prefix/api/42/envelope/');
  const [header, item, event] = received[0].body.trim().split('\n').map(JSON.parse);
  assert.equal(item.type, 'event'); assert.equal(item.length, Buffer.byteLength(JSON.stringify(event)));
  assert.equal(header.event_id, event.event_id);
  assert.equal(event.environment, 'staging'); assert.equal(event.release, 'release-234');
  assert.equal(event.tags.capsule, 'errors-test'); assert.equal(event.tags.surface, 'mutation');
  assert(event.exception.values[0].stacktrace.frames.length > 0);
  assert.doesNotMatch(JSON.stringify(event), /sealed-secret|capability-secret|fragment-secret|stack-secret|public-key|ERROR_DSN/);
});

const credentialDiagnostics = [
  ['JSON token array', JSON.stringify({ token: ['first-array-marker', 'second-array-marker'] }), /first-array-marker|second-array-marker/],
  ['JSON Set-Cookie array', JSON.stringify({ 'set-cookie': ['a=first-cookie-marker; Path=/', 'b=second-cookie-marker; HttpOnly'] }), /first-cookie-marker|second-cookie-marker/],
  ['nested credential object', JSON.stringify({ token: { first: ['first-object-marker', { value: 'second-object-marker' }], last: 'third-object-marker' }, status: 'continue' }), /first-object-marker|second-object-marker|third-object-marker/],
  ['escaped structured credential', JSON.stringify({ token: ['first-escaped-marker\\"],}', 'second-escaped-marker'] }), /first-escaped-marker|second-escaped-marker/],
  ['unterminated credential array', '{"token":["first-truncated-marker",\n"second-truncated-marker"', /first-truncated-marker|second-truncated-marker/],
  ['JSON token', '{"token":"json-credential-marker","access_token":"json-access-marker"}', /json-credential-marker|json-access-marker/],
  ['nested JSON token', 'Failure: {"details":{"token":"nested-credential-marker"}}', /nested-credential-marker/],
  ['single quoted password', "password='first-single-marker second-single-marker'", /first-single-marker|second-single-marker/],
  ['unterminated password', 'password="truncated-credential-marker remaining-truncated-marker', /truncated-credential-marker|remaining-truncated-marker/],
  ['Basic authorization', 'Authorization: Basic dXNlcjpwYXNz', /dXNlcjpwYXNz/],
  ['quoted password', 'password="first-password-marker second-password-marker"', /first-password-marker|second-password-marker/],
  ['escaped JSON password', JSON.stringify({ password: 'escaped-credential-marker "remaining-password-marker"' }), /escaped-credential-marker|remaining-password-marker/],
  ['cookie header', 'Cookie: first=cookie-one-marker; second=cookie-two-marker', /cookie-one-marker|cookie-two-marker/],
];

test('diagnostic credentials are redacted at the receiver for server and browser tunnel errors', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push(JSON.parse(body.trim().split('\n')[2])); response.end();
  });
  const config = { observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } };
  const observability = createRuntimeObservability(config, { DSN: receiver.replace('http://', 'http://key@') + '/1' });
  t.after(() => observability.close());
  const database = { observability };
  const origin = await listen(t, (request, response) => routeCollection(database, request, response));
  for (const [name, message, leaked] of credentialDiagnostics) {
    await t.test(name, async () => {
      const before = received.length;
      observability.capture(new Error(message), 'mutation');
      await observability.flush();
      assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', message }) })).status, 204);
      await observability.flush();
      assert.equal(received.length, before + 2);
      for (const event of received.slice(before)) {
        assert.match(event.exception.values[0].value, /REDACTED/);
        assert.doesNotMatch(JSON.stringify(event), leaked);
        if (name === 'nested credential object') assert.match(event.exception.values[0].value, /"status":"continue"/);
      }
    });
  }
});

const privateDiagnosticUrls = ['//example.test/inbox', './client.js', '../client.js', '/client.js'];
const privateUrl = base => `${base}?cap=qa-query-marker#qa-fragment-marker`;
const urlMessage = base => `Ready? Investigate #234 (${privateUrl(base)}). Continue.`;
const safeUrlMessage = base => `Ready? Investigate #234 (${base}). Continue.`;

test('relative diagnostic URLs lose private suffixes in receiver messages and stack filenames', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push(JSON.parse(body.trim().split('\n')[2])); response.end();
  });
  const observability = createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' });
  t.after(() => observability.close());
  const origin = await listen(t, (request, response) => routeCollection({ observability }, request, response));
  for (const base of privateDiagnosticUrls) await t.test(base, async () => {
    const before = received.length;
    const message = urlMessage(base);
    const stack = `Error: ${message}\n    at execute (${privateUrl(base)}:12:8)`;
    observability.capture({ message, stack }, 'mutation');
    await observability.flush();
    assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', message, stack }) })).status, 204);
    await observability.flush();
    assert.equal(received.length, before + 2);
    for (const event of received.slice(before)) {
      assert.doesNotMatch(JSON.stringify(event), /qa-query-marker|qa-fragment-marker/);
      assert.equal(event.exception.values[0].value, safeUrlMessage(base));
      assert.deepEqual(event.exception.values[0].stacktrace.frames, [{ filename: base, function: 'execute', lineno: 12, colno: 8 }]);
    }
  });
});

const diagnosticUrlDelimiters = [
  ['assignment', 'url=', ''], ['square brackets', '[', ']'], ['angle brackets', '<', '>'],
  ['colon', 'url:', ''], ['braces', '{', '}'], ['comma', ',', ''],
  ['semicolon', ';', ''], ['pipe', '|', ''], ['backticks', '`', '`'],
  ['period', 'url.', ''], ['dash', 'url-', ''], ['underscore', 'url_', ''],
];
const delimitedUrls = (before, after, privateValues = true) => privateDiagnosticUrls
  .map(base => before + (privateValues ? privateUrl(base) : base) + after);

test('relative diagnostic URL delimiters preserve prose and conceal suffixes at both receivers', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push(JSON.parse(body.trim().split('\n')[2])); response.end();
  });
  for (const [name, before, after] of diagnosticUrlDelimiters) {
    const observability = createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' });
    t.after(() => observability.close());
    const origin = await listen(t, (request, response) => routeCollection({ observability }, request, response));
    for (const base of privateDiagnosticUrls) await t.test(`${name}: ${base}`, async () => {
      const start = received.length;
      const message = `Ready? Investigate #234 ${before}${privateUrl(base)}${after} Continue.`;
      const stack = `Error: ${message}\n    at execute (${before}${privateUrl(base)}${after}:12:8)`;
      observability.capture({ message, stack }, 'mutation');
      await observability.flush();
      assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', message, stack }) })).status, 204);
      await observability.flush();
      assert.equal(received.length, start + 2);
      for (const event of received.slice(start)) {
        assert.doesNotMatch(JSON.stringify(event), /qa-query-marker|qa-fragment-marker/);
        assert.equal(event.exception.values[0].value, `Ready? Investigate #234 ${before}${base}${after} Continue.`);
        assert.deepEqual(event.exception.values[0].stacktrace.frames, [{ filename: before + base + after, function: 'execute', lineno: 12, colno: 8 }]);
      }
    });
  }
});

const apostropheDiagnosticUrls = ['https://example.test/inbox', ...privateDiagnosticUrls];
const apostropheDiagnostics = [
  ['bare assignment', 'url=', '', "O'Reilly"],
  ['single quoted', "'", "'", "O'Reilly"],
  ['double quoted', '"', '"', "O'Reilly"],
  ['bracketed', '[', ']', "O'Reilly's"],
  ['single quoted query value', 'url=', '', "'O'Reilly phrase'"],
  ['double quoted query value', 'url=', '', '"O\'Reilly phrase"'],
  ['quoted punctuation', "'", "',", "O'Reilly"],
  ['JSON field', '{"url":"', '","status":"ready"}', "O'Reilly"],
].map(([name, before, after, value]) => {
  const urls = apostropheDiagnosticUrls.map(base => before + base + `?filter=${value}&cap=qa-apostrophe-query-marker#qa-apostrophe-fragment-marker` + after);
  const clean = apostropheDiagnosticUrls.map(base => before + base + after);
  return { name,
    message: `Ready? Investigate #234 ${urls.join(' ')} Continue.`,
    safe: `Ready? Investigate #234 ${clean.join(' ')} Continue.`,
    stack: 'Error: diagnostic URL\n' + urls.map(url => `    at execute (${url}:12:8)`).join('\n'),
    frames: clean.reverse().map(filename => ({ filename, function: 'execute', lineno: 12, colno: 8 })),
  };
});

const escapedQueryDiagnostics = apostropheDiagnosticUrls.map(base => {
  const url = base + '?filter="O\'Reilly phrase"&cap=qa-apostrophe-query-marker#qa-apostrophe-fragment-marker';
  const diagnostic = JSON.stringify({ url, status: 'ready' });
  const clean = JSON.stringify({ url: base, status: 'ready' });
  return {
    name: `JSON-escaped query quotation: ${base}`,
    message: `Ready? Investigate #234 ${diagnostic} Continue.`,
    safe: `Ready? Investigate #234 ${clean} Continue.`,
    stack: `Error: diagnostic URL\n    at execute (${diagnostic}:12:8)`,
    frames: [{ filename: clean, function: 'execute', lineno: 12, colno: 8 }],
  };
});

test('apostrophes cannot expose URL suffixes at server and tunnel receivers', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push(JSON.parse(body.trim().split('\n')[2])); response.end();
  });
  const observability = createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' });
  t.after(() => observability.close());
  const origin = await listen(t, (request, response) => routeCollection({ observability }, request, response));
  for (const probe of [...apostropheDiagnostics, ...escapedQueryDiagnostics]) await t.test(probe.name, async () => {
    const start = received.length;
    observability.capture(Object.assign(new Error(probe.message), { stack: probe.stack }), 'mutation');
    await observability.flush();
    assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', message: probe.message, stack: probe.stack }) })).status, 204);
    await observability.flush();
    assert.equal(received.length, start + 2);
    for (const event of received.slice(start)) {
      assert.doesNotMatch(JSON.stringify(event), /qa-apostrophe-query-marker|qa-apostrophe-fragment-marker|Reilly/);
      assert.equal(event.exception.values[0].value, probe.safe);
      assert.deepEqual(event.exception.values[0].stacktrace.frames, probe.frames);
    }
  });
});

test('runtime captures query, mutation, endpoint and Job failures without changing rollback or retries', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { openDevDatabase, runQuery, runMutation, runEndpoint, resolveAnonymousSession } = await import('../dist/server-runtime-source.js');
  const { query, mutation, job, table, String: StringField } = await import('../dist/server.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const receiver = await listen(t, async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; events.push(JSON.parse(body.trim().split('\n')[2])); response.writeHead(200).end(); });
  const config = { name: 'runtime-errors', observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } };
  const fail = () => { throw new Error('test-failure?request=never-export#private'); };
  let attempts = 0;
  const db = await openDevDatabase(path.join(root, 'data.db'), '', { DSN: receiver.replace('http://', 'http://key@') + '/1' }, config, {
    schema: { notes: table({ text: StringField() }) }, queries: { fail: query(fail) },
    mutations: { fail: mutation(async ctx => { await ctx.db.notes.insert({ text: 'rolled-back' }); fail(); }), enqueue: mutation(ctx => ctx.jobs.enqueue('fail', {}, { retry: { maxAttempts: 2, delayMs: 1 } })), state: mutation((ctx, id) => ctx.jobs.get(id)) },
    jobs: { fail: job(() => { attempts++; fail(); }) },
  });
  t.after(() => db.close());
  await db.init();
  const { auth } = await resolveAnonymousSession(db);
  assert((await runQuery(db, auth, 'fail')).error);
  assert.equal((await runMutation(db, auth, 'fail', [])).ok, false);
  assert.equal((await runQuery(db, auth, 'notes')).rows.length, 0);
  await assert.rejects(() => runEndpoint(db, { handler: fail }, new URL('http://localhost/fail'), { method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {} }), /test-failure/);
  const queued = await runMutation(db, auth, 'enqueue', []);
  assert.equal(queued.ok, true);
  let state;
  for (let i = 0; i < 100; i++) { state = (await runMutation(db, auth, 'state', [queued.data.id])).data; if (state?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(state.status, 'failed'); assert.equal(attempts, 2);
  await db.observability.flush();
  assert.deepEqual(events.map(event => event.tags.surface).sort(), ['endpoint', 'job', 'job', 'mutation', 'query']);
  assert.doesNotMatch(JSON.stringify(events), /never-export|private/);
});

test('first-party loader captures navigation, errors, rejection and Sporades errors using only same-origin collection', async t => {
  const { Window } = await import('happy-dom');
  const { origin, received } = await fixture(t);
  const response = await fetch(origin + '/__sporades/observe.js');
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.doesNotMatch(script, /example.test|ANALYTICS_URL|ingest/);
  const window = new Window({ url: origin + '/?request=browser-secret#private' });
  t.after(() => window.happyDOM.abort());
  const sent = [];
  window.fetch = async (url, options) => { sent.push({ target: url, ...JSON.parse(options.body) }); return { ok: true }; };
  window.eval(script);
  window.history.pushState({}, '', '/inbox?token=second-secret#route');
  window.history.replaceState({}, '', '/replaced?request=third-secret#next');
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  assert.equal(sent.filter(event => event.type === 'pageview').length, 3);
  assert(sent.every(event => event.target === '/__sporades/collect'));
  assert.doesNotMatch(JSON.stringify(sent), /browser-secret|second-secret|third-secret|#private/);
  assert.equal(received.length, 0);
});

test('disabled, missing env, sampled-out, denied and closed integrations make no outbound request', async t => {
  const received = [];
  const receiver = await listen(t, async (request, response) => { received.push(request.url); response.end(); });
  const providerFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected outbound collection'); });
  for (const [config, env, error] of [
    [{}, {}, new Error('disabled')],
    [{ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, {}, new Error('missing')],
    [{ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', sampleRate: 0 } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' }, new Error('sampled')],
    ...['DENIED', 'UNAUTHENTICATED', 'FORBIDDEN', 'REAUTHENTICATION_REQUIRED', 'JOB_CANCELLED', 'RESOURCE_CANCELLED'].map(code => [
      { observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' }, Object.assign(new Error('denied'), { code }),
    ]),
  ]) {
    const observability = createRuntimeObservability(config, env);
    observability.capture(error, 'query'); await observability.flush();
    assert.equal(observability.enabled, false);
  }
  const observability = createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } } }, { DSN: receiver.replace('http://', 'http://key@') + '/1' });
  observability.close(); observability.capture(new Error('closed'), 'query'); await observability.flush();
  assert.equal(providerFetch.mock.callCount(), 0, 'dormant or revoked collection cannot call fetch for any destination');
  providerFetch.mock.restore();
  const database = { observability: createRuntimeObservability() };
  const origin = await listen(t, (request, response) => routeCollection(database, request, response).then(handled => { if (!handled) response.writeHead(404).end(); }));
  assert.equal((await fetch(origin + '/__sporades/observe.js')).status, 404);
  assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST' })).status, 404);
  assert.deepEqual(received, []);
});

test('tunnel rejects cross-origin, malformed and unsupported events; spoofed forwarding headers confer no address', async t => {
  const { origin, received } = await fixture(t);
  for (const [headers, body] of [
    [{ origin: 'https://attacker.test' }, { type: 'pageview', url: origin }],
    [{}, { type: 'pageview', url: origin }],
    [{ origin }, { type: 'error', message: 'disabled' }],
    [{ origin }, { type: 'pageview', url: 'https://attacker.test/?request=secret' }],
    [{ origin }, null], [{ origin }, { type: 'pageview', url: 1 }],
    [{ origin }, '{invalid'], [{ origin }, { type: 'event', data: 'arbitrary' }],
  ]) {
    const response = await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert([400, 403].includes(response.status)); assert.equal(await response.text(), '');
  }
  assert.equal(received.length, 0);
  assert.equal((await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.99', 'x-sporades-client-address': '203.0.113.8', 'x-sporades-client-address-token': 'b'.repeat(64) }, body: JSON.stringify({ type: 'pageview', url: origin }) })).status, 204);
  assert.equal(received[0].headers['x-forwarded-for'], undefined);
});

async function generatedCollectionFixture(t) {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { createServerBundleModuleSource } = await import('../dist/templates/server-bundle-module-graph.js');
  const { bundleServerCapsuleModule } = await import('../dist/bundle-pipeline.js');
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'collect-bundle-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 4000); try { await ended; } finally { clearTimeout(timer); } }
    await rm(root, { recursive: true, force: true });
  });
  const received = [];
  const receiver = await listen(t, async (request, response) => { let body = ''; for await (const part of request) body += part; received.push({ headers: request.headers, body }); response.writeHead(200).end(); });
  const config = { name: 'bundle-collection', observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', client: true } }, analytics: { provider: 'umami', endpointEnv: 'ANALYTICS', websiteIdEnv: 'WEBSITE' }, security: { csp: { mode: 'enforce', directives: { 'script-src': ["'self'"], 'connect-src': ["'self'"] } } } };
  const serverSource = 'import { capsule } from "sporades/server"; export default capsule({ name: "bundle-collection", schema: {} });';
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server', 'index.ts') });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><html><head></head><body>Collection fixture</body></html>');
  await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv: { DSN: receiver.replace('http://', 'http://key@') + '/1', ANALYTICS: receiver + '/analytics', WEBSITE: 'website-234', SECRET: 'server-only-secret' }, serverSource, serverModuleSource, epilogue: 'process.stdout.write(JSON.stringify({ listening: server.address().port }) + "\\n");' }));
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(root, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', origin;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  for (let i = 0; i < 200; i++) { assert.equal(child.exitCode, null, errors); const signal = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => Number.isInteger(event?.listening)); if (signal) { origin = `http://127.0.0.1:${signal.listening}`; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert(origin, errors);
  const document = await fetch(origin + '/', { headers: { 'sec-fetch-dest': 'document' } });
  assert.match(await document.text(), /src="\/__sporades\/observe.js"/);
  assert.match(document.headers.get('content-security-policy'), /script-src 'self'(?:;|$)/);
  const script = await (await fetch(origin + '/__sporades/observe.js')).text();
  assert.doesNotMatch(script, /server-only-secret|website-234|DSN|127\.0\.0\.1/);
  return { origin, received, script };
}

test('generated Capsule serves the loader under self CSP and collects client errors with server-side redaction', async t => {
  const { Window } = await import('happy-dom');
  const { origin, received, script } = await generatedCollectionFixture(t);
  const window = new Window({ url: origin + '/?request=client-secret#client-fragment' });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = (url, options) => { const promise = fetch(new URL(url, origin), { ...options, headers: { ...options.headers, origin } }); sends.push(promise); return promise; };
  window.eval(script);
  for (let i = 0; i < 20; i++) {
    for (const code of ['DENIED', 'UNAUTHENTICATED', 'FORBIDDEN', 'REAUTHENTICATION_REQUIRED', 'JOB_CANCELLED', 'RESOURCE_CANCELLED']) {
      window.dispatchEvent(new window.CustomEvent('sporades:error', { detail: { code, message: 'expected denial' } }));
    }
  }
  for (const [, message] of credentialDiagnostics) {
    window.dispatchEvent(new window.ErrorEvent('error', { error: new Error(message) }));
    await Promise.all(sends);
  }
  for (const base of privateDiagnosticUrls) {
    const error = new Error(urlMessage(base));
    error.stack = `Error: ${error.message}\n    at execute (${privateUrl(base)}:12:8)`;
    window.dispatchEvent(new window.ErrorEvent('error', { error }));
    await Promise.all(sends);
  }
  window.dispatchEvent(new window.ErrorEvent('error', { error: new Error('browser failure?request=token-error#fragment') }));
  const rejection = new window.Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: new Error('unhandled server-only-secret') });
  window.dispatchEvent(rejection);
  window.dispatchEvent(new window.CustomEvent('sporades:error', { detail: { message: 'transport failed?token=token-transport#fragment' } }));
  window.location.hash = '#second-route?request=route-token';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await Promise.all(sends);
  const expectedErrors = 3 + credentialDiagnostics.length + privateDiagnosticUrls.length;
  for (let i = 0; i < 100 && received.length < expectedErrors + 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope').length, expectedErrors);
  for (const [, , leaked] of credentialDiagnostics) assert.doesNotMatch(received.map(event => event.body).join('\n'), leaked);
  const urlEvents = received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope')
    .map(event => JSON.parse(event.body.trim().split('\n')[2])).filter(event => event.exception.values[0].value.startsWith('Ready?'));
  assert.equal(urlEvents.length, privateDiagnosticUrls.length);
  for (const [index, event] of urlEvents.entries()) {
    assert.equal(event.exception.values[0].value, safeUrlMessage(privateDiagnosticUrls[index]));
    assert.deepEqual(event.exception.values[0].stacktrace.frames, [{ filename: privateDiagnosticUrls[index], function: 'execute', lineno: 12, colno: 8 }]);
  }
  assert.doesNotMatch(received.map(event => event.body).join('\n'), /qa-query-marker|qa-fragment-marker/);
  assert.equal(received.filter(event => event.headers['content-type'] === 'application/json').length, 2);
  assert.doesNotMatch(received.map(event => event.body).join('\n'), /server-only-secret|client-secret|client-fragment|token-error|token-transport|route-token|second-route/);
});

test('generated loader redacts diagnostic URL delimiters across all relative forms', async t => {
  const { Window } = await import('happy-dom');
  const { origin, received, script } = await generatedCollectionFixture(t);
  const window = new Window({ url: origin });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = (url, options) => { const promise = fetch(new URL(url, origin), { ...options, headers: { ...options.headers, origin } }); sends.push(promise); return promise; };
  window.eval(script);
  for (const [name, before, after] of diagnosticUrlDelimiters) await t.test(name, async () => {
    const message = `Ready? Investigate #234 ${delimitedUrls(before, after).join(' ')} Continue.`;
    const error = new Error(message);
    error.stack = `Error: ${message}\n` + delimitedUrls(before, after).map(url => `    at execute (${url}:12:8)`).join('\n');
    window.dispatchEvent(new window.ErrorEvent('error', { error }));
    await Promise.all(sends);
    const count = diagnosticUrlDelimiters.findIndex(entry => entry[0] === name) + 1;
    for (let i = 0; i < 100 && received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope').length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const errors = received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope');
    assert.equal(errors.length, count);
    const event = JSON.parse(errors.at(-1).body.trim().split('\n')[2]);
    assert.doesNotMatch(JSON.stringify(event), /qa-query-marker|qa-fragment-marker/);
    assert.equal(event.exception.values[0].value, `Ready? Investigate #234 ${delimitedUrls(before, after, false).join(' ')} Continue.`);
    assert.deepEqual(event.exception.values[0].stacktrace.frames, delimitedUrls(before, after, false).reverse().map(filename => ({ filename, function: 'execute', lineno: 12, colno: 8 })));
  });
});

test('generated loader conceals apostrophes inside URL queries and stack filenames', async t => {
  const { Window } = await import('happy-dom');
  const { origin, received, script } = await generatedCollectionFixture(t);
  const window = new Window({ url: origin });
  t.after(() => window.happyDOM.abort());
  const sends = [];
  window.fetch = (url, options) => { const promise = fetch(new URL(url, origin), { ...options, headers: { ...options.headers, origin } }); sends.push(promise); return promise; };
  window.eval(script);
  for (const [index, probe] of [...apostropheDiagnostics, ...escapedQueryDiagnostics].entries()) await t.test(probe.name, async () => {
    const error = Object.assign(new Error(probe.message), { stack: probe.stack });
    window.dispatchEvent(new window.ErrorEvent('error', { error }));
    await Promise.all(sends);
    for (let i = 0; i < 100 && received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope').length < index + 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const errors = received.filter(event => event.headers['content-type'] === 'application/x-sentry-envelope');
    assert.equal(errors.length, index + 1);
    const event = JSON.parse(errors.at(-1).body.trim().split('\n')[2]);
    assert.doesNotMatch(JSON.stringify(event), /qa-apostrophe-query-marker|qa-apostrophe-fragment-marker|Reilly/);
    assert.equal(event.exception.values[0].value, probe.safe);
    assert.deepEqual(event.exception.values[0].stacktrace.frames, probe.frames);
  });
});

test('project validation accepts only opt-in protocol contracts and rejects unsafe provider configuration', async () => {
  const { validateProjectConfigShape } = await import('../dist/cli/project-config.js');
  const { validateObservabilityConfig } = await import('../dist/observability-runtime.js');
  assert.doesNotThrow(() => validateProjectConfigShape({ name: 'test', analytics: {}, observability: {} }));
  for (const config of [
    { observability: null }, { observability: { errors: [] } },
    { observability: { errors: { protocol: 'other', dsnEnv: 'DSN' } } },
    { observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', sampleRate: -1 } } },
    { observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN', sampleRate: NaN } } },
    { analytics: { provider: 'umami', endpointEnv: 'URL', websiteIdEnv: 'ID', redactQuery: false } },
    { analytics: { provider: 'umami', endpointEnv: 'https://invalid.test', websiteIdEnv: 'ID' } },
  ]) assert.throws(() => validateObservabilityConfig(config), { code: 'INVALID_OBSERVABILITY_CONFIG' });
  for (const DSN of ['http://key@remote.test/1', 'https://key:secret@receiver.test/1', 'https://key@receiver.test/not-project?token=secret']) {
    assert.throws(() => createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, { DSN }), error => error.code === 'INVALID_OBSERVABILITY_CONFIG' && !error.message.includes('secret'));
  }
});

test('provider redirect/failure is opaque and outbound capacity is bounded', async t => {
  const forwarded = [];
  const destination = await listen(t, (request, response) => { forwarded.push(request.url); response.end(); });
  const redirect = await listen(t, (request, response) => response.writeHead(307, { location: destination }).end('private-provider-error'));
  const config = { analytics: { provider: 'plausible', endpointEnv: 'URL', websiteIdEnv: 'ID' } };
  const database = { observability: createRuntimeObservability(config, { URL: redirect, ID: 'test.example' }) };
  const origin = await listen(t, (request, response) => routeCollection(database, request, response).then(handled => { if (!handled) response.writeHead(404).end(); }));
  const response = await fetch(origin + '/__sporades/collect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'pageview', url: origin }) });
  assert.equal(response.status, 400); assert.equal(await response.text(), ''); assert.deepEqual(forwarded, []);
  const releases = [];
  const hanging = await listen(t, (request, response) => { releases.push(() => response.end()); });
  const errors = createRuntimeObservability({ observability: { errors: { protocol: 'sentry', dsnEnv: 'DSN' } } }, { DSN: hanging.replace('http://', 'http://key@') + '/1' });
  for (let i = 0; i < 20; i++) errors.capture(new Error('bounded error'), 'query');
  for (let i = 0; i < 100 && releases.length < 8; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(releases.length, 8);
  errors.close(); await errors.flush(); for (const release of releases) release();
});
