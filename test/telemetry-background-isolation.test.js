import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { createRuntimeClock } from '../dist/jobs-runtime.js';
import { createLogEnvelope, openDevDatabase, runMutation } from '../dist/server-runtime-source.js';
import { job, mutation } from '../dist/server.js';

const actor = { userId: 'worker-user', displayName: 'Worker User', email: null, picture: null, isAuthenticated: false, isGuest: true, provider: 'anonymous' };
const envelope = (message, extras = {}) => createLogEnvelope({ config: { name: 'identity-isolation' }, category: 'platform', event: message, message, ...extras });

for (const enabled of [false, true]) {
  test(`real Job timers keep background logs detached while request B overlaps (telemetry ${enabled ? 'on' : 'off'})`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sporades-telemetry-job-isolation-'));
    const clock = { now: () => new Date(), setTimer: (callback, delay) => setTimeout(callback, Math.max(delay, 40)), clearTimer: clearTimeout };
    const logs = [];
    const collector = createServer(async (request, response) => { for await (const _ of request) {} response.writeHead(200).end(); }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const telemetry = createHttpRequestTelemetry(enabled ? { endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName: 'identity-isolation' } : undefined);
    const database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: 'identity-isolation' }, {
      jobs: { record: job((_ctx, payload) => { logs.push(envelope(`job-${payload.id}`)); }) },
      mutations: { enqueue: mutation((ctx, id) => ctx.jobs.enqueue('record', { id })) },
    }, { clock });
    await database.init();
    // Startup's empty queue scan must settle so request A schedules the next worker.
    const startupDeadline = Date.now() + 2000;
    while ((database.__jobWorkerScheduled || database.__jobWorkerRunning) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(database.__jobWorkerScheduled || database.__jobWorkerRunning, false, 'startup queue scan settled');
    database.adapter.prepare('INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(actor.userId, clock.now().toISOString(), actor.displayName, null, null, 0, 1, 'anonymous');
    let releaseB;
    const holdB = new Promise(resolve => { releaseB = resolve; });
    let enteredB;
    const bEntered = new Promise(resolve => { enteredB = resolve; });
    const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/enqueue' }, { method: 'GET', path: '/hold' }], async () => {
      if (request.url === '/enqueue') {
        logs.push(envelope('request-A'));
        const result = await runMutation(database, actor, 'enqueue', ['A']);
        assert.equal(result.ok, true);
        response.end('queued');
      } else {
        logs.push(envelope('request-B-start'));
        enteredB();
        await holdB;
        logs.push(envelope('request-B-end'));
        response.end('done');
      }
    })).listen(0, '127.0.0.1');
    await once(app, 'listening');
    try {
      const origin = `http://127.0.0.1:${app.address().port}`;
      assert.equal(await (await fetch(`${origin}/enqueue`)).text(), 'queued');
      const pendingB = fetch(`${origin}/hold`).then(response => response.text());
      await bEntered;
      const deadline = Date.now() + 2000;
      while (!logs.some(log => log.message === 'job-A') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(logs.some(log => log.message === 'job-A'), 'real Job worker ran while request B was active');
      releaseB();
      assert.equal(await pendingB, 'done');
      const byMessage = Object.fromEntries(logs.map(log => [log.message, log]));
      assert.equal(byMessage['job-A'].request, null);
      assert.equal(byMessage['job-A'].traceId, null);
      assert.equal(byMessage['job-A'].spanId, null);
      assert.match(byMessage['request-A'].request.id, /^[0-9a-f-]{36}$/);
      assert.match(byMessage['request-B-start'].request.id, /^[0-9a-f-]{36}$/);
      assert.notEqual(byMessage['request-A'].request.id, byMessage['request-B-start'].request.id);
      assert.equal(byMessage['request-B-start'].request.id, byMessage['request-B-end'].request.id);
      if (enabled) assert.notEqual(byMessage['request-A'].traceId, byMessage['request-B-start'].traceId);
    } finally {
      releaseB();
      await telemetry.shutdown();
      await new Promise(resolve => app.close(resolve));
      await new Promise(resolve => collector.close(resolve));
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('export failure and recovery use uncorrelated durable platform log envelopes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sporades-telemetry-diagnostic-isolation-'));
  const database = await openDevDatabase(path.join(dir, 'data.db'), '', {}, { name: 'diagnostic-isolation' }, {});
  await database.init();
  let status = 401;
  const collector = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.writeHead(status).end('private collector response');
  }).listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const telemetry = createHttpRequestTelemetry({
    endpoint: `http://127.0.0.1:${collector.address().port}`,
    tls: { mode: 'loopback' }, serviceName: 'diagnostic-isolation',
  }, diagnostic => database.log.emit({
    category: 'platform', event: diagnostic.event,
    level: diagnostic.event === 'telemetry.export.failed' ? 'warn' : 'info',
    message: diagnostic.event === 'telemetry.export.failed' ? 'Telemetry export failed' : 'Telemetry export recovered',
    data: diagnostic.event === 'telemetry.export.failed' ? { reason: diagnostic.reason } : null,
  }));
  const app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/work' }], () => {
    database.log.emit({ category: 'app', event: 'ctx.log', level: 'info', message: 'active request' });
    response.end('ok');
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const drive = async () => assert.equal(await (await fetch(`http://127.0.0.1:${app.address().port}/work`)).text(), 'ok');
    const waitFor = async (event) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const found = database.log.tail(100).find(log => log.event === event);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`expected ${event} in durable JSONL`);
    };
    await drive();
    const failed = await waitFor('telemetry.export.failed');
    status = 200;
    await drive();
    const recovered = await waitFor('telemetry.export.recovered');
    const active = database.log.tail(100).filter(log => log.event === 'ctx.log');
    assert.equal(active.length, 2);
    assert(active.every(log => log.request?.id));
    assert(active.every(log => log.traceId));
    assert.notEqual(active[0].request.id, active[1].request.id);
    for (const diagnostic of [failed, recovered]) {
      assert.equal(diagnostic.request, null);
      assert.equal(diagnostic.traceId, null);
      assert.equal(diagnostic.spanId, null);
      assert.equal(diagnostic.correlation, null);
    }
    assert.deepEqual(failed.data, { reason: 'AUTH_REJECTED' });
    assert.equal(recovered.data, null);
    assert.doesNotMatch(JSON.stringify([failed, recovered]), /private collector response/);
  } finally {
    await telemetry.shutdown();
    await new Promise(resolve => app.close(resolve));
    await new Promise(resolve => collector.close(resolve));
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('injected clock timer rearming detaches request identity without changing handles or explicit metadata', async () => {
  class StatefulClock {
    #instant = new Date('2030-01-01T00:00:00.000Z');
    #timers = new Map();
    #nextHandle = 1;
    now() { return new Date(this.#instant); }
    setTimer(callback, delay) {
      const handle = this.#nextHandle++;
      this.#timers.set(handle, { callback, delay });
      return handle;
    }
    clearTimer(handle) { this.#timers.delete(handle); }
    timer(handle) { return this.#timers.get(handle); }
    fire(handle) {
      const timer = this.#timers.get(handle);
      this.#timers.delete(handle);
      timer.callback();
    }
  }
  const source = new StatefulClock();
  const clock = createRuntimeClock(source);
  assert.equal(clock.now().toISOString(), '2030-01-01T00:00:00.000Z');
  const telemetry = createHttpRequestTelemetry();
  const logs = [];
  let firstHandle;
  let secondHandle;
  const app = createServer((request, response) => telemetry.run(request, response, [], () => {
    if (request.url === '/A') {
      logs.push(envelope('A'));
      firstHandle = clock.setTimer(() => {
        logs.push(envelope('first-background'));
        secondHandle = clock.setTimer(() => logs.push(envelope('second-background', {
          request: { id: 'explicit-job-request' }, correlation: { id: 'explicit-job-correlation' },
        })), 25);
      }, 10);
      response.end('scheduled');
    } else {
      logs.push(envelope('B-before'));
      source.fire(firstHandle);
      assert.equal(source.timer(secondHandle).delay, 25);
      source.fire(secondHandle);
      logs.push(envelope('B-after'));
      response.end('ran');
    }
  })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    assert.equal(await (await fetch(`${origin}/A`)).text(), 'scheduled');
    assert.equal(source.timer(firstHandle).delay, 10);
    assert.equal(await (await fetch(`${origin}/B`)).text(), 'ran');
    const byMessage = Object.fromEntries(logs.map(log => [log.message, log]));
    assert.equal(byMessage['first-background'].request, null);
    assert.equal(byMessage['second-background'].request.id, 'explicit-job-request');
    assert.deepEqual(byMessage['second-background'].correlation, { id: 'explicit-job-correlation' });
    assert.equal(byMessage['B-before'].request.id, byMessage['B-after'].request.id);
    assert.notEqual(byMessage.A.request.id, byMessage['B-before'].request.id);
    const cancelledHandle = clock.setTimer(() => assert.fail('cancelled timer fired'), 30);
    assert.equal(source.timer(cancelledHandle).delay, 30);
    clock.clearTimer(cancelledHandle);
    assert.equal(source.timer(cancelledHandle), undefined);
  } finally {
    await telemetry.shutdown();
    await new Promise(resolve => app.close(resolve));
  }
});

test('a frozen injected clock keeps its runtime methods and exact timer handle', () => {
  const callbacks = new Map();
  const source = Object.freeze({
    now() { return new Date('2030-01-01T00:00:00.000Z'); },
    setTimer(callback, delay) { callbacks.set(41, { callback, delay }); return 41; },
    clearTimer(handle) { callbacks.delete(handle); },
  });
  const clock = createRuntimeClock(source);
  assert.equal(clock.now().toISOString(), '2030-01-01T00:00:00.000Z');
  const handle = clock.setTimer(() => {}, 25);
  assert.equal(handle, 41);
  assert.equal(callbacks.get(handle).delay, 25);
  clock.clearTimer(handle);
  assert.equal(callbacks.size, 0);
});
