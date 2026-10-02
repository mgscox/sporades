import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const source = `
import { capsule, query, mutation, requireAuth, String, table } from 'sporades/server';
export default capsule({ name: 'websocket-telemetry', schema: {
  notes: table({ text: String() }).acl({ read: () => true, write: () => true }),
  protectedNotes: table({ text: String() }).acl({ read: () => true, write: () => false }),
}, queries: {
  read: query(async (ctx, delay = 0) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    return await ctx.db.notes.all();
  }),
  denied: query(requireAuth(async () => 'unreachable')),
  broken: query(async () => { throw new Error('exception-private-125'); }),
}, mutations: {
  write: mutation(async (ctx, delay = 0) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    return await ctx.db.notes.all();
  }),
  denied: mutation(requireAuth(async () => 'unreachable')),
  broken: mutation(async () => { throw new Error('exception-private-125'); }),
  aclDenied: mutation(async ctx => ctx.db.protectedNotes.insert({ text: 'payload-private-125' })),
  insert: mutation(async ctx => ctx.db.notes.insert({ text: 'payload-private-125' })),
} });`;

const spans = batches => batches.filter(batch => batch.path === '/v1/traces').flatMap(batch => batch.body.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
const metrics = batches => batches.filter(batch => batch.path === '/v1/metrics').flatMap(batch => batch.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []);
const attr = (item, key) => item.attributes?.find(attribute => attribute.key === key)?.value.stringValue;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(25); }
  assert.fail(message);
}

async function fixture(run, { samplingRatio = 1, rejectExports = false } = {}) {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'websocket-telemetry-'));
  const received = [];
  let stack;
  if (process.env.SPORADES_WEBSOCKET_STACK_DIRECTORY) {
    const directory = path.resolve(process.env.SPORADES_WEBSOCKET_STACK_DIRECTORY);
    assert(directory.startsWith(process.cwd() + path.sep), 'acceptance stack must be inside this worktree');
    const credentials = JSON.parse(await readFile(path.join(directory, '.private', 'credentials.json'), 'utf8'));
    const env = await readFile(path.join(directory, '.env'), 'utf8');
    const port = Number(/^TRACE_PORT=(\d+)$/m.exec(env)?.[1]);
    assert(Number.isInteger(port) && port >= 5600 && port <= 5999, 'acceptance stack uses an isolated local port');
    stack = { origin: `http://127.0.0.1:${port}`, credentials };
  }
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    received.push({ path: request.url, body: JSON.parse(body) });
    if (stack && !rejectExports) {
      const forwarded = await fetch(stack.origin + request.url, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + stack.credentials.ingestToken,
      }, body });
      assert.equal(forwarded.status, 200, 'disposable monitoring gateway accepts OTLP');
    }
    response.writeHead(rejectExports ? 503 : 200).end('{}');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  let child;
  const sockets = [];
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    const tree = path.join(root, '.sporades', 'build', '.public-trees');
    const treeName = '1-' + Date.now() + '-abcdef125abc';
    await mkdir(path.join(tree, treeName), { recursive: true });
    await writeFile(path.join(tree, treeName, 'index.html'), '<html><body>fixture</body></html>');
    await writeFile(path.join(tree, 'active.json'), JSON.stringify({ tree: treeName }));
    const config = { name: 'websocket-telemetry', auth: { providers: { email: { enabled: true } } }, __sporadesTelemetry: {
      endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' },
      serviceName: 'websocket-telemetry', samplingRatio, metricsIntervalMs: 1000,
    } };
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource: source, serverSourcePath: path.join(process.cwd(), 'server', 'index.ts') });
    await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv: {}, serverSource: source, serverModuleSource,
      epilogue: 'process.stdout.write(JSON.stringify({ listening: server.address().port }) + "\\n");',
    }));
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root,
      env: { ...process.env, PORT: '0', SPORADES_CONFIG_DIR: path.join(root, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    let port;
    await until(() => {
      assert.equal(child.exitCode, null, errors.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[embedded module]'));
      port = output.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Number.isInteger);
      return port;
    }, 'generated runtime did not listen');
    const origin = `http://127.0.0.1:${port}`;
    const open = async () => {
      const html = await (await fetch(origin, { headers: { 'sec-fetch-dest': 'document' } })).text();
      const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html)?.[1];
      assert(token, 'runtime page provides the upgrade token: ' + html.slice(0, 500));
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/__sporades/ws?connectionToken=' + token);
      sockets.push(socket);
      const replies = [];
      socket.addEventListener('message', event => replies.push(JSON.parse(event.data)));
      await once(socket, 'open');
      return { socket, replies, async send(message) {
        const start = replies.length;
        socket.send(JSON.stringify(message));
        await until(() => replies.slice(start).some(reply => reply.id === message.id), 'no WebSocket response');
        return replies.slice(start).find(reply => reply.id === message.id);
      } };
    };
    await run({ open, received, stop, origin, stack });
  } finally {
    for (const socket of sockets) socket.close();
    await stop();
    await new Promise(resolve => collector.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('generated WebSocket operations export bounded spans, independent metrics and isolated database children', { timeout: 30_000 }, async () => {
  await fixture(async ({ open, received, stop, stack }) => {
    const first = await open();
    const second = await open();
    const traces = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
    const query = first.send({ id: 'payload-private-125', type: 'query.subscribe', query: 'read', args: [120],
      traceparent: `00-${traces[0]}-aaaaaaaaaaaaaaaa-01`, baggage: 'email=identity-private-125', tracestate: 'private=secret-private-125' });
    const mutation = first.send({ id: 'second', type: 'mutation.run', mutation: 'write', args: [30], traceparent: `00-${traces[1]}-bbbbbbbbbbbbbbbb-01` });
    const other = second.send({ id: 'other', type: 'mutation.run', mutation: 'write', args: [10], traceparent: `00-${traces[2]}-cccccccccccccccc-01` });
    assert((await Promise.all([query, mutation, other])).every(reply => !reply.error));
    assert((await first.send({ id: 'deny', type: 'mutation.run', mutation: 'denied' })).error);
    assert((await first.send({ id: 'break', type: 'query.subscribe', query: 'broken' })).error);
    assert((await first.send({ id: 'unknown', type: 'mutation.run', mutation: 'name-private-125', traceparent: '00-' + '0'.repeat(32) + '-aaaaaaaaaaaaaaaa-01' })).error);
    await until(() => spans(received).filter(span => span.name.startsWith('websocket.')).length === 6, 'operation spans must export while sockets are still open');
    const operations = spans(received).filter(span => span.name.startsWith('websocket.'));
    for (let i = 0; i < traces.length; i++) {
      const operation = operations.find(span => span.traceId === traces[i]);
      assert(operation, 'approved message traceparent correlates exactly one operation');
      assert.equal(operation.kind, 2);
      assert.equal(attr(operation, 'sporades.websocket.outcome'), 'success');
      assert.equal(operation.parentSpanId, ['a', 'b', 'c'][i].repeat(16));
      assert(spans(received).some(span => span.traceId === traces[i] && span.parentSpanId === operation.spanId && attr(span, 'db.system.name') === 'sqlite'));
    }
    assert(operations.some(span => attr(span, 'sporades.websocket.outcome') === 'denied' && span.status?.code === 2));
    assert(operations.some(span => attr(span, 'sporades.websocket.outcome') === 'error' && span.status?.code === 2));
    assert(operations.some(span => attr(span, 'sporades.websocket.operation.name') === '__unknown'));
    await until(() => metrics(received).some(metric => metric.name === 'sporades.websocket.active_connections' && metric.gauge.dataPoints.some(point => Number(point.asInt ?? point.asDouble) === 2)), 'active connection gauge reflects two sockets');
    first.socket.close(); second.socket.close();
    await until(() => metrics(received).some(metric => metric.name === 'sporades.websocket.active_connections' && metric.gauge.dataPoints.some(point => Number(point.asInt ?? point.asDouble) === 0)), 'closed sockets return gauge to zero');
    await stop();
    const counts = metrics(received).filter(metric => metric.name === 'sporades.websocket.operation.count').at(-1).sum.dataPoints;
    assert.equal(counts.reduce((sum, point) => sum + Number(point.asInt ?? point.asDouble), 0), 6);
    const durations = metrics(received).filter(metric => metric.name === 'sporades.websocket.operation.duration').at(-1).histogram.dataPoints;
    assert.equal(durations.reduce((sum, point) => sum + Number(point.count), 0), 6);
    assert.doesNotMatch(JSON.stringify(received), /payload-private-125|identity-private-125|secret-private-125|exception-private-125|name-private-125/);
    if (stack) {
      const headers = { authorization: 'Basic ' + Buffer.from(stack.credentials.uiUser + ':' + stack.credentials.uiPassword).toString('base64') };
      for (const traceId of traces) {
        let stored;
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await fetch(stack.origin + '/api/v3/traces/' + traceId, { headers });
          if (response.ok) {
            const body = await response.json();
            const candidate = (body.result?.resourceSpans ?? []).flatMap(resource => resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []);
            const expected = spans(received).filter(span => span.traceId === traceId);
            if (expected.every(span => candidate.some(item => item.spanId === span.spanId))) { stored = candidate; break; }
          }
          await pause(100);
        }
        assert(stored, 'Jaeger stores the whole generated-runtime operation trace');
      }
      const query = '/grafana/api/datasources/proxy/uid/sporades-prometheus/api/v1/query?query=' + encodeURIComponent('sporades_websocket_operation_count_total{service_name="websocket-telemetry"}');
      let storedMetrics;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await (await fetch(stack.origin + query, { headers })).json();
        if (result.data?.result?.length) { storedMetrics = result.data.result; break; }
        await pause(100);
      }
      assert(storedMetrics?.some(series => series.metric.sporades_websocket_outcome === 'denied'), 'Prometheus stores independent WebSocket metrics');
      const gaugeQuery = '/grafana/api/datasources/proxy/uid/sporades-prometheus/api/v1/query?query=' + encodeURIComponent('sporades_websocket_active_connections_ratio{service_name="websocket-telemetry"}');
      let zeroStored = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const gauge = await (await fetch(stack.origin + gaugeQuery, { headers })).json();
        if (gauge.data?.result?.some(series => Number(series.value[1]) === 0)) { zeroStored = true; break; }
        await pause(100);
      }
      assert(zeroStored, 'Prometheus connection gauge matches the dashboard query and returns to zero');
    }
  });
});

test('ACL denials remain bounded denials and refresh executions have fresh operation context', { timeout: 30_000 }, async () => {
  await fixture(async ({ open, received, stop }) => {
    const client = await open();
    const queryTrace = '4'.repeat(32), mutationTrace = '5'.repeat(32);
    await client.send({ id: 'subscription', type: 'query.subscribe', query: 'read', traceparent: `00-${queryTrace}-aaaaaaaaaaaaaaaa-01` });
    assert.equal((await client.send({ id: 'acl', type: 'mutation.run', mutation: 'aclDenied' })).error.code, 'DENIED');
    assert.equal((await client.send({ id: 'insert', type: 'mutation.run', mutation: 'insert', traceparent: `00-${mutationTrace}-bbbbbbbbbbbbbbbb-01` })).error, null);
    await until(() => client.replies.filter(reply => reply.id === 'subscription').length === 2, 'mutation still refreshes the live query');
    await client.send({ id: 'unsubscribe', type: 'query.unsubscribe', subscriptionId: 'subscription' });
    client.socket.close();
    await stop();
    const operations = spans(received).filter(span => span.name.startsWith('websocket.'));
    assert.equal(operations.length, 4);
    const denied = operations.find(span => attr(span, 'sporades.websocket.operation.name') === 'aclDenied');
    assert.equal(attr(denied, 'sporades.websocket.outcome'), 'denied');
    const queries = operations.filter(span => span.name === 'websocket.query');
    assert.equal(queries.length, 2);
    const refresh = queries.find(span => span.traceId !== queryTrace);
    assert(refresh && refresh.traceId !== mutationTrace && !refresh.parentSpanId, 'refresh retains neither subscription nor triggering mutation parent');
    assert(spans(received).some(span => span.parentSpanId === refresh.spanId && span.traceId === refresh.traceId));
    assert.doesNotMatch(JSON.stringify(received), /payload-private-125/);
  });
});

test('unsubscribe, replacement and socket close settle each operation once without waiting for handlers', { timeout: 30_000 }, async () => {
  await fixture(async ({ open, received, stop }) => {
    const client = await open();
    client.socket.send(JSON.stringify({ id: 'cancel', type: 'query.subscribe', query: 'read', args: [1800] }));
    await client.send({ id: 'ready', type: 'auth.get' });
    assert.equal((await client.send({ id: 'unsubscribe', type: 'query.unsubscribe', subscriptionId: 'cancel' })).data.removed, true);
    client.socket.send(JSON.stringify({ id: 'replace', type: 'query.subscribe', query: 'read', args: [1800] }));
    await client.send({ id: 'ready2', type: 'auth.get' });
    await client.send({ id: 'replace', type: 'query.subscribe', query: 'read', args: [0] });
    client.socket.send(JSON.stringify({ id: 'disconnect', type: 'mutation.run', mutation: 'write', args: [1800] }));
    // Collection observes the transaction child before the delayed mutation settles.
    await until(() => spans(received).some(span => span.name === 'websocket.query'), 'query completes while socket stays open');
    client.socket.close();
    await until(() => spans(received).filter(span => attr(span, 'sporades.websocket.outcome') === 'cancelled').length === 3, 'cancellation is exported before delayed handlers settle');
    await pause(2000);
    assert.equal(client.replies.filter(reply => reply.id === 'cancel').length, 0, 'unsubscribe still suppresses late results');
    assert.equal(client.replies.filter(reply => reply.id === 'replace').length, 1, 'replacement still suppresses stale generation');
    await stop();
    const operations = spans(received).filter(span => span.name.startsWith('websocket.'));
    assert.equal(operations.length, 4);
    assert.equal(new Set(operations.map(span => span.spanId)).size, 4);
    const counts = metrics(received).filter(metric => metric.name === 'sporades.websocket.operation.count').at(-1).sum.dataPoints;
    assert.equal(counts.reduce((sum, point) => sum + Number(point.asInt ?? point.asDouble), 0), 4);
  });
});

test('sampled-out and rejected exports preserve WebSocket responses and independent operation metrics', { timeout: 30_000 }, async () => {
  for (const options of [{ samplingRatio: 0 }, { rejectExports: true }]) {
    await fixture(async ({ open, received, stop }) => {
      const client = await open();
      assert.equal((await client.send({ id: 'ok', type: 'query.subscribe', query: 'read' })).error, null);
      assert.equal((await client.send({ id: 'denied', type: 'query.subscribe', query: 'denied' })).error.code, 'UNAUTHENTICATED');
      assert((await client.send({ id: 'error', type: 'mutation.run', mutation: 'broken' })).error);
      client.socket.close();
      await stop();
      if (options.samplingRatio === 0) assert.equal(spans(received).length, 0);
      const counts = metrics(received).filter(metric => metric.name === 'sporades.websocket.operation.count').at(-1).sum.dataPoints;
      assert.equal(counts.reduce((sum, point) => sum + Number(point.asInt ?? point.asDouble), 0), 3);
      assert.deepEqual(new Set(counts.map(point => attr(point, 'sporades.websocket.outcome'))), new Set(['success', 'denied', 'error']));
    }, options);
  }
});

test('session revocation and reconnection keep their authority checks under telemetry', { timeout: 30_000 }, async () => {
  await fixture(async ({ open, received, stop }) => {
    const first = await open();
    const second = await open();
    const signUp = await first.send({ id: 'signup', type: 'auth.signUp', provider: 'email', credentials: { email: 'identity-private-125@example.com', password: 'credential-private-125' } });
    assert.equal(signUp.error, null);
    const sessionToken = (await first.send({ id: 'auth', type: 'auth.get' })).data.sessionToken;
    assert.equal((await second.send({ id: 'allowed', type: 'mutation.run', mutation: 'denied', sessionToken })).error, null);
    assert.equal((await first.send({ id: 'signout', type: 'auth.signOut' })).error, null);
    assert.equal((await second.send({ id: 'revoked', type: 'mutation.run', mutation: 'denied', sessionToken })).error.code, 'UNAUTHENTICATED');
    first.socket.close(); second.socket.close();
    const reconnected = await open();
    assert.equal((await reconnected.send({ id: 'reconnected', type: 'mutation.run', mutation: 'denied', sessionToken })).error.code, 'UNAUTHENTICATED');
    reconnected.socket.close();
    await stop();
    const operations = spans(received).filter(span => span.name === 'websocket.mutation');
    assert.deepEqual(operations.map(span => attr(span, 'sporades.websocket.outcome')).sort(), ['denied', 'denied', 'success']);
    assert.doesNotMatch(JSON.stringify(received), /identity-private-125|credential-private-125/);
    assert(!JSON.stringify(received).includes(sessionToken));
  });
});

test('invalid correlation and malformed queries use bounded labels without retaining remote baggage', { timeout: 30_000 }, async () => {
  await fixture(async ({ open, received, stop }) => {
    const client = await open();
    const invalid = [
      '00-' + '0'.repeat(32) + '-aaaaaaaaaaaaaaaa-01',
      '00-' + '6'.repeat(32) + '-' + '0'.repeat(16) + '-01',
      '00-' + '6'.repeat(32) + '-aaaaaaaaaaaaaaaa-ff',
      '00-' + 'A'.repeat(32) + '-aaaaaaaaaaaaaaaa-01',
      ['00-' + '6'.repeat(32) + '-aaaaaaaaaaaaaaaa-01'],
      { traceparent: '00-' + '6'.repeat(32) + '-aaaaaaaaaaaaaaaa-01' },
    ];
    for (let i = 0; i < invalid.length; i++) {
      assert.equal((await client.send({ id: String(i), type: 'mutation.run', mutation: 'write', traceparent: invalid[i],
        baggage: 'private=identity-private-125', tracestate: 'private=secret-private-125' })).error, null);
    }
    assert((await client.send({ id: 'invalid', type: 'query.subscribe', query: 'read', args: { private: 'payload-private-125' } })).error);
    assert((await client.send({ id: 'empty', type: 'query.subscribe', query: '' })).error);
    client.socket.close();
    await stop();
    const operations = spans(received).filter(span => span.name.startsWith('websocket.'));
    assert.equal(operations.length, 8);
    assert.equal(new Set(operations.map(span => span.traceId)).size, 8);
    assert(operations.every(span => !span.parentSpanId && span.traceId !== '6'.repeat(32)));
    assert.equal(operations.filter(span => attr(span, 'sporades.websocket.outcome') === 'error').length, 2);
    assert.doesNotMatch(JSON.stringify(received), /identity-private-125|secret-private-125|payload-private-125/);
  });
});

test('invalid connection tokens and cross-origin upgrades remain denied without connection telemetry', { timeout: 30_000 }, async () => {
  await fixture(async ({ origin, received, stop }) => {
    const html = await (await fetch(origin, { headers: { 'sec-fetch-dest': 'document' } })).text();
    const token = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html)[1];
    for (const [connectionToken, requestOrigin] of [['token-private-125', origin], [token, 'https://attacker-private-125.example']]) {
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(origin + '/__sporades/ws?connectionToken=' + connectionToken, { headers: {
          connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: requestOrigin,
        } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('unapproved upgrade succeeded')); });
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 403);
    }
    await stop();
    assert(!spans(received).some(span => span.name.startsWith('websocket.')));
    assert(metrics(received).filter(metric => metric.name === 'sporades.websocket.active_connections').every(metric => metric.gauge.dataPoints.every(point => Number(point.asInt ?? point.asDouble) === 0)));
    assert.doesNotMatch(JSON.stringify(received), /token-private-125|attacker-private-125/);
  });
});
