import assert from 'node:assert/strict';
import test from 'node:test';
import { readSocketMessage, waitForSocketMessage } from './support/dev-fixture.js';

const emit = (socket, message) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));

test('sequential fixture reads preserve frames delivered in the same event-loop turn', async () => {
  const socket = new EventTarget();
  const first = readSocketMessage(socket);
  emit(socket, { id: 'mutation', error: null });
  emit(socket, { id: 'query', data: ['retained'] });
  assert.equal((await first).id, 'mutation');
  const second = readSocketMessage(socket);
  try {
    assert.deepEqual(await Promise.race([second, new Promise(resolve => setTimeout(() => resolve('message lost'), 100))]), { id: 'query', data: ['retained'] });
  } finally {
    second.catch(() => {});
    socket.dispatchEvent(new Event('error'));
  }
});

test('fixture predicates and sequential readers consume their own responses', async () => {
  const socket = new EventTarget();
  const query = waitForSocketMessage(socket, message => message.id === 'query');
  const mutation = readSocketMessage(socket);
  emit(socket, { id: 'mutation' });
  emit(socket, { id: 'query' });
  assert.equal((await mutation).id, 'mutation');
  assert.equal((await query).id, 'query');
});


test('a new outgoing request discards unrelated buffered updates from the prior request', async () => {
  const socket = new EventTarget();
  socket.send = () => {};
  const first = readSocketMessage(socket);
  emit(socket, { id: 'mutation' });
  emit(socket, { id: 'old-subscription-update' });
  await first;
  socket.send(JSON.stringify({ id: 'upload-url' }));
  const next = readSocketMessage(socket);
  emit(socket, { id: 'upload-url', url: '/private/file' });
  assert.deepEqual(await next, { id: 'upload-url', url: '/private/file' });
});


test('predicate reads retain an update coalesced with the preceding mutation response', async () => {
  const socket = new EventTarget();
  const first = readSocketMessage(socket);
  emit(socket, { id: 'mutation' });
  emit(socket, { id: 'query', rows: ['new'] });
  await first;
  assert.deepEqual(await waitForSocketMessage(socket, message => message.id === 'query'), { id: 'query', rows: ['new'] });
});

test('arming a predicate before send does not replay a preceding request update', async () => {
  const socket = new EventTarget();
  socket.send = () => emit(socket, { id: 'query', rows: ['new'] });
  const first = readSocketMessage(socket);
  emit(socket, { id: 'mutation' });
  emit(socket, { id: 'query', rows: ['old'] });
  await first;
  const next = waitForSocketMessage(socket, message => message.id === 'query');
  socket.send('next-request');
  assert.deepEqual(await next, { id: 'query', rows: ['new'] });
});

test('the fixture close waiter accepts an already closed socket', async () => {
  const { waitForSocketClose } = await import('./support/dev-fixture.js');
  const socket = new EventTarget();
  socket.readyState = WebSocket.CLOSED;
  const closed = waitForSocketClose(socket);
  try {
    assert.equal(await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]), true);
  } finally { socket.dispatchEvent(new Event('close')); }
});

test('fixture message waits report a closed socket immediately', async () => {
  const socket = new EventTarget();
  const waiting = readSocketMessage(socket);
  const closed = new Event('close');
  Object.defineProperty(closed, 'code', { value: 1008 });
  socket.dispatchEvent(closed);
  try {
    const result = await Promise.race([waiting.then(() => 'resolved', error => error.message), new Promise(resolve => setTimeout(() => resolve('still waiting'), 100))]);
    assert.match(result, /closed.*1008/i);
  } finally { socket.dispatchEvent(new Event('error')); }
});

test('the fixture retains a protocol frame coalesced with the socket open event', async () => {
  const { openSocket } = await import('./support/dev-fixture.js');
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class OpeningSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => { this.dispatchEvent(new Event('open')); emit(this, { id: 'first-packet' }); });
    }
    send() {}
  }
  globalThis.fetch = async () => new Response('window.__SPORADES_CONNECTION_TOKEN="synthetic"');
  globalThis.WebSocket = OpeningSocket;
  try {
    socket = await openSocket('http://127.0.0.1:9/');
    const message = readSocketMessage(socket).then(value => value.id, error => error.message);
    assert.equal(await Promise.race([message, new Promise(resolve => setTimeout(() => resolve('message lost'), 100))]), 'first-packet');
  } finally {
    socket?.dispatchEvent(new Event('error'));
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('fixture reads retain buffered protocol frames after the socket closes', async () => {
  const socket = new EventTarget();
  const first = readSocketMessage(socket);
  emit(socket, { id: 'mutation' });
  emit(socket, { id: 'query' });
  socket.dispatchEvent(new Event('close'));
  assert.equal((await first).id, 'mutation');
  assert.equal((await readSocketMessage(socket)).id, 'query');
  await assert.rejects(readSocketMessage(socket), /closed before expected message/);
});
