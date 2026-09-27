import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gatewayRunIdentity, setupEnvironment } from '../monitoring/trace/setup.mjs';

test('root Linux setup keeps the gateway non-root; unprivileged setup keeps its owner', () => {
  assert.deepEqual(gatewayRunIdentity('linux', 0, 0), { uid: 1000, gid: 1000, transferOwnership: true });
  assert.deepEqual(gatewayRunIdentity('linux', 1234, 4321), { uid: 1234, gid: 4321, transferOwnership: false });
  assert.deepEqual(gatewayRunIdentity('darwin', 501, 20), { uid: 1000, gid: 1000, transferOwnership: false });
});
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

test('setup preserves literal credential characters for the gateway', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-'));
  const path = join(directory, '.env');
  await writeFile(path, 'TRACE_TLS_MODE=proxy\nTRACE_BIND=127.0.0.1\nTRACE_INGEST_TOKEN=t#1:$TOKEN\nTRACE_UI_USER=viewer\nTRACE_UI_PASSWORD=before$MISSING_after:# space\n');
  await setupEnvironment(path);
  const privateDir = join(directory, '.private');
  assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
  const credentialsPath = join(privateDir, 'credentials.json');
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.deepEqual(credentials, {
    ingestToken: 't#1:$TOKEN', uiUser: 'viewer', uiPassword: 'before$MISSING_after:# space',
  });
  assert.match(await readFile(path, 'utf8'), /TRACE_UI_PASSWORD=before\$MISSING_after:# space/);
  const composeEnvironment = await readFile(join(directory, '.compose.env'), 'utf8');
  assert.doesNotMatch(composeEnvironment, /TRACE_INGEST_TOKEN|TRACE_UI_PASSWORD|TRACE_UI_USER|MISSING_after/);
  assert.match(composeEnvironment, /TRACE_TLS_MODE='proxy'/);
  assert.match(composeEnvironment, /TRACE_RUN_UID=\d+\nTRACE_RUN_GID=\d+/);
});

test('setup decodes a quoted operator value without disclosing malformed input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-'));
  const path = join(directory, '.env');
  await writeFile(path, "TRACE_TLS_MODE=proxy\nTRACE_BIND=127.0.0.1\nTRACE_UI_PASSWORD='Say \\'hi\\' $HOME'\n");
  await setupEnvironment(path);
  assert.equal(JSON.parse(await readFile(join(directory, '.private', 'credentials.json'), 'utf8')).uiPassword, "Say 'hi' $HOME");
  await writeFile(path, "TRACE_UI_PASSWORD='unterminated\n");
  await assert.rejects(setupEnvironment(path), /Invalid quoted value for TRACE_UI_PASSWORD/);
});

test('UI proxy cannot change origin or forward browser cookies', async () => {
  let attackerRequests = 0;
  const attacker = createServer((req, res) => { attackerRequests++; res.end(`SIDE:${req.url}:${req.headers.cookie}`); });
  const jaeger = createServer((req, res) => res.end(`JAEGER:${req.url}:${req.headers.cookie ?? ''}`));
  await Promise.all([new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve)), new Promise(resolve => jaeger.listen(0, '127.0.0.1', resolve))]);
  const gateway = createGateway({ ingestToken: 'token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: 'http://127.0.0.1:1', jaegerUrl: `http://127.0.0.1:${jaeger.address().port}` });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}//127.0.0.1:${attacker.address().port}/probe`, {
      headers: { authorization: `Basic ${Buffer.from('viewer:secret').toString('base64')}`, cookie: 'session=secret' },
    });
    assert.equal(attackerRequests, 0);
    assert.doesNotMatch(await response.text(), /SIDE|session=secret/);
    const normal = await fetch(`http://127.0.0.1:${gateway.address().port}/api/services`, {
      headers: { authorization: `Basic ${Buffer.from('viewer:secret').toString('base64')}`, cookie: 'session=secret' },
    });
    assert.equal(await normal.text(), 'JAEGER:/api/services:');
  } finally {
    gateway.close(); attacker.close(); jaeger.close();
  }
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

test('an interrupted authenticated upload leaves the gateway alive for health and ingestion', async () => {
  const collector = createServer(async (req, res) => { for await (const _ of req) {} res.writeHead(200).end('{}'); });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [new URL('./fixtures/monitoring-gateway-child.mjs', import.meta.url).pathname], {
    env: { ...process.env, TEST_COLLECTOR_URL: `http://127.0.0.1:${collector.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const port = await Promise.race([
      new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(Number(output.trim())); });
        child.once('exit', code => reject(new Error(`gateway exited ${code}: ${stderr}`)));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gateway did not start')), 3000)),
    ]);
    const upload = httpRequest({ hostname: '127.0.0.1', port, path: '/v1/traces', method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', 'content-length': '1000' } });
    upload.on('error', () => {});
    upload.write('{"partial":');
    await new Promise(resolve => upload.once('socket', socket => socket.once('connect', resolve)));
    upload.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ok: false });
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(accepted.status, 200);
    assert.equal(child.exitCode, null, stderr);
  } finally { child.kill(); collector.close(); }
});

test('gateway passes gzip bytes and encoding to Collector but rejects unsupported encoding', async () => {
  const payload = Buffer.from('{"resourceSpans":[]}');
  const compressed = gzipSync(payload);
  let accepted = 0;
  const collector = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['content-encoding'], 'gzip');
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(Buffer.concat(chunks), compressed);
    assert.deepEqual(gunzipSync(Buffer.concat(chunks)), payload);
    accepted++;
    res.writeHead(200).end('{}');
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ ingestToken: 'token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: `http://127.0.0.1:${collector.address().port}`, jaegerUrl: 'http://127.0.0.1:1' });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.address().port}/v1/traces`;
    const headers = { authorization: 'Bearer token', 'content-type': 'application/json', 'content-encoding': 'gzip' };
    assert.equal((await fetch(base, { method: 'POST', headers, body: compressed })).status, 200);
    assert.equal(accepted, 1);
    assert.equal((await fetch(base, { method: 'POST', headers: { ...headers, 'content-encoding': 'br' }, body: compressed })).status, 415);
    assert.equal(accepted, 1);
  } finally { gateway.close(); collector.close(); }
});

test('gateway protects Grafana and requires stored metrics as well as stored traces', async () => {
  let storedReadinessValue;
  const traces = createServer(async (req, res) => {
    if (req.url === '/v1/traces' || req.url === '/v1/metrics') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url === '/v1/metrics') storedReadinessValue = JSON.parse(Buffer.concat(chunks)).resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble;
      res.writeHead(200).end(); return;
    }
    if (req.url.startsWith('/api/traces/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{}] })); return; }
    res.writeHead(404).end();
  });
  const metrics = createServer(async (req, res) => {
    if (req.url === '/v1/metrics') { for await (const _ of req) {} res.writeHead(200).end(); return; }
    if (req.url.startsWith('/api/v1/query')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'success', data: { result: storedReadinessValue === undefined ? [] : [{ value: [Date.now() / 1000, String(storedReadinessValue)] }] } })); return; }
    res.writeHead(404).end();
  });
  const grafana = createServer((req, res) => res.end(`GRAFANA:${req.url}:${req.headers.cookie ?? ''}`));
  await Promise.all([traces, metrics, grafana].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const gateway = createGateway({ ingestToken: 'token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: `http://127.0.0.1:${traces.address().port}`, jaegerUrl: `http://127.0.0.1:${traces.address().port}`, prometheusUrl: `http://127.0.0.1:${metrics.address().port}`, grafanaUrl: `http://127.0.0.1:${grafana.address().port}` });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(`${base}/grafana/`)).status, 401);
    const auth = { authorization: `Basic ${Buffer.from('viewer:secret').toString('base64')}`, cookie: 'private=session' };
    const page = await fetch(`${base}/grafana/d/sporades-api`, { headers: auth });
    assert.equal(await page.text(), 'GRAFANA:/grafana/d/sporades-api:');
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    metrics.close();
    await new Promise(resolve => setTimeout(resolve, 3100));
    const failed = await fetch(`${base}/health`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false });
  } finally { gateway.close(); traces.close(); metrics.close(); grafana.close(); }
});

test('readiness rejects stale readable metrics while writes fail and recovers after a current write', async () => {
  let writesEnabled = false;
  let storedValue = 1;
  const collector = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/metrics') {
      if (writesEnabled) storedValue = JSON.parse(Buffer.concat(chunks)).resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble;
    }
    res.writeHead(200).end();
  });
  const jaeger = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[{}]}'); });
  const prometheus = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { result: [{ value: [Date.now() / 1000, String(storedValue)] }] } }));
  });
  await Promise.all([collector, jaeger, prometheus].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const gateway = createGateway({ ingestToken: 'token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: `http://127.0.0.1:${collector.address().port}`, jaegerUrl: `http://127.0.0.1:${jaeger.address().port}`, prometheusUrl: `http://127.0.0.1:${prometheus.address().port}` });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.address().port}/health`;
    const stale = await fetch(base);
    assert.equal(stale.status, 503);
    assert.deepEqual(await stale.json(), { ok: false });
    writesEnabled = true;
    await new Promise(resolve => setTimeout(resolve, 3100));
    const recovered = await fetch(base);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { ok: true });
    assert.notEqual(storedValue, 1);
  } finally { gateway.close(); collector.close(); jaeger.close(); prometheus.close(); }
});
