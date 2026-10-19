import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as http from '../dist/http-runtime.js';
import { createRuntimeObservability, routeCollection } from '../dist/observability-runtime.js';
import { validateSecurityConfig, resolveEffectiveSecurityPolicy } from '../dist/cli/project-config.js';
import { validateHttpHardening } from '../dist/http-security-config.js';

const errors = { protocol: 'sentry', dsnEnv: 'ERROR_DSN', environment: 'staging' };
const forwarding = { observability: { errors }, security: { csp: { mode: 'enforce', nonce: true, reportTo: 'observability' } } };

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A Capsule-shaped HTTP surface whose Sentry DSN points at a fake envelope receiver. */
async function capsule(t, config = forwarding, env) {
  const received = [];
  const receiver = await listen(t, async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    received.push({ path: request.url, headers: request.headers, body });
    response.writeHead(200).end('provider-private-response');
  });
  const observability = createRuntimeObservability({ name: 'csp-test', release: { id: 'release-235' }, ...config }, env ?? { ERROR_DSN: receiver.replace('http://', 'http://public-key@') + '/7' });
  t.after(() => observability.close());
  const database = { config, observability, securityPolicy: http.resolveRuntimeSecurityPolicy(config) };
  const origin = await listen(t, async (request, response) => {
    http.prepareHttpSecurity(database, request, response);
    if (await routeCollection(database, request, response)) return;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(http.renderPageHtml('<head></head>', response, 'test-token', database));
  });
  return { origin, received, observability };
}

const report = {
  'csp-report': {
    'document-uri': 'https://app.example.test/reset/doc-path-secret?token=doc-query-secret#doc-fragment-secret',
    referrer: 'https://app.example.test/?ref=referrer-secret',
    'violated-directive': "script-src-elem 'self'",
    'effective-directive': 'script-src-elem',
    'original-policy': "script-src 'nonce-policy-secret'",
    'blocked-uri': 'https://cdn.attacker.test/path-secret.js?q=blocked-query-secret#blocked-fragment-secret',
    'source-file': 'https://app.example.test/source-secret.js?s=source-query-secret',
    'script-sample': 'alert("sample-secret")',
    disposition: 'enforce',
    'status-code': 200,
    'line-number': 12,
  },
};
const leaks = /secret|attacker\.test\/|nonce-|public-key|ERROR_DSN|127\.0\.0\.1:\d+\/|ip_address/;

function envelope(entry) {
  const [header, item, event] = entry.body.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(header.event_id, event.event_id);
  assert.equal(item.type, 'event');
  assert.equal(item.length, Buffer.byteLength(JSON.stringify(event)));
  return event;
}

const post = (origin, body, type = 'application/csp-report', headers = {}) => fetch(origin + '/__sporades/csp-report', {
  method: 'POST', headers: { 'content-type': type, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('reportTo observability emits the runtime report route in headers and inspection', async t => {
  validateSecurityConfig(forwarding.security, forwarding.observability);
  for (const session of ['dev', 'container', 'hosted']) {
    const runtime = http.resolveRuntimeSecurityPolicy({ ...forwarding, __sporadesSession: session });
    const inspected = resolveEffectiveSecurityPolicy(forwarding, session);
    assert.deepEqual(inspected.csp, runtime.csp);
    assert.deepEqual(runtime.csp.directives['report-uri'], ['/__sporades/csp-report']);
  }
  const { origin } = await capsule(t);
  const response = await fetch(origin + '/');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /report-uri \/__sporades\/csp-report(;|$)/);
  assert.match(policy, /'nonce-[^']+' 'strict-dynamic'/);
  await response.text();
});

test('legacy csp-report violations reach the fake Sentry receiver as one bounded redacted envelope', async t => {
  const { origin, received, observability } = await capsule(t);
  const response = await post(origin, report, 'application/csp-report', { origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.7' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  await observability.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/api/7/envelope/');
  assert.equal(received[0].headers['content-type'], 'application/x-sentry-envelope');
  const event = envelope(received[0]);
  assert.equal(event.level, 'warning');
  assert.equal(event.logger, 'csp');
  assert.equal(event.platform, 'javascript');
  assert.equal(event.environment, 'staging');
  assert.equal(event.release, 'release-235');
  assert.equal(event.message, 'CSP violation: script-src-elem blocked https://cdn.attacker.test');
  assert.deepEqual(event.tags, { capsule: 'csp-test', surface: 'csp', csp_directive: 'script-src-elem', csp_blocked: 'https://cdn.attacker.test', csp_disposition: 'enforce' });
  assert.equal(event.user, undefined);
  assert.equal(event.exception, undefined);
  assert.doesNotMatch(JSON.stringify(event), leaks);
});

test('Reporting API batches forward csp-violation entries only, within a fixed per-request bound', async t => {
  const { origin, received, observability } = await capsule(t);
  const entry = (effectiveDirective, blockedURL) => ({ type: 'csp-violation', url: 'https://app.example.test/?token=doc-query-secret', body: { documentURL: 'https://app.example.test/doc-path-secret', effectiveDirective, blockedURL, disposition: 'report', sample: 'sample-secret', sourceFile: 'https://app.example.test/source-secret.js' } });
  const batch = [
    { type: 'deprecation', body: { message: 'other-report-secret' } },
    entry('script-src-elem', 'inline'),
    entry('img-src', 'data:image/png;base64,data-secret'),
    entry('connect-src', 'wss://socket.example.test/path-secret?x=1'),
    entry('style-src-attr', 'chrome-extension://extension-secret/script.js'),
    ...Array.from({ length: 10 }, () => entry('font-src', 'https://fonts.example.test/path-secret')),
  ];
  assert.equal((await post(origin, batch, 'application/reports+json')).status, 204);
  await observability.flush();
  const events = received.map(envelope);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map(event => [event.tags.csp_directive, event.tags.csp_blocked, event.tags.csp_disposition]), [
    ['script-src-elem', 'inline', 'report'],
    ['img-src', 'data:', 'report'],
    ['connect-src', 'wss://socket.example.test', 'report'],
    ['style-src-attr', 'chrome-extension:', 'report'],
    ['font-src', 'https://fonts.example.test', 'report'],
  ]);
  assert.doesNotMatch(JSON.stringify(events), leaks);
});

test('malformed, oversized, cross-site and wrong-method reports fail closed without delivery', async t => {
  const { origin, received, observability } = await capsule(t);
  const cases = [
    [() => post(origin, '{not json'), 400],
    [() => post(origin, 'null'), 400],
    [() => post(origin, []), 400],
    [() => post(origin, { 'csp-report': { 'effective-directive': 'script-src; report-uri https://evil.test', 'blocked-uri': 'inline' } }), 400],
    [() => post(origin, { 'csp-report': { 'effective-directive': 7 } }), 400],
    [() => post(origin, [{ type: 'deprecation', body: {} }], 'application/reports+json'), 400],
    [() => post(origin, JSON.stringify(report) + ' '.repeat(17000)), 413],
    [() => post(origin, report, 'text/plain'), 415],
    [() => post(origin, report, 'application/csp-report', { 'sec-fetch-site': 'cross-site' }), 403],
    [() => post(origin, report, 'application/csp-report', { origin: 'https://evil.test' }), 403],
    [() => fetch(origin + '/__sporades/csp-report'), 405],
  ];
  for (const [send, status] of cases) {
    const response = await send();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  }
  await observability.flush();
  assert.equal(received.length, 0);
  assert.equal((await post(origin, report)).status, 204, 'the runtime keeps serving after hostile input');
  await observability.flush();
  assert.equal(received.length, 1);
});

test('report forwarding shares the bounded collection budget', async t => {
  const { origin, received, observability } = await capsule(t);
  const statuses = [];
  for (let index = 0; index < 140; index++) statuses.push((await post(origin, report)).status);
  await observability.flush();
  assert.ok(statuses.includes(429));
  assert.ok(statuses.every(status => status === 204 || status === 429));
  assert.ok(received.length > 0 && received.length <= 120);
});

test('a dormant DSN accepts and drops reports; non-opted Capsules do not expose the route', async t => {
  const dormant = await capsule(t, forwarding, {});
  assert.equal((await post(dormant.origin, report)).status, 204);
  await dormant.observability.flush();
  assert.equal(dormant.received.length, 0);

  for (const config of [
    { observability: { errors } },
    { observability: { errors }, security: { csp: { reportTo: '/csp-reports' } } },
  ]) {
    const plain = await capsule(t, config);
    const response = await post(plain.origin, report);
    assert.equal(response.status, 200, 'falls through to ordinary Capsule routing');
    await response.text();
    const page = await fetch(plain.origin + '/');
    assert.doesNotMatch(page.headers.get('content-security-policy-report-only'), /__sporades\/csp-report/);
    await page.text();
    await plain.observability.flush();
    assert.equal(plain.received.length, 0);
  }
});

test('reportTo observability requires configured observability.errors', () => {
  const security = { csp: { reportTo: 'observability' } };
  for (const observability of [undefined, {}, { errors: undefined }]) {
    assert.throws(() => validateHttpHardening(security, observability), error => error.code === 'INVALID_SECURITY_CONFIG');
    assert.throws(() => validateSecurityConfig(security, observability), error => error.code === 'INVALID_SECURITY_CONFIG');
    assert.throws(() => http.resolveRuntimeSecurityPolicy({ security, observability }), error => error.code === 'INVALID_SECURITY_CONFIG');
  }
  for (const reportTo of ['Observability', 'observability.errors', 'errors']) {
    assert.throws(() => validateHttpHardening({ csp: { reportTo } }, { errors }), error => error.code === 'INVALID_SECURITY_CONFIG');
  }
});

test('nonce mode authorizes the runtime collection loader with the response nonce', async t => {
  const config = { observability: { errors: { ...errors, client: true } }, security: { csp: { mode: 'enforce', nonce: true } } };
  const { origin } = await capsule(t, config);
  const response = await fetch(origin + '/');
  const nonce = response.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  const html = await response.text();
  assert.ok(html.includes(`<script nonce="${nonce}">window.__SPORADES_CONNECTION_TOKEN="test-token";</script>`));
  assert.ok(html.includes(`<script nonce="${nonce}" src="/__sporades/observe.js"></script>`));
  const legacy = await capsule(t, { observability: { errors: { ...errors, client: true } } });
  const legacyHtml = await (await fetch(legacy.origin + '/')).text();
  assert.ok(legacyHtml.includes('<script>window.__SPORADES_CONNECTION_TOKEN="test-token";</script><script src="/__sporades/observe.js"></script>'));
});
