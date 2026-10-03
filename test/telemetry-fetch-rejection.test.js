import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundFetchTelemetry } from '../dist/runtime-fetch-telemetry.js';

// Exercise real native fetch rejection semantics through the shipped boundary.
// The recording tracer observes classification without an exporter or network wait.
function boundary() {
  const spans = [];
  const context = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 };
  const parent = { spanContext: () => context };
  const tracer = { startSpan(_name, options) {
    const record = { attributes: { ...options.attributes }, ended: false };
    spans.push(record);
    return {
      spanContext: () => context,
      setAttribute(key, value) { record.attributes[key] = value; },
      setStatus(status) { record.status = status; },
      end() { record.ended = true; },
    };
  } };
  const invoke = outboundFetchTelemetry(tracer, parent, new Set(['http://127.0.0.1:1']), () => true);
  return { spans, async reject(init) {
    let nativeError, nativeInit;
    const original = async (input, options) => {
      nativeInit = options;
      try { return await fetch(input, options); }
      catch (error) { nativeError = error; throw error; }
    };
    const actual = await invoke(original, 'http://127.0.0.1:1', init).then(
      () => assert.fail('Expected native rejection'), error => error);
    assert.equal(actual, nativeError, 'the exact native rejection is returned');
    return { error: actual, nativeInit };
  } };
}

test('unsupported signals preserve native evaluation and are delegated unchanged', async () => {
  for (const make of [
    counter => ({ get aborted() { counter.reads++; return true; } }),
    counter => new Proxy({}, { get(_target, key) { if (key === 'aborted') counter.reads++; } }),
  ]) {
    const counter = { reads: 0 };
    const init = { redirect: 'manual', signal: make(counter) };
    const expected = await fetch('http://127.0.0.1:1', init).then(() => assert.fail('Expected rejection'), error => error);
    const nativeReads = counter.reads;
    counter.reads = 0;
    const observed = boundary();
    const { error, nativeInit } = await observed.reject(init);
    assert.equal(counter.reads, nativeReads, 'instrumentation adds no getter evaluations');
    assert.equal(error.constructor, expected.constructor);
    assert.equal(error.message, expected.message);
    assert.equal(nativeInit, init, 'unsupported signals receive no carrier facade');
    assert.equal(observed.spans.length, 0);
  }
});

test('caller abort-reason getters are opaque and cannot turn cancellation into timeout', async () => {
  for (const make of [
    () => ({}),
    () => new DOMException('private-cancellation', 'AbortError'),
  ]) {
    let reads = 0;
    const reason = make();
    Object.defineProperty(reason, 'name', { get() { reads++; return 'TimeoutError'; } });
    const controller = new AbortController();
    controller.abort(reason);
    const init = { redirect: 'manual', signal: controller.signal };
    const expected = await fetch('http://127.0.0.1:1', init).then(() => assert.fail('Expected rejection'), error => error);
    assert.equal(expected, reason);
    assert.equal(reads, 0, 'native fetch never reads the reason name');
    const observed = boundary();
    const { error } = await observed.reject(init);
    assert.equal(error, reason);
    assert.equal(reads, 0, 'instrumentation never reads the reason name');
    assert.equal(observed.spans[0].attributes['sporades.http.outcome'], 'cancelled');
    assert.equal(observed.spans[0].ended, true);
  }
});

test('native timeout classification uses intrinsic state despite shadowed getters', async () => {
  const signal = AbortSignal.timeout(1);
  // AbortSignal.timeout alone does not keep Node alive.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, true);
  const reason = signal.reason;
  let reads = 0;
  Object.defineProperty(reason, 'name', { get() { reads++; return 'AbortError'; } });
  const observed = boundary();
  const { error } = await observed.reject({ redirect: 'manual', signal });
  assert.equal(error, reason);
  assert.equal(reads, 0);
  assert.equal(observed.spans[0].attributes['sporades.http.outcome'], 'timeout');
  assert.equal(observed.spans[0].ended, true);
});

test('modified and composite native signals are delegated without extra getter reads', async () => {
  for (const make of [
    (controller, counter) => Object.defineProperty(controller.signal, 'aborted', {
      get() { counter.reads++; return true; },
    }),
    controller => AbortSignal.any([controller.signal]),
  ]) {
    const nativeCounter = { reads: 0 }, wrappedCounter = { reads: 0 };
    const nativeController = new AbortController(), wrappedController = new AbortController();
    const reason = new Error('private-cancellation');
    nativeController.abort(reason); wrappedController.abort(reason);
    const nativeInit = { redirect: 'manual', signal: make(nativeController, nativeCounter) };
    const wrappedInit = { redirect: 'manual', signal: make(wrappedController, wrappedCounter) };
    const expected = await fetch('http://127.0.0.1:1', nativeInit).then(() => assert.fail('Expected rejection'), error => error);
    const observed = boundary();
    const actual = await observed.reject(wrappedInit);
    assert.equal(actual.error, expected);
    assert.equal(wrappedCounter.reads, nativeCounter.reads);
    assert.equal(actual.nativeInit, wrappedInit);
    assert.equal(observed.spans.length, 0);
  }
});

test('signal accessors added during pending rejection receive no extra evaluations', async () => {
  for (const slot of ['kAborted', 'kReason']) {
    const make = () => {
      const controller = new AbortController();
      const reason = new Error('private-cancellation');
      controller.abort(reason);
      const signal = controller.signal;
      const key = Object.getOwnPropertySymbols(signal).find(key => key.description === slot);
      assert(key, 'supported Node native signal state slot exists');
      const value = Object.getOwnPropertyDescriptor(signal, key).value;
      let reads = 0;
      return {
        init: { redirect: 'manual', signal }, reason, reads: () => reads,
        mutate: () => Object.defineProperty(signal, key, { get() { reads++; return value; } }),
      };
    };
    const native = make();
    const nativeRejection = fetch('http://127.0.0.1:1', native.init).catch(error => error);
    queueMicrotask(native.mutate);
    assert.equal(await nativeRejection, native.reason);
    assert.equal(native.reads(), 0);
    const wrapped = make(), observed = boundary();
    const rejection = observed.reject(wrapped.init);
    queueMicrotask(wrapped.mutate);
    assert.equal((await rejection).error, wrapped.reason);
    assert.equal(wrapped.reads(), native.reads());
    assert.equal(observed.spans[0].ended, true);
  }
});
