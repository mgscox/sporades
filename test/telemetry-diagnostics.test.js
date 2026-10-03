import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGateway } from '../monitoring/trace/gateway.mjs';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('operator diagnostic lookup returns only exact probe visibility and denies ingestion authority', async t => {
  const id = '0123456789abcdef0123456789abcdef';
  let backendCalls = 0;
  let operation = 'sporades.host.relay.check';
  const backend = await listen(t, createServer((req, res) => {
    backendCalls++;
    res.end(JSON.stringify({ data: [{ traceID: id, spans: [{ traceID: id, operationName: operation, startTime: Date.now() * 1000 }], private: 'never-return-this' }] }));
  }));
  const origin = await listen(t, createGateway({ ingestToken: 'ingestion-only', uiUser: 'operator', uiPassword: 'query-secret', jaegerUrl: backend }));
  const url = `${origin}/v1/diagnostics/traces/${id}`;
  const denied = await fetch(url, { headers: { authorization: 'Bearer ingestion-only' } });
  assert.equal(denied.status, 401);
  assert.equal(backendCalls, 0);
  const headers = { authorization: `Basic ${Buffer.from('operator:query-secret').toString('base64')}` };
  const visible = await fetch(url, { headers });
  assert.equal(visible.status, 200);
  assert.deepEqual(await visible.json(), { ok: true, data: { queryVisible: true, recent: true } });
  operation = 'private.application.operation';
  assert.deepEqual(await (await fetch(url, { headers })).json(), { ok: true, data: { queryVisible: false, recent: false } });
  const invalid = await fetch(`${url}?query=all`, { headers });
  assert.equal(invalid.status, 400);
  assert.equal(backendCalls, 2);
});

test('operator lookup distinguishes stale storage, missing data, malformed backend and wrong authority', async t => {
  const id = '11111111111111111111111111111111';
  let mode = 'stale';
  const backend = await listen(t, createServer((req, res) => {
    if (mode === 'malformed') { res.end('backend-private-secret{'); return; }
    if (mode === 'missing') { res.writeHead(404).end(); return; }
    res.end(JSON.stringify({ data: [{ traceID: id, spans: [{ traceID: id, operationName: 'sporades.host.relay.check', startTime: (Date.now() - 300000) * 1000 }] }] }));
  }));
  const origin = await listen(t, createGateway({ ingestToken: 'token', uiUser: 'operator', uiPassword: 'password', jaegerUrl: backend }));
  const url = `${origin}/v1/diagnostics/traces/${id}`;
  const headers = { authorization: `Basic ${Buffer.from('operator:password').toString('base64')}` };
  assert.equal((await fetch(url, { headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` } })).status, 401);
  assert.deepEqual(await (await fetch(url, { headers })).json(), { ok: true, data: { queryVisible: true, recent: false } });
  mode = 'missing';
  assert.deepEqual(await (await fetch(url, { headers })).json(), { ok: true, data: { queryVisible: false, recent: false } });
  mode = 'malformed';
  const malformed = await fetch(url, { headers });
  assert.equal(malformed.status, 503);
  assert.doesNotMatch(await malformed.text(), /backend-private-secret/);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
});
