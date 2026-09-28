import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';

function metrics(batches) { return batches.flatMap(batch => batch.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []); }
function metricPoints(batches, name) { return metrics(batches).filter(metric => metric.name === name).flatMap(metric => metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? []); }
function value(point) { return Number(point?.asDouble ?? point?.asInt); }
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

async function collector() {
  const batches = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/v1/metrics') batches.push(JSON.parse(body));
    response.writeHead(200).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { batches, server, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test('idle event-loop lag does not include the configured sampling interval', async () => {
  const sink = await collector();
  const resolutionMs = 200;
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'idle-pressure-test', metricsIntervalMs: 1000, eventLoopDelayResolutionMs: resolutionMs });
  try {
    await new Promise(resolve => setTimeout(resolve, 3400));
    for (const name of ['process.event_loop.delay.max', 'process.event_loop.delay.mean', 'process.event_loop.delay.p99']) {
      const samples = metricPoints(sink.batches, name).map(value);
      assert(samples.length >= 2, `expected repeated ${name} samples, got ${samples.length}`);
      assert(samples.every(sample => Number.isFinite(sample) && sample >= 0), `${name} must be finite nonnegative milliseconds: ${samples}`);
      assert(median(samples) < 150, `${name} must measure idle lag, not the ${resolutionMs} ms sampling interval: ${samples}`);
      assert.equal(metrics(sink.batches).find(metric => metric.name === name)?.unit, 'ms');
    }
  } finally { await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});

test('a recovered stall crossing collection is retained in exported delay', async () => {
  const sink = await collector();
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'boundary-pressure-test', metricsIntervalMs: 5000, eventLoopDelayResolutionMs: 1000 });
  try {
    await new Promise(resolve => setTimeout(resolve, 2500));
    setTimeout(() => {}, 1);
    const started = performance.now();
    while (performance.now() - started < 3500) { /* finite stall over first export */ }
    await new Promise(resolve => setTimeout(resolve, 6000));
    const max = metricPoints(sink.batches, 'process.event_loop.delay.max').map(value);
    assert(max.some(sample => sample >= 1500), `expected recovered boundary stall >=1500 ms, got ${max}`);
  } finally { await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});

test('shutdown before the first histogram tick does not invent delay', async () => {
  const sink = await collector();
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'early-pressure-test', metricsIntervalMs: 5000, eventLoopDelayResolutionMs: 1000 });
  try {
    await telemetry.shutdown();
    assert(sink.batches.length > 0, 'shutdown exported final metrics');
    for (const name of ['process.event_loop.delay.max', 'process.event_loop.delay.mean', 'process.event_loop.delay.p99']) {
      assert.equal(metricPoints(sink.batches, name).length, 0, `${name} should wait for a real histogram observation`);
    }
  } finally { await telemetry.shutdown(); await new Promise(resolve => sink.server.close(resolve)); }
});

test('finite synchronous blocking is exported as event-loop delay after recovery', async () => {
  const sink = await collector();
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'pressure-test', metricsIntervalMs: 1000, eventLoopDelayResolutionMs: 20 });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const end = Date.now() + 170;
    while (Date.now() < end) { /* finite stall */ }
    await new Promise(resolve => setTimeout(resolve, 1300));
    const max = metricPoints(sink.batches, 'process.event_loop.delay.max');
    assert(max.some(point => value(point) >= 100), `expected recovered delay >=100 ms, got ${max.map(value)}`);
    assert(max.every(point => Number.isFinite(value(point))));
    for (const name of ['process.event_loop.delay.max', 'process.event_loop.delay.mean', 'process.event_loop.delay.p99']) {
      assert.equal(metrics(sink.batches).find(metric => metric.name === name)?.unit, 'ms');
      assert(metricPoints(sink.batches, name).every(point => value(point) >= 0 && Number.isFinite(value(point))));
    }
    const utilization = metricPoints(sink.batches, 'process.event_loop.utilization');
    assert(utilization.length > 0);
    assert.equal(metrics(sink.batches).find(metric => metric.name === 'process.event_loop.utilization')?.unit, '1');
    assert(utilization.every(point => value(point) >= 0 && value(point) <= 1));
  } finally { await telemetry.shutdown(); sink.server.close(); }
});

test('allocation churn exports GC count and duration with bounded kind labels', { skip: typeof global.gc !== 'function' ? 'run with --expose-gc for GC evidence' : false }, async () => {
  const sink = await collector();
  const telemetry = createHttpRequestTelemetry({ endpoint: sink.endpoint, tls: { mode: 'loopback' }, serviceName: 'gc-test', metricsIntervalMs: 1000 });
  try {
    for (let i = 0; i < 12; i++) { const allocation = new Array(100_000).fill(i); assert.equal(allocation.length, 100_000); }
    global.gc();
    await new Promise(resolve => setTimeout(resolve, 1250));
    const count = metricPoints(sink.batches, 'process.gc.count');
    const duration = metricPoints(sink.batches, 'process.gc.duration');
    assert(count.some(point => value(point) > 0), 'real GC count exported');
    assert(duration.some(point => value(point) > 0), 'real GC duration exported');
    assert.equal(metrics(sink.batches).find(metric => metric.name === 'process.gc.count')?.unit, '1');
    assert.equal(metrics(sink.batches).find(metric => metric.name === 'process.gc.duration')?.unit, 's');
    for (const point of [...count, ...duration]) {
      const kind = point.attributes?.find(attribute => attribute.key === 'kind')?.value.stringValue;
      assert(['major', 'minor', 'incremental', 'weakcb', 'other'].includes(kind), `bounded GC kind: ${kind}`);
      assert(Number.isFinite(value(point)) && value(point) >= 0);
    }
  } finally { await telemetry.shutdown(); sink.server.close(); }
});

test('invalid direct runtime precision fails before starting telemetry', () => {
  for (const invalid of [0, 9, 1001, NaN, 20.5]) {
    assert.throws(() => createHttpRequestTelemetry({ endpoint: 'http://127.0.0.1:1', tls: { mode: 'loopback' }, serviceName: 'bad', eventLoopDelayResolutionMs: invalid }), /resolution/);
  }
});
