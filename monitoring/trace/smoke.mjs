#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const env = new Map((await readFile(new URL('./.env', import.meta.url), 'utf8')).split(/\r?\n/).flatMap(line => {
  const match = line.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
  return match ? [[match[1], match[2]]] : [];
}));
const origin = `${env.get('TRACE_TLS_MODE') === 'tls' ? 'https' : 'http'}://127.0.0.1:${env.get('TRACE_PORT') ?? 8443}`;
const authorization = `Basic ${Buffer.from(`${env.get('TRACE_UI_USER')}:${env.get('TRACE_UI_PASSWORD')}`).toString('base64')}`;
const traceId = process.argv[3] ?? randomBytes(16).toString('hex');
const probe = async () => {
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await fetch(`${origin}/api/services`)).status, 401);
  const denied = await fetch(`${origin}/v1/traces`, { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
};
const query = async () => {
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await fetch(`${origin}/api/traces/${traceId}`, { headers: { authorization } });
    if (response.ok && (await response.json()).data?.length) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Trace was not queryable');
};

await probe();
if (process.argv[2] === 'send') {
  const now = String(BigInt(Date.now()) * 1000000n);
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sporades-trace-smoke' } }] }, scopeSpans: [{ spans: [{ traceId, spanId: randomBytes(8).toString('hex'), name: 'smoke-fixture', startTimeUnixNano: now, endTimeUnixNano: now }] }] }] });
  const response = await fetch(`${origin}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${env.get('TRACE_INGEST_TOKEN')}`, 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
} else if (process.argv[2] !== 'query') throw new Error('Usage: node smoke.mjs send | query TRACE_ID');
await query();
process.stdout.write(`Trace query passed: ${traceId}\n`);
