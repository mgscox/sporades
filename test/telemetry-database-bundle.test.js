import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const source = `
import { capsule, endpoint, String, table } from 'sporades/server';
export default capsule({ name: 'database-trace-bundle', schema: {
  telemetry_notes: table({ text: String() }).acl({ read: () => true, write: ({ next }) => next?.text !== 'denied-private-122' }),
  telemetry_unique: table({ text: String() }).unique('text').acl({ read: () => true, write: () => true }),
}, endpoints: {
  write: endpoint({ method: 'GET', path: '/write' }, async ctx => {
    await ctx.db.telemetry_notes.insert({ text: 'row-private-122' });
    await new Promise(resolve => setTimeout(resolve, ctx.request.query.slow ? 40 : 5));
    return { status: 200, body: { count: (await ctx.db.telemetry_notes.all()).length } };
  }),
  fail: endpoint({ method: 'GET', path: '/fail' }, async ctx => {
    await ctx.db.telemetry_notes.insert({ text: 'rollback-private-122' });
    throw new Error('exception-private-122');
  }),
  deny: endpoint({ method: 'GET', path: '/deny' }, async ctx => {
    await ctx.db.telemetry_notes.insert({ text: 'denied-private-122' });
    return { status: 200, body: 'must not commit' };
  }),
  sqlFail: endpoint({ method: 'GET', path: '/sql-fail' }, async ctx => {
    await ctx.db.telemetry_unique.insert({ text: 'constraint-private-122' });
    await ctx.db.telemetry_unique.insert({ text: 'constraint-private-122' });
    return { status: 200, body: 'must roll back' };
  }),
  count: endpoint({ method: 'GET', path: '/count' }, async ctx => ({ status: 200, body: { count: (await ctx.db.telemetry_notes.all()).length } })),
} });`;

const flatten = batches => batches.flatMap(batch => batch.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
const attribute = (span, key) => span.attributes.find(item => item.key === key)?.value.stringValue;
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function boot(dir, env) {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    cwd: dir, env: { ...process.env, ...env, PORT: String(port), SPORADES_CONFIG_DIR: path.join(dir, 'config'), SPORADES_RUNTIME_PROBE_TOKEN: 'a'.repeat(64) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.resume();
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(child.exitCode, null, errors);
      if (await fetch(origin + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': 'a'.repeat(64) } }).then(response => response.ok, () => false)) return { origin, stop };
      await pause();
    }
    assert.fail('Capsule did not become ready');
  } catch (error) { await stop(); throw error; }
}

for (const engine of ['sqlite', 'postgres']) {
  test(`generated ${engine} Capsule stores parented database traces and preserves denial, rollback and restart`, {
    timeout: 60_000,
    skip: engine === 'postgres' && !process.env.SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL ? 'Set SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL to a disposable database.' : false,
  }, async () => {
    await mkdir(path.join(process.cwd(), '.scratch'), { recursive: true });
    const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'database-trace-bundle-'));
    const received = [];
    const collector = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      if (request.url === '/v1/traces') {
        received.push(JSON.parse(body));
        if (process.env.SPORADES_TELEMETRY_TRACE_INGEST_URL) {
          const forwarded = await fetch(process.env.SPORADES_TELEMETRY_TRACE_INGEST_URL + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
          assert.equal(forwarded.status, 200);
        }
      }
      response.end('{}');
    }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    let app;
    try {
      await mkdir(path.join(root, 'config'));
      const config = { name: 'database-trace-bundle', __sporadesTelemetry: { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'database-trace-bundle' }, ...(engine === 'postgres' ? { services: { database: { engine: 'postgres' } } } : {}) };
      const serverModuleSource = await bundleServerCapsuleModule({ serverSource: source, serverSourcePath: path.join(process.cwd(), 'server', 'index.ts') });
      await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv: {}, serverSource: source, serverModuleSource }));
      const env = engine === 'postgres' ? { SPORADES_SERVICE_DATABASE_ENGINE: 'postgres', SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL } : {};
      app = await boot(root, env);
      const initial = await (await fetch(app.origin + '/count')).json();
      const traceIds = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
      const writes = await Promise.all(traceIds.map((traceId, index) => fetch(app.origin + `/write?${index ? 'fast' : 'slow'}=query-private-122`, { headers: { traceparent: `00-${traceId}-aaaaaaaaaaaaaaaa-01` } })));
      assert(writes.every(response => response.status === 200));
      assert.equal((await fetch(app.origin + '/fail')).status, 500);
      assert.equal((await fetch(app.origin + '/deny')).status, 500);
      const failureTraceId = randomBytes(16).toString('hex');
      const sqlFailure = await fetch(app.origin + '/sql-fail', { headers: { traceparent: `00-${failureTraceId}-aaaaaaaaaaaaaaaa-01` } });
      assert.equal(sqlFailure.status, 500);
      assert.doesNotMatch(await sqlFailure.text(), /constraint-private-122|INSERT INTO/);
      assert.equal((await (await fetch(app.origin + '/count')).json()).count, initial.count + 2);
      await app.stop();
      const spans = flatten(received);
      for (const id of traceIds) {
        const request = spans.find(span => span.traceId === id && span.kind === 2);
        assert(request, 'SERVER span exported from Bundle');
        const database = spans.filter(span => span.traceId === id && attribute(span, 'db.system.name') === engine);
        assert(database.some(span => attribute(span, 'db.collection.name') === 'telemetry_notes' && attribute(span, 'db.operation.name') === 'INSERT'));
        const transactions = database.filter(span => attribute(span, 'db.operation.name') === 'TRANSACTION');
        assert(transactions.some(span => span.parentSpanId === request.spanId));
        const ids = new Set([request.spanId, ...database.map(span => span.spanId)]);
        assert(database.every(span => ids.has(span.parentSpanId)));
      }
      const failed = spans.find(span => span.name === 'GET /fail');
      assert(spans.some(span => span.traceId === failed.traceId && attribute(span, 'db.operation.name') === 'TRANSACTION' && span.status?.code === 2));
      assert(spans.some(span => span.traceId === failureTraceId && attribute(span, 'db.operation.name') === 'INSERT' && span.status?.code === 2));
      assert.doesNotMatch(JSON.stringify(received), /row-private-122|rollback-private-122|denied-private-122|exception-private-122|query-private-122|INSERT INTO|SELECT \*/);
      if (process.env.SPORADES_TELEMETRY_TRACE_QUERY_URL) {
        for (const id of [...traceIds, failed.traceId, failureTraceId]) {
          let stored;
          const expectedIds = spans.filter(span => span.traceId === id).map(span => span.spanId);
          for (let attempt = 0; attempt < 100; attempt++) {
            const response = await fetch(process.env.SPORADES_TELEMETRY_TRACE_QUERY_URL + '/api/v3/traces/' + id);
            if (response.ok) {
              const candidate = await response.json();
              const ids = new Set(flatten([candidate.result ?? candidate]).map(span => span.spanId));
              // Storage may expose the first export batch before the SERVER span's
              // later batch. An HTTP 200 alone is not complete stored-trace evidence.
              if (expectedIds.every(spanId => ids.has(spanId))) { stored = candidate; break; }
            }
            await pause();
          }
          assert(stored, 'trace was persisted in Jaeger');
          const storedSpans = flatten([stored.result ?? stored]);
          const parent = storedSpans.find(span => span.kind === 'SPAN_KIND_SERVER' || span.kind === 2);
          const children = storedSpans.filter(span => attribute(span, 'db.system.name') === engine);
          assert(parent && children.length > 0, 'stored request includes database spans');
          const ids = new Set([parent.spanId, ...children.map(span => span.spanId)]);
          assert(children.every(span => ids.has(span.parentSpanId)), 'stored parentage stays within its request');
          if (id === failed.traceId || id === failureTraceId) assert(children.some(span => span.status?.code === 2));
          assert.doesNotMatch(JSON.stringify(stored), /private-122|local-only|INSERT INTO/);
        }
      }
      app = await boot(root, env);
      assert.equal((await (await fetch(app.origin + '/count')).json()).count, initial.count + 2);
    } finally {
      await app?.stop();
      await new Promise(resolve => collector.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
