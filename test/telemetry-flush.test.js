import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';

async function receiver(delayMs = 100, holdFirstTrace = false) {
  const received = [];
  let firstTrace;
  const firstTraceArrived = new Promise(resolve => { firstTrace = resolve; });
  let firstMetric;
  const firstMetricArrived = new Promise(resolve => { firstMetric = resolve; });
  let releaseFirstTrace;
  const firstTraceReleased = new Promise(resolve => { releaseFirstTrace = resolve; });
  let heldTrace = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url, body: JSON.parse(body) });
    if (request.url === '/v1/traces') {
      firstTrace();
      if (holdFirstTrace && !heldTrace) { heldTrace = true; await firstTraceReleased; }
    }
    if (request.url === '/v1/metrics') firstMetric();
    await new Promise(resolve => setTimeout(resolve, delayMs));
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, received, firstTraceArrived, firstMetricArrived, releaseFirstTrace, endpoint: `http://127.0.0.1:${server.address().port}` };
}

function traceIds(received) {
  return received.filter(item => item.path === '/v1/traces')
    .flatMap(item => item.body.resourceSpans ?? [])
    .flatMap(resource => resource.scopeSpans ?? [])
    .flatMap(scope => scope.spans ?? [])
    .map(span => span.traceId);
}

async function requestBurst(telemetry, amount) {
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/work' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    for (let start = 0; start < amount; start += 16) {
      const replies = await Promise.all(Array.from({ length: Math.min(16, amount - start) }, (_, i) => fetch(`${origin}/work?id=${start + i}`)));
      assert(replies.every(reply => reply.status === 200));
    }
  } finally { await new Promise(resolve => app.close(resolve)); }
}

function finishRequestBurst(telemetry, amount) {
  // Queue spans synchronously while the real scheduled export is held. Another
  // network burst could outlast the export timeout before shutdown even starts.
  for (let index = 0; index < amount; index++) {
    const request = Object.assign(new EventEmitter(), { method: 'GET', url: `/work?id=${index}`, headers: {} });
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: true, writableFinished: true });
    telemetry.run(request, response, [{ method: 'GET', path: '/work' }], () => response.emit('finish'));
  }
}

test('healthy shutdown exports every accepted span across multiple batches without outage diagnostics', async () => {
  const sink = await receiver();
  const diagnostics = [];
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'flush-test' }, item => diagnostics.push(item));
  try {
    await requestBurst(telemetry, 96);
    await telemetry.shutdown();
    const ids = traceIds(sink.received);
    assert.equal(ids.length, 96);
    assert.equal(new Set(ids).size, 96);
    assert.deepEqual(diagnostics, []);
  } finally { await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});

test('shutdown drains queued spans while a scheduled trace export is in flight', async () => {
  const sink = await receiver(100, true);
  const diagnostics = [];
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'inflight-flush-test' }, item => diagnostics.push(item));
  try {
    finishRequestBurst(telemetry, 32);
    await sink.firstTraceArrived;
    finishRequestBurst(telemetry, 128);
    const shutdown = telemetry.shutdown();
    sink.releaseFirstTrace();
    await shutdown;
    const ids = traceIds(sink.received);
    assert.equal(ids.length, 160);
    assert.equal(new Set(ids).size, 160);
    assert.deepEqual(diagnostics, []);
  } finally { sink.releaseFirstTrace(); await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});

test('shutdown waits for periodic metrics export before the final collection', async () => {
  const sink = await receiver(250);
  const diagnostics = [];
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'metric-overlap-test', metricsIntervalMs: 1000 }, item => diagnostics.push(item));
  try {
    await sink.firstMetricArrived;
    await telemetry.shutdown();
    assert(sink.received.filter(item => item.path === '/v1/metrics').length >= 2);
    assert.deepEqual(diagnostics, []);
  } finally { await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});
