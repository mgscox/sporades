import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { capsule, endpoint, requireAuth } from '../dist/server.js';
import { createPendingFileUpload } from '../dist/file-storage-runtime.js';
import { handleFileHttpRoute } from '../dist/http-runtime.js';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { openDevDatabase, routeEndpoint, runClientAccessKeyOperation } from '../dist/server-runtime-source.js';

const scratch = new URL('../.scratch/issue-124/', import.meta.url);
const actor = id => ({ userId: id, displayName: id, email: `${id}@example.com`, picture: null, isAuthenticated: true, isGuest: false, provider: 'email' });
const attribute = (span, key) => span.attributes.find(item => item.key === key)?.value.stringValue;
const outcome = span => attribute(span, 'sporades.operation.outcome');

async function seed(database, auth, token) {
  await database.adapter.insertAuthUser({ id: auth.userId, ...auth, createdAt: '2026-10-01T00:00:00.000Z', isAuthenticated: 1, isGuest: 0 });
  await database.adapter.insertAuthSession({ token, userId: auth.userId, provider: 'email', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
}

async function fixture(definition, enabled = true) {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch.pathname, 'test-'));
  const stored = path.join(dir, 'traces.jsonl');
  const collector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/v1/traces') await appendFile(stored, `${Buffer.concat(chunks).toString()}\n`);
    response.end('{}');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry(enabled ? { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'auth-file-test' } : undefined);
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: definition.name, files: { storagePath: path.join(dir, 'files') } }, definition);
  const app = createServer((request, response) => {
    Promise.resolve(telemetry.run(request, response, database.endpoints ?? [], async () => {
      if (await routeEndpoint(database, request, response)) return;
      if (await handleFileHttpRoute(database, request, response)) return;
      response.writeHead(404).end('Not found');
    })).catch(() => { if (!response.headersSent) response.writeHead(500).end('Internal server error.'); });
  }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  let sequence = 0;
  return {
    database, dir, telemetry, origin: `http://127.0.0.1:${app.address().port}`,
    async request(url, options = {}) {
      const traceId = (++sequence).toString(16).padStart(32, '0');
      const response = await fetch(`http://127.0.0.1:${app.address().port}${url}`, { ...options, headers: { ...options.headers, traceparent: `00-${traceId}-1234567890abcdef-01`, cookie: 'private-cookie-canary' } });
      return { traceId, status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    },
    async spans() {
      await telemetry.shutdown();
      return (await readFile(stored, 'utf8')).trim().split('\n').flatMap(line => JSON.parse(line).resourceSpans).flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans);
    },
    async close() {
      await telemetry.shutdown();
      await new Promise(resolve => app.close(resolve));
      await new Promise(resolve => collector.close(resolve));
      await database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('real auth and File requests export child durations while preserving denial, revocation and privacy', async () => {
  const f = await fixture(capsule({ name: 'auth-files', accessKeys: { scopes: ['files:read', 'other:read'] }, files: { accessKeys: { read: { scopes: ['files:read'] } } }, endpoints: {
    protected: endpoint({ method: 'GET', path: '/protected' }, requireAuth(() => 'allowed')),
  } }));
  const owner = actor('private-owner-canary');
  const other = actor('private-other-canary');
  const token = 'private-session-canary';
  try {
    await seed(f.database, owner, token);
    await seed(f.database, other, 'private-other-session-canary');
    const pending = await createPendingFileUpload(f.database, owner, { file: { name: 'private-name-canary.txt', path: '/private-path-canary.txt', type: 'text/plain', size: 20 } });
    assert.equal(pending.ok, true);
    const upload = await f.request(pending.data.uploadUrl, { method: 'PUT', body: 'private-bytes-canary!' });
    assert.equal(upload.status, 200);
    const file = JSON.parse(upload.body).data.file;
    const url = `/__sporades/files/private/${file.id}?v=${file.version}&secret=private-query-canary`;
    const allowed = await f.request(url, { headers: { 'x-sporades-session-token': token } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, 'private-bytes-canary!');
    assert.equal(allowed.headers['cache-control'], 'private, max-age=31536000, immutable');
    const denied = await f.request(url, { headers: { 'x-sporades-session-token': 'private-other-session-canary' } });
    assert.equal(denied.status, 404);
    assert.equal(denied.body, 'Not found');
    const missing = await f.request('/protected');
    assert.equal(missing.status, 401);
    assert.equal(JSON.parse(missing.body).error.message, 'Unauthenticated.');
    const admitted = await f.request('/protected', { headers: { 'x-sporades-session-token': token } });
    assert.equal(admitted.status, 200);
    assert.equal(admitted.body, 'allowed');
    const issue = async grants => {
      const result = await runClientAccessKeyOperation(f.database, owner, { type: 'accessKeys.issue', input: { name: `private-key-name-canary-${grants[0]}`, grants } }, token);
      assert.equal(result.error, null, JSON.stringify(result.error));
      return result.data;
    };
    const key = await issue(['files:read']);
    const bearer = await f.request(url, { headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.headers['cache-control'], 'private, no-store');
    const wrongKey = await issue(['other:read']);
    const scopeDenied = await f.request(url, { headers: { authorization: `Bearer ${wrongKey.token}` } });
    assert.equal(scopeDenied.status, 403);
    await runClientAccessKeyOperation(f.database, owner, { type: 'accessKeys.revoke', accessKeyId: key.accessKey.id }, token);
    const revoked = await f.request(url, { headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(revoked.status, 401);
    const spans = await f.spans();
    const children = request => spans.filter(span => span.traceId === request.traceId && span.kind === 1);
    assert.deepEqual(children(allowed).map(span => [span.name, outcome(span)]).sort(), [['sporades.auth.session.resolve', 'success'], ['sporades.file.authorize', 'success'], ['sporades.file.read', 'success']]);
    assert(children(denied).some(span => span.name === 'sporades.file.authorize' && outcome(span) === 'denied'));
    assert(children(missing).some(span => span.name === 'sporades.auth.admit' && outcome(span) === 'denied'));
    assert(children(admitted).some(span => span.name === 'sporades.auth.admit' && outcome(span) === 'success'));
    assert(children(scopeDenied).some(span => span.name === 'sporades.auth.admit' && outcome(span) === 'denied'));
    assert(children(revoked).some(span => span.name === 'sporades.auth.access_key.resolve' && outcome(span) === 'denied'));
    assert(children(upload).some(span => span.name === 'sporades.file.upload' && outcome(span) === 'success'));
    assert(children(upload).some(span => span.name === 'sporades.file.bytes.write' && outcome(span) === 'success'));
    for (const child of spans.filter(span => span.kind === 1)) {
      const root = spans.find(span => span.traceId === child.traceId && span.kind === 2);
      assert.equal(child.parentSpanId, root.spanId);
      assert(BigInt(child.endTimeUnixNano) >= BigInt(child.startTimeUnixNano));
      assert.equal(child.events.length, 0);
    }
    assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length);
    const serialized = JSON.stringify(spans);
    for (const secret of ['private-', token, file.id, file.version, key.token, key.accessKey.id, wrongKey.token]) assert.equal(serialized.includes(secret), false, secret);
  } finally { await f.close(); }
});

test('File cancellation, exceptions, concurrent parentage and the per-request budget stay bounded', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const active = new Promise(resolve => { entered = resolve; });
  let mode = 'hold';
  const owner = actor('private-owner-canary');
  const f = await fixture(capsule({ name: 'bounded-auth-files', files: { acl: { read: async () => {
    if (mode === 'hold') { entered(); await held; return false; }
    throw new Error('private-exception-canary');
  } } }, endpoints: {
    budget: endpoint({ method: 'GET', path: '/budget' }, requireAuth(async ctx => {
      for (let i = 0; i < 80; i++) { try { await ctx.files.delete('private-missing-file-canary'); } catch {} }
      return 'done';
    })),
  } }));
  try {
    await seed(f.database, owner, 'private-owner-session-canary');
    await seed(f.database, actor('private-other-canary'), 'private-other-session-canary');
    const pending = await createPendingFileUpload(f.database, owner, { file: { name: 'private-name-canary.txt', path: '/private-path-canary.txt', type: 'text/plain', size: 1 } });
    const upload = await f.request(pending.data.uploadUrl, { method: 'PUT', body: 'a' });
    const file = JSON.parse(upload.body).data.file;
    const url = `/__sporades/files/private/${file.id}?v=${file.version}`;
    const abortTrace = 'abcdefabcdefabcdefabcdefabcdefab';
    const client = httpRequest(`${f.origin}${url}`, { headers: { 'x-sporades-session-token': 'private-other-session-canary', traceparent: `00-${abortTrace}-1234567890abcdef-01` } });
    client.on('error', () => {});
    client.end();
    await active;
    const overlapping = await f.request(url, { headers: { 'x-sporades-session-token': 'private-owner-session-canary' } });
    assert.equal(overlapping.status, 200);
    client.destroy();
    // Let the server observe the real socket close before the ACL settles.
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    const budget = await f.request('/budget', { headers: { 'x-sporades-session-token': 'private-owner-session-canary' } });
    assert.equal(budget.status, 200, budget.body);
    assert.equal(budget.body, 'done');
    mode = 'throw';
    const failed = await f.request(url, { headers: { 'x-sporades-session-token': 'private-other-session-canary' } });
    assert.equal(failed.status, 500);
    assert.equal(JSON.parse(failed.body).error.message, 'Endpoint handler failed.');
    await unlink(path.join(f.dir, 'files', file.id, file.version));
    const absentBytes = await f.request(url, { headers: { 'x-sporades-session-token': 'private-owner-session-canary' } });
    assert.equal(absentBytes.status, 404);
    assert.equal(absentBytes.body, 'Not found');
    const spans = await f.spans();
    const aborted = spans.filter(span => span.traceId === abortTrace);
    assert.equal(aborted.filter(span => span.name === 'sporades.file.authorize').length, 1);
    assert.equal(outcome(aborted.find(span => span.name === 'sporades.file.authorize')), 'cancelled');
    assert.equal(attribute(aborted.find(span => span.kind === 2), 'sporades.http.outcome'), 'abort');
    assert.equal(spans.filter(span => span.traceId === budget.traceId && span.kind === 1).length, 32);
    assert(spans.some(span => span.traceId === failed.traceId && span.name === 'sporades.file.authorize' && outcome(span) === 'error'));
    assert(spans.some(span => span.traceId === absentBytes.traceId && span.name === 'sporades.file.read' && outcome(span) === 'error'));
    for (const span of spans.filter(span => span.kind === 1)) assert.equal(span.parentSpanId, spans.find(root => root.traceId === span.traceId && root.kind === 2)?.spanId);
    assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length);
    assert.doesNotMatch(JSON.stringify(spans), /private-|ENOENT|Error:|stack|cookie|authorization/);
  } finally { release(); await f.close(); }
});

test('enabling auth/File telemetry preserves externally observable responses', async () => {
  const results = [];
  for (const enabled of [false, true]) {
    const f = await fixture(capsule({ name: 'response-parity', endpoints: {
      protected: endpoint({ method: 'GET', path: '/protected' }, requireAuth(() => 'allowed')),
    } }), enabled);
    try {
      await seed(f.database, actor('private-owner-canary'), 'private-session-canary');
      const observed = [];
      for (const [url, options] of [['/protected', {}], ['/protected', { headers: { 'x-sporades-session-token': 'private-session-canary' } }], ['/__sporades/files/private/private-id-canary?v=private-version-canary', {}]]) {
        const response = await f.request(url, options);
        observed.push({ status: response.status, body: response.body, headers: Object.fromEntries(['content-type', 'cache-control', 'pragma', 'www-authenticate'].map(key => [key, response.headers[key] ?? null])) });
      }
      results.push(observed);
    } finally { await f.close(); }
  }
  assert.deepEqual(results[1], results[0]);
});
