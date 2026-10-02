import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { withoutRuntimeRequestIdentity } from '../dist/runtime-request-context.js';
import { validateTracePropagationOrigins } from '../dist/telemetry-propagation-policy.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const attributes = span => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue]));
const spansFrom = payloads => payloads.flatMap(p => (p.resourceSpans ?? []).flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('fetch children measure dependency waits, isolate parents, sanitize failures and restrict propagation', async () => {
  const original = globalThis.fetch;
  const payloads = [], calls = [];
  const collector = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString())); res.end('{}');
  }).listen(0, '127.0.0.1');
  const dependency = createServer(async (req, res) => {
    calls.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: `http://localhost:${dependency.address().port}/target` }).end(); return; }
    if (req.url.startsWith('/reset')) { req.socket.destroy(); return; }
    await pause(req.url.startsWith('/slow') ? 120 : 5);
    if (!res.destroyed) res.writeHead(req.url.startsWith('/failure') ? 503 : 200).end('dependency body');
  }).listen(0, '127.0.0.1');
  await Promise.all([once(collector, 'listening'), once(dependency, 'listening')]);
  const dependencyOrigin = `http://127.0.0.1:${dependency.address().port}`;
  const config = { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'fetch-test', tracePropagationOrigins: [dependencyOrigin] };
  const telemetry = createHttpRequestTelemetry(config);
  const second = createHttpRequestTelemetry(config);
  const wrapper = globalThis.fetch;
  let thrown, expectedReason;
  const app = createServer((req, res) => telemetry.run(req, res, [{ method: 'GET', path: '/work' }], async () => {
    const mode = new URL(req.url, 'http://local').searchParams.get('mode');
    let input = `${dependencyOrigin}/${mode === 'timeout' || mode === 'cancel' ? 'slow' : mode}/alice?token=private-query`;
    const init = { redirect: 'manual', headers: { authorization: 'private-credential', 'x-private': 'private-header' } };
    if (mode === 'timeout') init.signal = AbortSignal.timeout(20);
    if (mode === 'cancel') {
      const controller = new AbortController(); expectedReason = new Error('private-cancel-reason');
      init.signal = controller.signal; setTimeout(() => controller.abort(expectedReason), 20);
    }
    if (mode === 'unapproved') input = input.replace('127.0.0.1', 'localhost');
    if (mode === 'follow') { input = `${dependencyOrigin}/redirect`; init.redirect = 'follow'; }
    if (mode === 'request') {
      input = new Request(input, { ...init, method: 'POST', body: 'private-body' });
      delete init.headers; delete init.redirect;
    }
    try { const response = await fetch(input, init); res.end(`${response.status}:${await response.text()}`); }
    catch (error) { if (mode === 'cancel') thrown = error; res.end('caught'); }
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const appOrigin = `http://127.0.0.1:${app.address().port}`;
  try {
    const modes = ['slow', 'fast', 'reset', 'timeout', 'cancel', 'unapproved', 'follow', 'failure', 'request'];
    const responses = await Promise.all(modes.map((mode, i) => original(`${appOrigin}/work?mode=${mode}`, {
      headers: { traceparent: `00-${String(i + 1).repeat(32)}-${'a'.repeat(16)}-01`, baggage: 'secret=private-baggage' },
    }).then(r => r.text())));
    assert.equal(responses[0], '200:dependency body'); assert.equal(responses[7], '503:dependency body');
    assert.equal(thrown, expectedReason, 'cancellation keeps the original rejection object');
    assert.equal(wrapper, globalThis.fetch, 'second provider did not wrap fetch again');
    const beforeBackground = calls.length;
    await withoutRuntimeRequestIdentity(() => fetch(`${dependencyOrigin}/background`));
    assert.equal(calls.length, beforeBackground + 1);
    assert.equal(calls.at(-1).headers.traceparent, undefined);
    await second.shutdown(); assert.equal(globalThis.fetch, wrapper);
    await telemetry.shutdown(); assert.equal(globalThis.fetch, original);
    const spans = spansFrom(payloads), children = spans.filter(s => s.kind === 3), parents = spans.filter(s => s.kind === 2);
    assert.equal(children.length, modes.length); assert.equal(parents.length, modes.length);
    for (const child of children) {
      assert.equal(child.parentSpanId, parents.find(p => p.traceId === child.traceId)?.spanId);
      assert.match(child.name, /^HTTP (GET|POST)$/);
      assert.deepEqual(Object.keys(attributes(child)).sort(), attributes(child)['http.response.status_code'] === undefined
        ? ['http.request.method', 'sporades.http.outcome'] : ['http.request.method', 'http.response.status_code', 'sporades.http.outcome']);
    }
    const slow = children.find(s => s.traceId === '1'.repeat(32));
    assert(Number(BigInt(slow.endTimeUnixNano) - BigInt(slow.startTimeUnixNano)) / 1e6 >= 100);
    const outcomes = children.map(s => attributes(s)['sporades.http.outcome']);
    for (const outcome of ['success', 'failure', 'network_error', 'timeout', 'cancelled']) assert(outcomes.includes(outcome), outcome);
    for (const child of children.filter(s => attributes(s)['sporades.http.outcome'] !== 'success')) assert.equal(child.status.code, 2);
    for (const call of calls) {
      assert.equal(call.headers.baggage, undefined); assert.equal(call.headers.tracestate, undefined);
      if (call.url.startsWith('/unapproved') || call.url === '/redirect' || call.url === '/target' || call.url === '/background') assert.equal(call.headers.traceparent, undefined);
      else {
        assert.match(call.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        const [, traceId, spanId] = call.headers.traceparent.split('-');
        assert(children.some(s => s.traceId === traceId && s.spanId === spanId));
      }
    }
    assert.doesNotMatch(JSON.stringify(payloads), /private-|alice|dependency body|localhost|127\.0\.0\.1/);
  } finally { await telemetry.shutdown(); await second.shutdown(); await Promise.all([close(app), close(dependency), close(collector)]); }
});

test('disabled telemetry leaves fetch untouched; blocked exports preserve dependency success', async () => {
  const original = globalThis.fetch;
  const disabled = createHttpRequestTelemetry(); assert.equal(globalThis.fetch, original); await disabled.shutdown();
  const collector = createServer((_req, _res) => {}).listen(0, '127.0.0.1');
  const dependency = createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
  await Promise.all([once(collector, 'listening'), once(dependency, 'listening')]);
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'blocked-test' });
  const app = createServer((req, res) => telemetry.run(req, res, [], async () => {
    res.end(await (await fetch(`http://127.0.0.1:${dependency.address().port}`)).text());
  })).listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    for (let i = 0; i < 150; i++) assert.equal(await (await original(`http://127.0.0.1:${app.address().port}`)).text(), 'ok');
    await pause(600); assert.equal(await (await original(`http://127.0.0.1:${app.address().port}`)).text(), 'ok');
    const started = Date.now(); await telemetry.shutdown(); assert(Date.now() - started < 2500);
    assert.equal(globalThis.fetch, original);
  } finally { await telemetry.shutdown(); await Promise.all([close(app), close(dependency), close(collector)]); }
});

test('propagation policy is bounded, exact and rejects secret-bearing input', () => {
  assert.deepEqual(validateTracePropagationOrigins(['https://EXAMPLE.com:443/', 'https://example.com']), ['https://example.com']);
  for (const value of ['https://example.com', Array(33).fill('https://example.com'), ['*'], ['https://*.example.com'], ['https:example.com'], ['https://example.com/.'], ['https://user:private@example.com'], ['https://example.com/private'], ['https://example.com?'], ['https://example.com#'], ['ftp://example.com'], [' https://example.com']]) {
    assert.throws(() => validateTracePropagationOrigins(value), /Invalid trace propagation origins/);
  }
});

test('approved propagation preserves native invalid-input rejections without sending a request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const dependency = createServer((_req, res) => { calls++; res.end('unexpected'); }).listen(0, '127.0.0.1');
  await once(dependency, 'listening');
  const origin = `http://127.0.0.1:${dependency.address().port}`;
  const telemetry = createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:19999', tls: { mode: 'loopback' }, serviceName: 'invalid-fetch', tracePropagationOrigins: [origin] });
  let failure;
  const app = createServer((req, res) => telemetry.run(req, res, [], async () => {
    try {
      for (const input of [origin, new Request(origin, { headers: { authorization: 'private-input-credential' } })]) {
        for (const init of [{ redirect: 'manual', headers: null }, { redirect: 'error', headers: null },
          { redirect: 'manual', signal: { get aborted() { throw new Error('private-signal-getter'); } } }]) {
          const expected = await original(input, init).then(() => null, error => error);
          const actual = await fetch(input, init).then(() => null, error => error);
          assert(expected instanceof TypeError); assert(actual instanceof TypeError);
          assert.equal(actual.message, expected.message);
        }
      }
    } catch (error) { failure = error; }
    res.end('checked');
  })).listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    assert.equal(await (await original(`http://127.0.0.1:${app.address().port}`)).text(), 'checked');
    if (failure) throw failure;
    assert.equal(calls, 0);
  } finally { await telemetry.shutdown(); await Promise.all([close(app), close(dependency)]); }
});

test('propagation preserves frozen/inherited options and getter receivers without following redirects', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const dependency = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), traceparent: req.headers.traceparent });
    if (req.url === '/redirect') res.writeHead(307, { location: `http://localhost:${dependency.address().port}/unapproved` }).end('manual');
    else res.end('followed');
  }).listen(0, '127.0.0.1'); await once(dependency, 'listening');
  const origin = `http://127.0.0.1:${dependency.address().port}`;
  const telemetry = createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:19999', tls: { mode: 'loopback' }, serviceName: 'fetch-facade', tracePropagationOrigins: [origin] });
  let failure;
  const app = createServer((req, res) => telemetry.run(req, res, [], async () => {
    try {
      const options = { method: 'POST', body: 'private-facade-body', redirect: 'manual', headers: { authorization: 'private-facade-credential' } };
      const inherited = Object.freeze(Object.create(options));
      let accessorOptions;
      accessorOptions = Object.freeze(Object.create({
        get method() { assert.equal(this, accessorOptions); return 'POST'; },
        get body() { assert.equal(this, accessorOptions); return 'private-facade-body'; },
        get redirect() { assert.equal(this, accessorOptions); return 'manual'; },
        get headers() { assert.equal(this, accessorOptions); return options.headers; },
      }));
      const customArrayOptions = { ...options, headers: [['authorization', 'private-facade-credential']] };
      customArrayOptions.headers.every = () => { customArrayOptions.redirect = 'follow'; return true; };
      for (const init of [Object.freeze(options), inherited, accessorOptions, customArrayOptions]) {
        const expected = await original(`${origin}/redirect`, init);
        const actual = await fetch(`${origin}/redirect`, init);
        assert.equal(actual.status, expected.status); assert.equal(actual.status, 307);
        assert.equal(actual.redirected, false); assert.equal(await actual.text(), await expected.text());
      }
    } catch (error) { failure = error; }
    res.end('checked');
  })).listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    await original(`http://127.0.0.1:${app.address().port}`);
    if (failure) throw failure;
    assert.equal(calls.length, 8); assert(calls.every(call => call.path === '/redirect'));
    assert(calls.every(call => call.method === 'POST' && call.body === 'private-facade-body'));
    for (let index = 0; index < calls.length; index++) {
      if (index % 2 === 0) assert.equal(calls[index].traceparent, undefined);
      else if (index === 5) assert.equal(calls[index].traceparent, undefined, 'accessor options are delegated unchanged');
      else assert.match(calls[index].traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    }
  } finally { await telemetry.shutdown(); await Promise.all([close(app), close(dependency)]); }
});

test('stateful redirect/body/header accessors retain native evaluation and never receive a carrier', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const dependency = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain POST bodies before responding. */ }
    calls.push({ path: req.url, traceparent: req.headers.traceparent });
    if (req.url === '/redirect') res.writeHead(307, { location: `http://localhost:${dependency.address().port}/unapproved` }).end('manual');
    else res.end('followed');
  }).listen(0, '127.0.0.1'); await once(dependency, 'listening');
  const origin = `http://127.0.0.1:${dependency.address().port}`;
  const telemetry = createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:19999', tls: { mode: 'loopback' }, serviceName: 'fetch-accessors', tracePropagationOrigins: [origin] });
  let failure;
  const app = createServer((req, res) => telemetry.run(req, res, [], async () => {
    try {
      const factories = [
        () => { let reads = 0; return Object.freeze({ get redirect() { return ++reads === 1 ? 'manual' : 'follow'; } }); },
        () => { const value = { method: 'POST', redirect: 'manual', get body() { value.redirect = 'follow'; return 'private-body'; } }; return value; },
        () => { const value = { redirect: 'manual', get headers() { value.redirect = 'follow'; return { authorization: 'private-credential' }; } }; return value; },
        () => new Proxy({ redirect: 'manual' }, {}),
        () => { const value = { method: 'POST', redirect: 'manual', body: { toString() { value.redirect = 'follow'; return 'private-body'; } } }; return value; },
      ];
      for (const make of factories) {
        const expected = await original(`${origin}/redirect`, make());
        const actual = await fetch(`${origin}/redirect`, make());
        assert.equal(actual.status, expected.status); assert.equal(actual.redirected, expected.redirected);
        assert.equal(await actual.text(), await expected.text());
      }
    } catch (error) { failure = error; }
    res.end('checked');
  })).listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    await original(`http://127.0.0.1:${app.address().port}`);
    if (failure) throw failure;
    assert(calls.some(call => call.path === '/unapproved'));
    assert(calls.every(call => call.traceparent === undefined));
  } finally { await telemetry.shutdown(); await Promise.all([close(app), close(dependency)]); }
});
