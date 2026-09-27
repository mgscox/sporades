import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';

import { activeRuntimeRequestSpan, createHttpRequestTelemetry, resolveTelemetryRoute } from '../dist/runtime-telemetry.js';
import { createLogEnvelope } from '../dist/server-runtime-source.js';
import { minimumLogPayloadMaxBytes } from '../dist/log-envelope.js';

test('overlapping request logs carry isolated trace and stable request identities', async () => {
  const telemetry = createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:19999', tls: { mode: 'loopback' }, serviceName: 'log-test' });
  const logs = [];
  let atFloor;
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/work' }], async () => {
    const label = request.url.includes('slow') ? 'slow' : 'fast';
    const log = (suffix) => logs.push(createLogEnvelope({ config: { name: 'log-test' }, category: 'app', event: 'ctx.log', message: `${label}-${suffix}`, request: { method: 'GET', path: '/work' }, correlation: { id: `caller-${label}` }, data: { safe: label, password: 'private-password' } }));
    log('start');
    if (label === 'slow') {
      const config = { name: 'log-test', logs: { payloadMaxBytes: minimumLogPayloadMaxBytes({ name: 'log-test' }) } };
      atFloor = createLogEnvelope({ config, timestamp: '2026-09-11T00:00:00.000Z', category: 'c'.repeat(16), level: 'l'.repeat(16), event: 'e'.repeat(64), message: 'm'.repeat(128), data: { value: 'd'.repeat(244) } });
    }
    await new Promise((resolve) => setTimeout(resolve, label === 'slow' ? 50 : 5));
    log('end');
    response.writeHead(200).end();
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    await Promise.all([
      fetch(`${origin}/work?slow=private`, { headers: { traceparent: '00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01' } }),
      fetch(`${origin}/work?fast=private`, { headers: { traceparent: '00-22222222222222222222222222222222-bbbbbbbbbbbbbbbb-01' } }),
    ]);
    assert.equal(logs.length, 4);
    for (const label of ['slow', 'fast']) {
      const pair = logs.filter((entry) => entry.message.startsWith(label));
      assert.equal(pair.length, 2);
      assert.match(pair[0].request.id, /^[0-9a-f-]{36}$/);
      assert.equal(pair[0].request.id, pair[1].request.id);
      assert.equal(pair[0].traceId, label === 'slow' ? '11111111111111111111111111111111' : '22222222222222222222222222222222');
      assert.match(pair[0].spanId, /^[0-9a-f]{16}$/);
      assert.equal(pair[0].spanId, pair[1].spanId);
      assert.deepEqual(pair[0].correlation, { id: `caller-${label}` });
      assert.equal(pair[0].data.password, '[REDACTED]');
    }
    assert.notEqual(logs[0].request.id, logs[2].request.id);
    assert.equal(atFloor.truncated, false);
    assert.equal(Buffer.byteLength(JSON.stringify(atFloor)), minimumLogPayloadMaxBytes({ name: 'log-test' }));
    assert.doesNotMatch(JSON.stringify(logs), /private|aaaaaaaa|bbbbbbbb/);
  } finally { await telemetry.shutdown(); app.close(); }
});

test('disabled telemetry keeps stable request IDs and preserves caller correlation', async () => {
  const telemetry = createHttpRequestTelemetry();
  const seen = [];
  const app = createServer((request, response) => telemetry.run(request, response, [], async () => {
    const log = (message, suppliedId) => seen.push(createLogEnvelope({ config: { name: 'disabled' }, message, request: suppliedId ? { id: suppliedId, method: 'GET', path: '/work' } : null, correlation: { id: 'caller-correlation' } }));
    log('first');
    await Promise.resolve();
    log('second');
    log('explicit', 'caller-request');
    response.writeHead(200).end();
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/work`)).status, 200);
    assert.equal(seen[0].request.id, seen[1].request.id);
    assert.equal(seen[2].request.id, 'caller-request');
    assert.deepEqual(seen.map((entry) => entry.correlation), Array(3).fill({ id: 'caller-correlation' }));
    assert(seen.every((entry) => entry.traceId === null && entry.spanId === null));
  } finally { await telemetry.shutdown(); app.close(); }
});

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

test('enabled Capsule exports periodic process CPU, memory and uptime without HTTP traffic', async () => {
  const batches = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    batches.push({ path: request.url, body: JSON.parse(body) });
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'resource-test', metricsIntervalMs: 1000 });
  try {
    await new Promise(resolve => setTimeout(resolve, 1300));
    const resources = batches.filter(batch => batch.path === '/v1/metrics').flatMap(batch => batch.body.resourceMetrics ?? []);
    assert(resources.length > 0, 'periodic export occurs without requests');
    const identity = resources[0].resource.attributes;
    assert.equal(identity.find(item => item.key === 'service.name')?.value.stringValue, 'resource-test');
    assert.match(identity.find(item => item.key === 'service.instance.id')?.value.stringValue ?? '', /^[0-9a-f-]{36}$/);
    const metrics = resources.flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []);
    const byName = name => metrics.find(metric => metric.name === name);
    const value = point => Number(point?.asDouble ?? point?.asInt);
    const cpu = byName('process.cpu.time');
    assert.equal(cpu.unit, 's');
    assert.equal(cpu.sum.isMonotonic, true);
    assert.deepEqual(cpu.sum.dataPoints.map(point => point.attributes.find(item => item.key === 'state')?.value.stringValue).sort(), ['system', 'user']);
    assert(cpu.sum.dataPoints.every(point => value(point) >= 0));
    for (const name of ['process.memory.rss', 'process.memory.heap.used', 'process.memory.heap.allocated', 'process.memory.heap.limit', 'process.memory.external', 'process.memory.array_buffers']) {
      const metric = byName(name);
      assert.equal(metric.unit, 'By', name);
      assert(value(metric.gauge.dataPoints[0]) > 0, name);
    }
    assert.equal(byName('process.uptime').unit, 's');
    assert(value(byName('process.uptime').gauge.dataPoints[0]) > 0);
  } finally { await telemetry.shutdown(); collector.close(); }
});

test('disabled and replaced telemetry stop process exports without multiplying readers', async () => {
  const resources = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    if (request.url === '/v1/metrics') resources.push(...(JSON.parse(body).resourceMetrics ?? []));
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const config = { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'reload-test', metricsIntervalMs: 1000 };
  const first = createHttpRequestTelemetry(config);
  try {
    await new Promise(resolve => setTimeout(resolve, 1150));
    await first.shutdown();
    const firstId = resources.find(resource => resource.scopeMetrics?.some(scope => scope.metrics?.some(metric => metric.name === 'process.uptime')))?.resource.attributes.find(item => item.key === 'service.instance.id')?.value.stringValue;
    assert(firstId);
    const afterDisable = resources.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(resources.length, afterDisable, 'disabled reader does not export again');
    const replacement = createHttpRequestTelemetry(config);
    try {
      await new Promise(resolve => setTimeout(resolve, 1150));
      const ids = resources.map(resource => resource.resource.attributes.find(item => item.key === 'service.instance.id')?.value.stringValue).filter(Boolean);
      assert(ids.includes(firstId));
      assert(ids.every(id => id === firstId), 'reload preserves the running process identity');
    } finally { await replacement.shutdown(); }
    const afterReloadShutdown = resources.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(resources.length, afterReloadShutdown, 'replacement reader does not leak a timer');
  } finally { await first.shutdown(); collector.close(); }
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

test('idle metric export reports authentication loss and recovery through the diagnostic seam', async () => {
  const diagnostics = [];
  const requests = [];
  let status = 401;
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    requests.push(request.url);
    response.writeHead(status).end('private receiver detail');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    tls: { mode: 'loopback' }, serviceName: 'idle-metric-diagnostics', metricsIntervalMs: 1000,
  }, diagnostic => diagnostics.push(diagnostic));
  const waitFor = async predicate => {
    const deadline = Date.now() + 4500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), 'expected metric export and diagnostic before deadline');
  };
  try {
    await waitFor(() => requests.filter(path => path === '/v1/metrics').length >= 2);
    assert.deepEqual(diagnostics, [{ event: 'telemetry.export.failed', reason: 'AUTH_REJECTED' }]);
    assert.deepEqual([...new Set(requests)], ['/v1/metrics']);
    status = 200;
    await waitFor(() => diagnostics.some(diagnostic => diagnostic.event === 'telemetry.export.recovered'));
    assert.deepEqual(diagnostics, [
      { event: 'telemetry.export.failed', reason: 'AUTH_REJECTED' },
      { event: 'telemetry.export.recovered' },
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private receiver|127\\.0\\.0\\.1/);
  } finally { await telemetry.shutdown(); collector.close(); }
});

test('metric destination failure recovers when the idle receiver returns', async () => {
  const diagnostics = [];
  const reserve = createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${port}`,
    tls: { mode: 'loopback' }, serviceName: 'metric-destination-test', metricsIntervalMs: 1000,
  }, diagnostic => diagnostics.push(diagnostic));
  const waitFor = async predicate => {
    const deadline = Date.now() + 4500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), 'expected idle metric diagnostic before deadline');
  };
  let collector;
  try {
    await waitFor(() => diagnostics.some(diagnostic => diagnostic.reason === 'DESTINATION_UNAVAILABLE'));
    collector = createServer(async (request, response) => {
      for await (const _ of request) {}
      response.writeHead(200).end();
    }).listen(port, '127.0.0.1');
    await once(collector, 'listening');
    await waitFor(() => diagnostics.some(diagnostic => diagnostic.event === 'telemetry.export.recovered'));
    assert.deepEqual(diagnostics, [
      { event: 'telemetry.export.failed', reason: 'DESTINATION_UNAVAILABLE' },
      { event: 'telemetry.export.recovered' },
    ]);
  } finally { await telemetry.shutdown(); collector?.close(); }
});

test('trace and metric transport recoveries wait until both exporters are healthy', async () => {
  const diagnostics = [];
  const received = { traces: 0, metrics: 0 };
  let traceStatus = 200;
  let metricStatus = 401;
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    const signal = request.url === '/v1/traces' ? 'traces' : 'metrics';
    received[signal]++;
    response.writeHead(signal === 'traces' ? traceStatus : metricStatus).end();
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    tls: { mode: 'loopback' }, serviceName: 'partial-export-test', metricsIntervalMs: 1000,
  }, diagnostic => diagnostics.push(diagnostic));
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const driveTrace = async () => assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/ok`)).status, 200);
  const waitFor = async predicate => {
    const deadline = Date.now() + 4500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), 'expected exporter callback before deadline');
  };
  try {
    await waitFor(() => diagnostics.length === 1);
    assert.deepEqual(diagnostics, [{ event: 'telemetry.export.failed', reason: 'AUTH_REJECTED' }]);
    await driveTrace();
    await waitFor(() => received.traces >= 1);
    assert.equal(diagnostics.length, 1, 'healthy trace callback does not clear metric failure');
    metricStatus = 200;
    await waitFor(() => diagnostics.length === 2);
    assert.deepEqual(diagnostics[1], { event: 'telemetry.export.recovered' });

    traceStatus = 401;
    await driveTrace();
    await waitFor(() => received.traces >= 2);
    assert.equal(diagnostics.length, 2, 'the same reason stays throttled after recovery');
    const metricCount = received.metrics;
    await waitFor(() => received.metrics > metricCount);
    assert.equal(diagnostics.length, 2, 'healthy metric callback does not clear trace failure');
    traceStatus = 200;
    await driveTrace();
    await waitFor(() => received.traces >= 3);
    assert.equal(diagnostics.length, 2, 'a throttled failure cannot produce an orphan recovery');
  } finally { await telemetry.shutdown(); app.close(); collector.close(); }
});

test('mixed trace and metric failures suppress repeats of each reason during one outage', async () => {
  const diagnostics = [];
  const received = { traces: 0, metrics: 0 };
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    if (request.url === '/v1/traces') {
      received.traces++;
      response.writeHead(503).end('private trace failure');
    } else {
      received.metrics++;
      response.writeHead(401).end('private metric failure');
    }
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    tls: { mode: 'loopback' }, serviceName: 'mixed-failure-test', metricsIntervalMs: 1000,
  }, diagnostic => diagnostics.push(diagnostic));
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), 'expected both exporters to complete repeated callbacks');
  };
  try {
    const origin = `http://127.0.0.1:${app.address().port}/ok`;
    for (let index = 0; index < 4; index++) {
      assert.equal((await fetch(origin)).status, 200);
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    await waitFor(() => received.traces >= 4 && received.metrics >= 2);
    assert.deepEqual(diagnostics, [
      { event: 'telemetry.export.failed', reason: 'EXPORT_FAILED' },
      { event: 'telemetry.export.failed', reason: 'AUTH_REJECTED' },
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|127\\.0\\.0\\.1/);
  } finally { await telemetry.shutdown(); app.close(); collector.close(); }
});
