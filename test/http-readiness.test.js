import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { waitForHttp } from './support/http-readiness.js';

test('HTTP readiness deadline stops at headers and allows the caller to read a slow body', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200).flushHeaders();
    setTimeout(() => response.end('ready'), 1200);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await waitForHttp(`http://127.0.0.1:${server.address().port}`, { exitCode: null });
  assert.equal(await response.text(), 'ready');
});
