import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { unixSocketPath } from './support/unix-socket-path.js';

test('long job-backed scratch socket paths work for listeners and child clients', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'socket-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const long = path.join(dir, 'x'.repeat(120));
  await mkdir(long);
  const actual = path.join(long, 'fixture.sock');
  const socketPath = unixSocketPath(actual);
  assert.ok(Buffer.byteLength(socketPath) <= 100);
  const server = createServer(socket => socket.end('job-backed-socket'));
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.ok((await lstat(actual)).isSocket());
  const result = await promisify(execFile)(process.execPath, ['-e', `const net=require('node:net');const s=net.connect(process.argv[1]);s.on('data',data=>process.stdout.write(data));s.on('error',error=>{console.error(error);process.exit(1)});`, socketPath], { timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(result.stdout, 'job-backed-socket');
});
