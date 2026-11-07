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
