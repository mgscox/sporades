import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupEnvironment } from '../monitoring/trace/setup.mjs';
import { createGateway } from '../monitoring/trace/gateway.mjs';

test('setup preserves operator settings and generates only missing owned credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-'));
  const path = join(directory, '.env');
  await writeFile(path, 'TRACE_TLS_MODE=proxy\nTRACE_BIND=127.0.0.1\nTRACE_INGEST_TOKEN=chosen-token\nOPERATOR_EXTRA=keep-me\n');
  await setupEnvironment(path);
  const first = await readFile(path, 'utf8');
  assert.match(first, /TRACE_INGEST_TOKEN=chosen-token/);
  assert.match(first, /OPERATOR_EXTRA=keep-me/);
  assert.match(first, /TRACE_UI_PASSWORD=[^\n]+/);
  await setupEnvironment(path);
  assert.equal(await readFile(path, 'utf8'), first);
});

test('setup reports only missing external key names and refuses public plain HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-'));
  const path = join(directory, '.env');
  assert.deepEqual((await setupEnvironment(path)).missing, ['TRACE_CERT_FILE', 'TRACE_KEY_FILE']);
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace('TRACE_BIND=127.0.0.1', 'TRACE_BIND=0.0.0.0').replace('TRACE_TLS_MODE=tls', 'TRACE_TLS_MODE=proxy'));
  await assert.rejects(setupEnvironment(path), /TRACE_BIND must be loopback/);
});

test('gateway rejects bad ingestion credentials and hides backend failures on health', async () => {
  const gateway = createGateway({
    ingestToken: 'good-token', uiUser: 'viewer', uiPassword: 'secret',
    collectorUrl: 'http://127.0.0.1:1', jaegerUrl: 'http://127.0.0.1:1',
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    const denied = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { authorization: 'Bearer bad' }, body: '{}' });
    assert.equal(denied.status, 401);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ok: false });
    assert.equal(health.headers.get('content-type'), 'application/json');
    assert.equal((await fetch(base)).status, 401);
  } finally {
    gateway.close();
  }
});
