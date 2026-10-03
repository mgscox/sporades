import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const points = (batches, name) => batches.flatMap(batch => batch.resourceMetrics ?? [])
  .flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? [])
  .filter(metric => metric.name === name).flatMap(metric => (metric.gauge ?? metric.sum).dataPoints);
const value = point => Number(point.asDouble ?? point.asInt);
const label = (point, key) => point.attributes?.find(attribute => attribute.key === key)?.value.stringValue;

test('slow exports saturate a bounded SDK queue, expose loss and recover without blocking business operations', { timeout: 15_000 }, async t => {
  let stalled = true;
  const batches = [];
  const diagnostics = [];
  const sink = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (req.url === '/v1/metrics') { batches.push(JSON.parse(body)); res.end('{}'); }
    else if (!stalled) res.end('{}');
    // Intentionally leave trace replies open past the SDK's export deadline.
  }).listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${sink.address().port}`, tls: { mode: 'loopback' }, serviceName: 'outage-test', metricsIntervalMs: 1000 }, item => diagnostics.push(item));
  t.after(async () => { await telemetry.shutdown(); sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); });
  const started = performance.now();
  let work = 0;
  for (let i = 0; i < 1024; i++) {
    const operation = telemetry.websocket.startOperation('mutation', 'work', true);
    operation.run(() => { work++; });
    operation.end('success');
  }
  assert.equal(work, 1024);
  assert(performance.now() - started < 600, 'business operations do not wait for slow export');
  await pause(1200);
  const capacity = points(batches, 'otel.sdk.processor.span.queue.capacity');
  assert(capacity.length, 'SDK exports its queue capacity');
  assert(capacity.every(point => value(point) === 128));
  const occupancy = points(batches, 'otel.sdk.processor.span.queue.size');
  assert(occupancy.some(point => value(point) > 0));
  assert(occupancy.every(point => value(point) <= 128));
  assert(points(batches, 'otel.sdk.processor.span.processed').some(point => label(point, 'error.type') === 'queue_full' && value(point) >= 864), 'queue saturation loss is counted');
  assert(points(batches, 'sporades.telemetry.export.failure.count').some(point => label(point, 'signal') === 'traces' && value(point) > 0));
  assert(!points(batches, 'sporades.telemetry.export.last_success').some(point => label(point, 'signal') === 'traces'), 'never-successful exports have no healthy zero timestamp');
  stalled = false;
  telemetry.websocket.startOperation('mutation', 'work', true).end('success');
  await pause(1800);
  assert(points(batches, 'sporades.telemetry.export.last_success').some(point => label(point, 'signal') === 'traces' && value(point) > Date.now() / 1000 - 10));
  assert(diagnostics.some(item => item.event === 'telemetry.export.recovered'));
  assert.equal(diagnostics.filter(item => item.event === 'telemetry.export.failed').length, 1, 'failure diagnostics are rate bounded');
  const shutdownAt = performance.now();
  await telemetry.shutdown();
  assert(performance.now() - shutdownAt < 1700);
});

test('repeated telemetry shutdown leaves no periodic exporters or delayed shutdown timers', async () => {
  let requests = 0;
  const sink = createServer(async (req, res) => { for await (const _part of req) {} requests++; res.end('{}'); }).listen(0, '127.0.0.1');
  await once(sink, 'listening');
  try {
    for (let i = 0; i < 5; i++) {
      const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${sink.address().port}`, tls: { mode: 'loopback' }, serviceName: 'restart-test', metricsIntervalMs: 1000 });
      telemetry.websocket.startOperation('mutation', 'work', true).end('success');
      await Promise.all([telemetry.shutdown(), telemetry.shutdown()]);
    }
    const stopped = requests;
    await pause(1200);
    assert.equal(requests, stopped, 'shutdown stops export intervals across repeated restarts');
  } finally { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); }
});
