import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const source = `
import { capsule, endpoint, job } from 'sporades/server';
let retries = 0;
export default capsule({ name: 'job-trace-bundle', jobs: {
  record: job(async (_ctx, payload) => { if (payload.kind === 'child') await _ctx.jobs.enqueue('child', {}); if (payload.kind === 'fail' || (payload.kind === 'retry' && retries++ === 0)) throw new Error('exception-private-126'); await new Promise(resolve => setTimeout(resolve, 40)); return 'result-private-126'; }),
  child: job(() => 'child-result-private-126'),
}, endpoints: {
  enqueue: endpoint({ method: 'GET', path: '/enqueue' }, async ctx => ({ status: 200, body: await ctx.privileged.run({ operation: 'test.enqueue', targetResourceKind: 'job-queue' }, p => p.jobs.enqueue('record', { secret: 'payload-private-126', kind: ctx.request.query.kind ?? 'success' }, { retry: { maxAttempts: ctx.request.query.retry ? 2 : ctx.request.query.kind === 'retry' ? 2 : 1, delayMs: 50 }, ...(ctx.request.query.delay ? { availableAt: new Date(Date.now() + Number(ctx.request.query.delay)).toISOString() } : {}) })) })),
  fatal: endpoint({ method: 'GET', path: '/fatal' }, () => { setTimeout(() => { Promise.reject(new Error('isolated fatal fixture')); }, 50); return { status: 200, body: 'triggered' }; }),
  rollback: endpoint({ method: 'GET', path: '/rollback' }, async ctx => { await ctx.privileged.run({ operation: 'test.rollback', targetResourceKind: 'job-queue' }, p => p.jobs.enqueue('record', {})); throw new Error('rollback-private-126'); }),
  state: endpoint({ method: 'GET', path: '/state' }, async ctx => ({ status: 200, body: await ctx.privileged.run({ operation: 'test.inspect', targetResourceKind: 'job-queue' }, p => p.jobs.get(ctx.request.query.id)) })),
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


const metrics = batches => batches.flatMap(batch => batch.resourceMetrics ?? []).flatMap(resource => resource.scopeMetrics ?? []).flatMap(scope => scope.metrics ?? []);
const points = (batches, name) => metrics(batches).filter(metric => metric.name === name).flatMap(metric => (metric.gauge ?? metric.sum ?? metric.histogram)?.dataPoints ?? []);
async function waitForState(app, id, status) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(app.origin + '/state?id=' + id)).json();
    if (state.status === status) return state;
    await pause();
  }
  assert.fail(`Job did not reach ${status}`);
}
async function fixture(t, samplingRatio = 1, serverSource = source) {
  await mkdir(path.join(process.cwd(), '.scratch'), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.scratch', 'job-trace-bundle-'));
  const received = [];
  const forwardingErrors = [];
  let unavailable = false;
  let app;
  const collector = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const part of request) body += part;
      if (unavailable) { response.writeHead(503).end('{}'); return; }
      received.push({ signal: request.url, ...JSON.parse(body) });
      if (process.env.SPORADES_TELEMETRY_TRACE_INGEST_URL) {
        const origin = new URL(process.env.SPORADES_TELEMETRY_TRACE_INGEST_URL);
        assert(['127.0.0.1', 'localhost'].includes(origin.hostname), 'acceptance ingestion must be disposable loopback infrastructure');
        const forwarded = await fetch(new URL(request.url, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        assert.equal(forwarded.status, 200);
      }
      response.end('{}');
    } catch (error) { forwardingErrors.push(error); response.writeHead(500).end('{}'); }
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    await app?.stop();
    await new Promise(resolve => collector.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await once(collector, 'listening');
  const config = { name: 'job-trace-bundle', __sporadesTelemetry: samplingRatio === null ? null : { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'job-trace-bundle', samplingRatio, metricsIntervalMs: 1000 } };
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(process.cwd(), 'server', 'index.ts') });
  await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv: {}, serverSource, serverModuleSource }));
  app = await boot(root, {});
  return {
    received, root, endpoint: `http://127.0.0.1:${collector.address().port}`, dataFile: path.join(root, 'data', 'data.db'),
    get app() { return app; },
    setUnavailable(value) { unavailable = value; },
    enqueue: async (query = '', headers = {}) => (await fetch(app.origin + '/enqueue' + query, { headers })).json(),
    async restart() { await app.stop(); app = await boot(root, {}); },
    async stop() { await app.stop(); assert.deepEqual(forwardingErrors, []); },
  };
}
async function verifyStored(batches) {
  if (!process.env.SPORADES_TELEMETRY_TRACE_QUERY_URL) return;
  const origin = new URL(process.env.SPORADES_TELEMETRY_TRACE_QUERY_URL);
  assert(['127.0.0.1', 'localhost'].includes(origin.hostname), 'acceptance queries must use disposable loopback infrastructure');
  for (const execution of flatten(batches).filter(span => span.name.startsWith('job '))) {
    let stored;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(new URL('/api/v3/traces/' + execution.traceId, origin));
      if (response.ok) {
        const candidate = await response.json();
        stored = flatten([candidate.result ?? candidate]).find(span => span.spanId === execution.spanId);
        if (stored) break;
      }
      await pause();
    }
    assert(stored, 'execution span persisted in Jaeger');
    assert.equal(attribute(stored, 'sporades.job.outcome'), attribute(execution, 'sporades.job.outcome'));
    assert.equal(stored.links?.[0]?.traceId, execution.links?.[0]?.traceId);
    assert.equal(stored.links?.[0]?.spanId, execution.links?.[0]?.spanId);
  }
}

test('generated Capsule exports a distinct linked span for a durable Job execution', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const traceId = randomBytes(16).toString('hex');
  const queued = await f.enqueue('', { traceparent: `00-${traceId}-aaaaaaaaaaaaaaaa-01`, baggage: 'secret=baggage-private-126' });
  await waitForState(f.app, queued.id, 'succeeded');
  await f.stop();
  const spans = flatten(f.received);
  const execution = spans.find(span => span.name === 'job record');
  assert(execution, 'Job execution span exported from the generated Bundle');
  const request = spans.find(span => span.traceId === traceId && span.name === 'GET /enqueue');
  assert.notEqual(execution.traceId, request.traceId);
  assert(!execution.parentSpanId);
  assert.equal(execution.links.length, 1);
  assert.equal(execution.links[0].traceId, request.traceId);
  assert.equal(execution.links[0].spanId, request.spanId);
  assert.equal(attribute(execution, 'sporades.job.outcome'), 'succeeded');
  assert.doesNotMatch(JSON.stringify(f.received), /payload-private-126|result-private-126|baggage-private-126/);
  await verifyStored(f.received);
});

for (const ratio of [1, 0]) {
  test(`durable Job retry, failure and pending queue metrics ignore trace sampling (${ratio})`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, ratio);
    const retry = await f.enqueue('?kind=retry');
    const retried = await waitForState(f.app, retry.id, 'succeeded');
    assert.equal(retried.attempts, 2);
    const failed = await f.enqueue('?kind=fail');
    await waitForState(f.app, failed.id, 'failed');
    const delayed = await f.enqueue('?delay=2400');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert(points(f.received, 'sporades.job.queue.depth').some(point => Number(point.asInt ?? point.asDouble) === 1), 'delayed work contributes to durable pending depth');
    assert(points(f.received, 'sporades.job.queue.oldest_pending_age').some(point => Number(point.asDouble ?? point.asInt) >= 0.5), 'pending age increases even without HTTP traffic');
    await waitForState(f.app, delayed.id, 'succeeded');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert(points(f.received, 'sporades.job.queue.depth').some(point => Number(point.asInt ?? point.asDouble) === 0), 'empty queue reports zero');
    assert(points(f.received, 'sporades.job.retry.count').some(point => Number(point.asInt ?? point.asDouble) === 1));
    assert(points(f.received, 'sporades.job.failure.count').some(point => Number(point.asInt ?? point.asDouble) === 2), 'failed attempts include retried failures');
    assert(points(f.received, 'sporades.job.execution.duration').reduce((sum, point) => sum + Number(point.count), 0) >= 4);
    await f.stop();
    const executions = flatten(f.received).filter(span => span.name === 'job record');

    if (ratio === 1) {
    assert.equal(executions.length, 4);
    assert.equal(new Set(executions.map(span => span.traceId)).size, 4);
    const retries = executions.filter(span => ['retry', 'succeeded'].includes(attribute(span, 'sporades.job.outcome')) && span.links?.[0]?.traceId === executions.find(span => attribute(span, 'sporades.job.outcome') === 'retry').links[0].traceId);
    assert.equal(retries.length, 2);
    assert.deepEqual(retries.map(span => Number(span.attributes.find(item => item.key === 'sporades.job.attempt').value.intValue)).sort(), [1, 2]);
    assert.equal(executions.filter(span => span.status?.code === 2).length, 2);

    } else assert.equal(executions.length, 0);
    assert.doesNotMatch(JSON.stringify(f.received), /payload-private-126|result-private-126|exception-private-126|baggage-private-126/);
    for (const point of metrics(f.received).filter(metric => metric.name.startsWith('sporades.job.')).flatMap(metric => (metric.gauge ?? metric.sum ?? metric.histogram)?.dataPoints ?? [])) {
      assert((point.attributes ?? []).every(item => ['sporades.job.handler', 'sporades.job.outcome'].includes(item.key)));
    }
    await verifyStored(f.received);
  });
}

test('restart recovers delayed Jobs with minimal retained links and accepts legacy or malformed context', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const linked = await f.enqueue('?delay=1500', { baggage: 'secret=baggage-private-126' });
  const legacy = await f.enqueue('?delay=1500');
  const malformed = await f.enqueue('?delay=1500');
  assert.equal((await fetch(f.app.origin + '/rollback')).status, 500);
  await f.stop();
  // Persisted schema is the artifact boundary for additive compatibility/privacy.
  const retained = new DatabaseSync(f.dataFile);
  try {
    const rows = retained.prepare('SELECT id, enqueueTraceContext FROM sporades_jobs').all();
    assert.equal(rows.length, 3, 'rollback leaves no Job or trace context');
    assert(rows.every(row => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(row.enqueueTraceContext)));
    retained.prepare('UPDATE sporades_jobs SET enqueueTraceContext=NULL WHERE id=?').run(legacy.id);
    retained.prepare('UPDATE sporades_jobs SET enqueueTraceContext=? WHERE id=?').run('00-' + '0'.repeat(32) + '-' + 'a'.repeat(16) + '-01 baggage-private-126', malformed.id);
  } finally { retained.close(); }
  await f.restart();
  for (const queued of [linked, legacy, malformed]) {
    const state = await waitForState(f.app, queued.id, 'succeeded');
    assert.equal(state.attempts, 1);
  }
  await f.stop();
  const executions = flatten(f.received).filter(span => span.name === 'job record');
  assert.equal(executions.length, 3);
  assert.equal(executions.filter(span => span.links?.length).length, 1);
  const original = flatten(f.received).find(span => span.name === 'GET /enqueue');
  assert.equal(executions.find(span => span.links?.length).links[0].spanId, original.spanId);
  assert.doesNotMatch(JSON.stringify(f.received), /payload-private-126|result-private-126|baggage-private-126|rollback-private-126/);
  await verifyStored(f.received);
});

test('expired claims recover through a fresh attempt span and count lease retries and failures', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const retrying = await f.enqueue('?delay=60000&retry=1');
  const exhausted = await f.enqueue('?delay=60000');
  await f.stop();
  const retained = new DatabaseSync(f.dataFile);
  try {
    const expired = new Date(Date.now() - 1000).toISOString();
    retained.prepare("UPDATE sporades_jobs SET status='running', attempts=1, startedAt=?, leaseExpiresAt=?, claimToken=? WHERE id IN (?, ?)").run(expired, expired, 'retained-claim-private-126', retrying.id, exhausted.id);
  } finally { retained.close(); }
  await f.restart();
  const recovered = await waitForState(f.app, retrying.id, 'succeeded');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.attemptHistory[0].outcome, 'interrupted');
  await waitForState(f.app, exhausted.id, 'failed');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert(points(f.received, 'sporades.job.retry.count').some(point => Number(point.asInt ?? point.asDouble) === 1));
  assert(points(f.received, 'sporades.job.failure.count').some(point => Number(point.asInt ?? point.asDouble) === 2));
  await f.stop();
  const executions = flatten(f.received).filter(span => span.name === 'job record');
  assert.equal(executions.length, 1, 'recovery does not manufacture a span for the interrupted process');
  assert.equal(Number(executions[0].attributes.find(item => item.key === 'sporades.job.attempt').value.intValue), 2);
  assert.equal(executions[0].links.length, 1);
  assert.doesNotMatch(JSON.stringify(f.received), /retained-claim-private-126|payload-private-126/);
  await verifyStored(f.received);
});

test('CLI Dev executes linked Jobs after startup and server reload', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const cli = path.join(process.cwd(), 'bin', 'sporades.js');
  const configDir = path.join(f.root, 'config');
  await mkdir(configDir, { recursive: true });
  const env = { ...process.env, SPORADES_CONFIG_DIR: configDir };
  await run(process.execPath, [cli, 'create', 'capsule', '--template', 'blank', '--no-install', '--no-git', '--json'], { cwd: f.root, env });
  const project = path.join(f.root, 'capsule');
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(process.cwd(), path.join(project, 'node_modules', 'sporades'), 'dir');
  const serverPath = path.join(project, 'server', 'index.ts');
  await writeFile(serverPath, source);
  await writeFile(path.join(project, "client", "index.tsx"), "document.getElementById('root').textContent = 'Job telemetry fixture';");
  await writeFile(path.join(configDir, 'telemetry.json'), JSON.stringify({ schemaVersion: 1, profiles: {
    local: { endpoint: f.endpoint, tls: { mode: 'loopback' }, metricsIntervalMs: 5000 },
  } }));
  const child = spawn(process.execPath, [cli, 'dev', '--port', '0', '--telemetry', 'local', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  let buffered = '', errors = '';
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  t.after(stop);
  const waitEvent = async predicate => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const event = events.find(predicate);
      if (event) return event;
      assert.equal(child.exitCode, null, errors + JSON.stringify(events));
      await pause();
    }
    assert.fail('CLI event not observed: ' + errors + JSON.stringify(events));
  };
  const started = await waitEvent(event => event.data?.event === 'started');
  const app = { origin: started.data.url };
  const first = await (await fetch(app.origin + '/enqueue')).json();
  await waitForState(app, first.id, 'succeeded');
  await writeFile(serverPath, source + '\n// trigger server reload\n');
  await waitEvent(event => event.data?.event === 'rebuild' && event.data.status === 'success');
  const second = await (await fetch(app.origin + '/enqueue')).json();
  await waitForState(app, second.id, 'succeeded');
  assert.equal((await fetch(app.origin + '/fatal')).status, 200);
  const restarted = await waitEvent(event => event.data?.event === 'restart' && ['success', 'failed'].includes(event.data.status));
  assert.equal(restarted.data.status, 'success', JSON.stringify(restarted));
  const third = await (await fetch(app.origin + '/enqueue')).json();
  await waitForState(app, third.id, 'succeeded');
  await stop(); await f.stop();
  const executions = flatten(f.received).filter(span => span.name === 'job record');
  assert.equal(executions.length, 3, 'Dev provider instruments startup, reload and fatal recovery');
  assert(executions.every(span => span.links?.length === 1));
  assert.notEqual(executions[0].links[0].spanId, executions[1].links[0].spanId);
  await verifyStored(f.received);
});

test('child Jobs link to the executing attempt and collector outages leave retries functional', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  f.setUnavailable(true);
  const retrying = await f.enqueue('?kind=retry');
  assert.equal((await waitForState(f.app, retrying.id, 'succeeded')).attempts, 2);
  // Let the trace and metric exporters encounter the unavailable destination.
  await new Promise(resolve => setTimeout(resolve, 1200));
  f.setUnavailable(false);
  const parent = await f.enqueue('?kind=child');
  await waitForState(f.app, parent.id, 'succeeded');
  await f.stop();
  const spans = flatten(f.received);
  const child = spans.find(span => span.name === 'job child');
  assert(child, 'child attempt exported after telemetry destination recovers');
  const execution = spans.find(span => span.spanId === child.links?.[0]?.spanId);
  assert.equal(execution?.name, 'job record');
  assert.notEqual(child.traceId, execution.traceId);
  assert(!child.parentSpanId);
  assert.doesNotMatch(JSON.stringify(f.received), /payload-private-126|child-result-private-126|exception-private-126/);
  await verifyStored(f.received);
});

test('disabled monitoring leaves durable Jobs functional and persists no enqueue identity', { timeout: 60_000 }, async t => {
  const f = await fixture(t, null);
  const queued = await f.enqueue();
  await waitForState(f.app, queued.id, 'succeeded');
  await f.stop();
  const retained = new DatabaseSync(f.dataFile);
  try { assert.equal(retained.prepare('SELECT enqueueTraceContext FROM sporades_jobs WHERE id=?').get(queued.id).enqueueTraceContext, null); }
  finally { retained.close(); }
  assert.deepEqual(f.received, []);
});

test('pre-context storage upgrades additively and retained Jobs execute without a link', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const queued = await f.enqueue('?delay=1000');
  await f.stop();
  const legacy = new DatabaseSync(f.dataFile);
  try { legacy.exec('ALTER TABLE sporades_jobs DROP COLUMN enqueueTraceContext'); }
  finally { legacy.close(); }
  await f.restart();
  assert.equal((await waitForState(f.app, queued.id, 'succeeded')).attempts, 1);
  await f.stop();
  const executions = flatten(f.received).filter(span => span.name === 'job record');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].links?.length ?? 0, 0);
  const upgraded = new DatabaseSync(f.dataFile);
  try { assert.equal(upgraded.prepare('SELECT enqueueTraceContext FROM sporades_jobs WHERE id=?').get(queued.id).enqueueTraceContext, null); }
  finally { upgraded.close(); }
  await verifyStored(f.received);
});

test('surplus declared Job names collapse to a bounded operation label', { timeout: 60_000 }, async t => {
  const manyJobs = source.replace("jobs: {", "jobs: { ...Object.fromEntries(Array.from({ length: 130 }, (_, i) => ['declared_' + i, job(() => null)])),");
  const f = await fixture(t, 1, manyJobs);
  const queued = await f.enqueue();
  await waitForState(f.app, queued.id, 'succeeded');
  await new Promise(resolve => setTimeout(resolve, 1100));
  await f.stop();
  const execution = flatten(f.received).find(span => span.name === 'job __other');
  assert(execution, 'surplus names have a stable fallback');
  assert.equal(attribute(execution, 'sporades.job.handler'), '__other');
  assert(points(f.received, 'sporades.job.execution.duration').some(point => point.attributes.some(item => item.key === 'sporades.job.handler' && item.value.stringValue === '__other')));
  await verifyStored(f.received);
});
