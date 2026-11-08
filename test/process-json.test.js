import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { waitForProcessJson } from './support/process-json.js';
const child = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });

test('process JSON startup accepts a response split across stream chunks', async () => {
  const process = child(); const ready = waitForProcessJson(process);
  process.stdout.write('\n{"ok":'); process.stdout.write('true}\n');
  assert.deepEqual(await ready, { ok: true });
  assert.equal(process.stdout.listenerCount('data'), 0);
});

test('process JSON startup retains exit diagnostics and removes its listeners', async () => {
  const process = child(); const ready = waitForProcessJson(process);
  process.stderr.write('synthetic startup error'); process.emit('exit', 7);
  await assert.rejects(ready, /exited with 7[\s\S]*synthetic startup error/);
  assert.equal(process.listenerCount('exit'), 0);
});

test('process JSON startup rejects a complete malformed line', async () => {
  const process = child(); const ready = waitForProcessJson(process);
  process.stdout.write('not-json\n');
  await assert.rejects(ready, SyntaxError);
});

test('process JSON startup has a bounded wait and handles spawn errors', async () => {
  const process = child();
  await assert.rejects(waitForProcessJson(process, { timeoutMs: 10 }), /Timed out waiting/);
  const failed = child(); const ready = waitForProcessJson(failed);
  failed.emit('error', new Error('synthetic spawn failure'));
  await assert.rejects(ready, /synthetic spawn failure/);
});
