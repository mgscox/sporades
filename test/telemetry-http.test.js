import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';

import { activeRuntimeRequestSpan, createHttpRequestTelemetry, resolveTelemetryRoute } from '../dist/runtime-telemetry.js';

test('HTTP telemetry exports bounded route labels, terminal outcomes and isolated overlapping parents', async () => {
  const received = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    received.push(JSON.parse(body));
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const port = collector.address().port;
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${port}`, tls: { mode: 'loopback' }, serviceName: 'telemetry-test' });
  const seenContexts = new Map();
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/items' }], async () => {
    if (request.url.startsWith('/items')) {
      await new Promise((resolve) => setTimeout(resolve, request.url.includes('slow') ? 70 : 10));
      seenContexts.set(request.url.includes('slow') ? 'slow' : 'fast', activeRuntimeRequestSpan()?.spanContext().traceId);
      response.writeHead(200).end('ok');
    } else response.writeHead(404).end();
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    const [slow, fast, missing] = await Promise.all([
      fetch(`${origin}/items?slow=secret-one`, { headers: { traceparent: '00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01', baggage: 'secret-baggage=secret-four' } }),
      fetch(`${origin}/items?fast=secret-two`, { headers: { traceparent: '00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01' } }),
      fetch(`${origin}/private/alice?token=secret-three`),
    ]);
    assert.deepEqual([slow.status, fast.status, missing.status], [200, 200, 404]);
    await telemetry.shutdown();
    const spans = received.flatMap((batch) => batch.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []);
    assert.equal(spans.length, 3);
    assert.equal(spans.filter((span) => span.name === 'GET /items').length, 2);
    assert.equal(spans.filter((span) => span.name === 'GET /__unknown').length, 1);
    assert.equal(new Set(spans.map((span) => span.traceId)).size, 3);
    assert.equal(seenContexts.get('slow'), '11111111111111111111111111111111');
    assert.equal(seenContexts.get('fast'), '22222222222222222222222222222222');
    assert.deepEqual(new Set(spans.filter((span) => span.name === 'GET /items').map((span) => span.parentSpanId)), new Set(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']));
    assert.doesNotMatch(JSON.stringify(received), /alice|secret-one|secret-two|secret-three|secret-four/);
  } finally {
    app.close();
    collector.close();
  }
});

test('stream completion and premature client close each end one SERVER span', async () => {
  const received = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    received.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'stream-test' });
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/stream' }], () => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first');
    setTimeout(() => { if (!response.destroyed) response.end('last'); }, 60);
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    assert.equal(await (await fetch(`${origin}/stream`)).text(), 'firstlast');
    await new Promise((resolve) => get(`${origin}/stream`, (response) => {
      response.once('data', () => { response.destroy(); resolve(); });
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await telemetry.shutdown();
    const spans = received.filter(batch => batch.path === '/v1/traces').flatMap((batch) => batch.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []);
    assert.deepEqual(spans.map((span) => span.attributes.find((attribute) => attribute.key === 'sporades.http.outcome')?.value.stringValue).sort(), ['abort', 'success']);
    const metrics = received.filter(batch => batch.path === '/v1/metrics').flatMap(batch => batch.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []);
    const count = metrics.find(metric => metric.name === 'http.server.request.count');
    const outcomes = count?.sum?.dataPoints?.map(point => point.attributes.find(attribute => attribute.key === 'sporades.http.outcome')?.value.stringValue).sort();
    assert.deepEqual(outcomes, ['abort', 'success']);
    assert.equal(metrics.find(metric => metric.name === 'http.server.request.duration')?.histogram?.dataPoints?.reduce((total, point) => total + Number(point.count), 0), 2);
  } finally {
    app.close();
    collector.close();
  }
});

test('unknown and malformed targets never become route labels', () => {
  assert.equal(resolveTelemetryRoute({ method: 'GET', url: '/private/alice?secret=1' }, []), '/__unknown');
  assert.equal(resolveTelemetryRoute({ method: 'GET', url: '/%GG?secret=1' }, []), '/__unknown');
});

test('request metrics count sampled-out traffic, failures and streams without private labels', async () => {
  const batches = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    batches.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'metric-test', samplingRatio: 0 });
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }, { method: 'GET', path: '/stream' }], () => {
    if (request.url.startsWith('/ok')) response.writeHead(200).end('ok');
    else if (request.url === '/stream') { response.writeHead(200).write('first'); setTimeout(() => response.end('last'), 30); }
    else response.writeHead(404).end();
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    assert.equal((await fetch(`${origin}/ok?secret=alice`)).status, 200);
    assert.equal((await fetch(`${origin}/private/alice?secret=bob`)).status, 404);
    assert.equal(await (await fetch(`${origin}/stream`)).text(), 'firstlast');
    await new Promise(resolve => get({ hostname: '127.0.0.1', port: app.address().port, path: '/%GG?secret=charlie' }, response => { response.resume(); response.once('end', resolve); }));
    await telemetry.shutdown();
    assert.equal(batches.filter(batch => batch.path === '/v1/traces').length, 0);
    const metrics = batches.filter(batch => batch.path === '/v1/metrics').flatMap(batch => batch.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []);
    const count = metrics.find(metric => metric.name === 'http.server.request.count');
    const duration = metrics.find(metric => metric.name === 'http.server.request.duration');
    const inflight = metrics.find(metric => metric.name === 'http.server.active_requests');
    assert.equal(count?.sum?.dataPoints?.reduce((total, point) => total + Number(point.asInt ?? point.asDouble), 0), 4);
    assert.equal(duration?.histogram?.dataPoints?.reduce((total, point) => total + Number(point.count), 0), 4);
    assert.equal(inflight?.sum?.dataPoints?.reduce((total, point) => total + Number(point.asInt ?? point.asDouble), 0), 0);
    const labels = JSON.stringify(metrics);
    assert.match(labels, /__unknown|4xx|success/);
    assert.doesNotMatch(labels, /alice|bob|charlie|secret|traceId/);
  } finally { app.close(); collector.close(); }
});

test('an uncaught handler rejection records an error status before the HTTP error response', async () => {
  const batches = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    batches.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'rejection-test', samplingRatio: 0 });
  const app = createServer((request, response) => Promise.resolve(telemetry.run(request, response, [{ method: 'GET', path: '/throws' }], async () => {
    throw new Error('private rejected request');
  })).catch(() => response.writeHead(500).end())).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/throws`)).status, 500);
    await telemetry.shutdown();
    const count = batches.filter(batch => batch.path === '/v1/metrics').flatMap(batch => batch.body.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []).find(metric => metric.name === 'http.server.request.count');
    const attributes = count?.sum?.dataPoints?.[0]?.attributes ?? [];
    assert.equal(attributes.find(attribute => attribute.key === 'http.response.status_code')?.value.stringValue, '5xx');
    assert.equal(attributes.find(attribute => attribute.key === 'sporades.http.outcome')?.value.stringValue, 'error');
    assert.doesNotMatch(JSON.stringify(batches), /private rejected request/);
  } finally { app.close(); collector.close(); }
});

test('a valid but unreachable collector does not hold up requests or shutdown', async () => {
  const telemetry = createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:19999', tls: { mode: 'loopback' }, serviceName: 'outage-test' });
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const start = Date.now();
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/ok`)).status, 200);
    assert(Date.now() - start < 1000, 'request should not wait for exporter failure');
    await telemetry.shutdown();
    assert(Date.now() - start < 2500, 'shutdown should have a bounded deadline');
  } finally { app.close(); }
});

test('export failure and recovery report bounded reason codes without exposing collector details', async () => {
  const diagnostics = [];
  let receiverStatus = 401;
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(receiverStatus).end('private receiver detail');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    tls: { mode: 'loopback' }, serviceName: 'diagnostics-test',
  }, (diagnostic) => diagnostics.push(diagnostic));
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const drive = async () => { assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/ok?private=secret`)).status, 200); await new Promise((resolve) => setTimeout(resolve, 800)); };
  try {
    await drive();
    await drive();
    assert.deepEqual(diagnostics, [{ event: 'telemetry.export.failed', reason: 'AUTH_REJECTED' }]);
    receiverStatus = 200;
    await drive();
    assert.deepEqual(diagnostics.at(-1), { event: 'telemetry.export.recovered' });
    await new Promise((resolve) => collector.close(resolve));
    await drive();
    assert.deepEqual(diagnostics.at(-1), { event: 'telemetry.export.failed', reason: 'DESTINATION_UNAVAILABLE' });
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret|private receiver|127\.0\.0\.1/);
  } finally { await telemetry.shutdown(); app.close(); collector.close(); }
});

test('a failing diagnostic sink cannot interrupt HTTP service or exporter shutdown', async () => {
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(401).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'sink-failure-test' }, () => Promise.reject(new Error('private diagnostic failure')));
  const app = createServer((request, response) => telemetry.run(request, response, [], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/ok`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await telemetry.shutdown();
  } finally { app.close(); collector.close(); }
});
