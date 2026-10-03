import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { createPostgresDatabaseAdapter } from '../dist/database-runtime.js';
import { withSqliteAdapter, withLibsqlAdapter } from './support/database-adapter-engines.js';

const attribute = (span, key) => span.attributes.find(item => item.key === key)?.value.stringValue;
const flatten = batches => batches.flatMap(batch => batch.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
const withPostgres = async fn => {
  const adapter = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_TELEMETRY_POSTGRES_TEST_URL });
  try { await fn(adapter); } finally { await adapter.close(); }
};

for (const [engine, withAdapter] of [['sqlite', withSqliteAdapter], ['libsql', withLibsqlAdapter], ['postgres', withPostgres]]) {
  test(`${engine} database time, failures and rollback are isolated children of overlapping requests`, {
    skip: engine === 'postgres' && !process.env.SPORADES_TELEMETRY_POSTGRES_TEST_URL ? 'Set SPORADES_TELEMETRY_POSTGRES_TEST_URL to a disposable database.' : false,
  }, async () => withAdapter(async adapter => {
    const rowId = `private-row-id-122-${randomUUID()}`;
    await adapter.ensureSystemTable();
    await adapter.migrateAppSchema({ tables: [{ name: 'trace_notes', fields: [{ name: 'text', kind: 'String', sqliteType: 'TEXT' }] }] });
    const received = [];
    const collector = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      received.push(JSON.parse(body));
      response.end('{}');
    }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'database-traces' });
    let captured;
    const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/commit' }, { method: 'GET', path: '/rollback' }, { method: 'GET', path: '/read' }], async () => {
      try {
        if (request.url === '/read') {
          const rows = await adapter.prepare('SELECT * FROM "trace_notes" WHERE "id" = ?').all(rowId + '/commit');
          response.end(JSON.stringify(rows.map(row => row.text)));
        } else {
          await adapter.withTransaction(async transaction => {
            captured = transaction.prepare('SELECT 1');
            await transaction.prepare('INSERT INTO "trace_notes" ("id", "text", "createdAt", "updatedAt") VALUES (?, ?, ?, ?)').run(rowId + request.url, 'private-row-122', '2026-01-01', '2026-01-01');
            await new Promise(resolve => setTimeout(resolve, 30));
            if (request.url === '/rollback') await transaction.prepare('INSERT INTO "trace_notes" ("id", "text", "createdAt", "updatedAt") VALUES (?, ?, ?, ?)').run(rowId + '/rollback', 'private-parameter-122', '2026-01-01', '2026-01-01');
          });
          response.end('committed');
        }
      } catch { response.writeHead(500).end('opaque'); }
    })).listen(0, '127.0.0.1');
    await once(app, 'listening');
    try {
      const origin = `http://127.0.0.1:${app.address().port}`;
      const results = await Promise.all(['/commit', '/rollback'].map(route => fetch(origin + route)));
      assert.deepEqual(results.map(result => result.status), [200, 500]);
      assert.deepEqual(await (await fetch(origin + '/read')).json(), ['private-row-122']);
      await assert.rejects(async () => captured.get(), /no longer active/);
      await telemetry.shutdown();
      const spans = flatten(received);
      const requests = spans.filter(span => span.kind === 2);
      const databaseSpans = spans.filter(span => attribute(span, 'db.system.name') === engine);
      assert(databaseSpans.length >= 6, 'database operations must be exported');
      for (const request of requests) {
        const children = databaseSpans.filter(span => span.traceId === request.traceId);
        assert(children.length > 0, 'each request has its own database children');
        const ids = new Set([request.spanId, ...children.map(span => span.spanId)]);
        assert(children.every(span => ids.has(span.parentSpanId)), 'children stay in their request');
      }
      const transactions = databaseSpans.filter(span => attribute(span, 'db.operation.name') === 'TRANSACTION');
      assert.equal(transactions.length, 2);
      assert.equal(transactions.filter(span => span.status?.code === 2).length, 1);
      assert(databaseSpans.some(span => attribute(span, 'db.operation.name') === 'INSERT' && span.status?.code === 2));
      assert.equal(databaseSpans.filter(span => attribute(span, 'db.operation.name') === 'INSERT').length, 3, 'each statement is timed once, including copied transaction operations');
      assert(databaseSpans.some(span => attribute(span, 'db.collection.name') === 'trace_notes'));
      assert.doesNotMatch(JSON.stringify(received), /private-row-122|private-row-id-122|private-parameter-122|INSERT INTO|SELECT \*|local-only|exception.message|exception.stacktrace/);
    } finally {
      await telemetry.shutdown();
      await new Promise(resolve => app.close(resolve));
      await new Promise(resolve => collector.close(resolve));
    }
  }));
}

test('database labels exclude raw literals and unknown identifiers while disabled, sampled-out and completed requests stay uninstrumented', async () => withSqliteAdapter(async adapter => {
  const received = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    received.push(JSON.parse(body));
    response.end('{}');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  try {
    // A statement prepared before any request must select the execution context,
    // not capture whichever request happened to prepare it.
    const prepared = adapter.prepare("SELECT 'literal-private-122' AS value");
    for (const mode of ['disabled', 'sampled-out', 'enabled']) {
      received.length = 0;
      const telemetry = createHttpRequestTelemetry(mode === 'disabled' ? undefined : {
        endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'database-labels', samplingRatio: mode === 'sampled-out' ? 0 : 1,
      });
      let finished;
      const done = new Promise(resolve => { finished = resolve; });
      const app = createServer((request, response) => telemetry.run(request, response, [], async () => {
        const row = prepared.get();
        assert.equal(typeof row.then, 'undefined', 'SQLite remains synchronous');
        assert.equal(row.value, 'literal-private-122');
        assert.throws(() => adapter.prepare('SELECT * FROM "identifier_private_122"').get());
        assert.equal(adapter.prepare('/* comment-private-122 */ SELECT 1 AS n').get().n, 1);
        assert.equal(adapter.prepare(`/* ${'oversize-private-122'.repeat(500)} */ SELECT 1 AS n`).get().n, 1);
        response.end('ok');
        await new Promise(resolve => setTimeout(resolve, 20));
        prepared.get();
        finished();
      })).listen(0, '127.0.0.1');
      await once(app, 'listening');
      try {
        assert.equal(await (await fetch(`http://127.0.0.1:${app.address().port}/work`)).text(), 'ok');
        await done;
        await telemetry.shutdown();
        const spans = flatten(received);
        const database = spans.filter(span => attribute(span, 'db.system.name') === 'sqlite');
        assert.equal(database.length, mode === 'enabled' ? 4 : 0);
        if (mode === 'enabled') {
          assert.equal(database.filter(span => attribute(span, 'db.operation.name') === 'OTHER').length, 2);
          assert(database.every(span => attribute(span, 'db.collection.name') === '__other'));
          assert.equal(database.filter(span => span.status?.code === 2).length, 1);
        }
        assert.doesNotMatch(JSON.stringify(received), /literal-private|identifier_private|comment-private|oversize-private|SELECT \*|exception/);
      } finally {
        await telemetry.shutdown();
        await new Promise(resolve => app.close(resolve));
      }
    }
  } finally { await new Promise(resolve => collector.close(resolve)); }
}));
