import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { unixSocketPath } from './support/unix-socket-path.js';

test('socket fixtures bind and connect inside a deep checkout without leaving it', async t => {
  const root = await mkdtemp(path.resolve('.agent-tmp-socket-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deep = path.join(root, 'checkout-'.repeat(20));
  await mkdir(deep);
  const helper = new URL('./support/unix-socket-path.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { mkdir } from 'node:fs/promises';
    import { createServer, createConnection } from 'node:net';
    import path from 'node:path';
    import { unixSocketPath } from ${JSON.stringify(helper)};
    await mkdir('socket');
    const absolute = path.resolve('socket/clamd.sock');
    assert(Buffer.byteLength(absolute) > 107);
    const socket = unixSocketPath(absolute);
    assert(Buffer.byteLength(socket) <= 100);
    assert.equal(path.resolve(socket), absolute);
    const server = createServer(client => client.end('PONG'));
    try {
      server.listen(socket); await once(server, 'listening');
      const client = createConnection(socket);
      let reply = ''; client.on('data', bytes => reply += bytes);
      await once(client, 'close');
      assert.equal(reply, 'PONG');
    } finally { await new Promise(resolve => server.close(resolve)); }
  `], { cwd: deep, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('short socket paths retain their absolute location', () => {
  assert.equal(unixSocketPath('/tmp/fixture/clamd.sock'), '/tmp/fixture/clamd.sock');
});
