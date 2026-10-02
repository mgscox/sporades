import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gatewayRunIdentity, inspectEnvironment, setupEnvironment } from '../monitoring/trace/setup.mjs';

test('copied example generates safe credentials, reports external certificates, and defaults traces to three days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-example-'));
  const path = join(directory, '.env');
  await copyFile(new URL('../monitoring/trace/.env.example', import.meta.url), path);
  assert.deepEqual((await setupEnvironment(path)).missing, ['TRACE_CERT_FILE', 'TRACE_KEY_FILE']);
  const env = await readFile(path, 'utf8');
  assert.match(env, /^TRACE_RETENTION=72h$/m);
  const credentials = await readFile(join(directory, '.private', 'credentials.json'), 'utf8');
  const grafana = await readFile(join(directory, '.private', 'grafana-admin-password'), 'utf8');
  assert.doesNotMatch(credentials + grafana, /REPLACE_WITH_GENERATED_SECRET/);
  assert.match(await readFile(join(directory, '.compose.env'), 'utf8'), /TRACE_RETENTION='72h'/);
});

test('explicit invalid owned credentials fail without publishing private outputs or altering operator env', async () => {
  for (const key of ['TRACE_INGEST_TOKEN', 'TRACE_UI_PASSWORD', 'GRAFANA_ADMIN_PASSWORD']) {
    for (const value of ['REPLACE_WITH_GENERATED_SECRET', '']) {
      const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-placeholder-'));
      const path = join(directory, '.env');
      const source = `TRACE_TLS_MODE=proxy\n${key}=${value}\n`;
      await writeFile(path, source);
      if (value) assert.throws(() => inspectEnvironment(source), new RegExp(key));
      await assert.rejects(setupEnvironment(path), new RegExp(key));
      assert.equal(await readFile(path, 'utf8'), source);
      await assert.rejects(stat(join(directory, '.private', 'credentials.json')), /ENOENT/);
      await assert.rejects(stat(join(directory, '.private', 'grafana-admin-password')), /ENOENT/);
    }
  }
});

test('dashboard regex variables use PromQL raw strings in panels and variable queries', async () => {
  for (const dashboard of ['api-dashboard.json', 'resource-dashboard.json']) {
    const source = JSON.parse(await readFile(new URL(`../monitoring/trace/${dashboard}`, import.meta.url), 'utf8'));
    const expressions = [
      ...source.panels.flatMap(panel => panel.targets.map(target => target.expr)),
      ...source.templating.list.filter(variable => variable.type === 'query').map(variable => variable.query),
    ];
    for (const expression of expressions) {
      for (const variable of ['service', 'environment', 'instance', 'route']) {
        if (expression.includes(`\${${variable}:regex}`)) {
          const label = { route: 'http_route', service: 'service_name', environment: 'deployment_environment_name', instance: 'instance' }[variable];
          assert.ok(expression.includes(`${label}=~` + '`' + `\${${variable}:regex}` + '`'), expression);
        }
      }
    }
  }
});

test('root Linux setup keeps the gateway non-root; unprivileged setup keeps its owner', () => {
  assert.deepEqual(gatewayRunIdentity('linux', 0, 0), { uid: 1000, gid: 1000, transferOwnership: true });
  assert.deepEqual(gatewayRunIdentity('linux', 1234, 4321), { uid: 1234, gid: 4321, transferOwnership: false });
  assert.deepEqual(gatewayRunIdentity('darwin', 501, 20), { uid: 1000, gid: 1000, transferOwnership: false });
});
import { createGateway } from '../monitoring/trace/gateway.mjs';

test('setup preserves operator settings and generates only missing owned credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-trace-'));
  const path = join(directory, '.env');
  await writeFile(path, 'TRACE_TLS_MODE=proxy\nTRACE_BIND=127.0.0.1\nTRACE_RETENTION=48h\nTRACE_INGEST_TOKEN=chosen-token\nOPERATOR_EXTRA=keep-me\n');
  await setupEnvironment(path);
  const first = await readFile(path, 'utf8');
  assert.match(first, /TRACE_INGEST_TOKEN=chosen-token/);
  assert.match(first, /OPERATOR_EXTRA=keep-me/);
  assert.match(first, /^TRACE_RETENTION=48h$/m);
  assert.match(await readFile(join(directory, '.compose.env'), 'utf8'), /TRACE_RETENTION='48h'/);
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
  const jaeger = createServer((req, res) => { res.setHeader('set-cookie', 'backend=private'); res.end(`JAEGER:${req.url}:${req.headers.cookie ?? ''}`); });
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
    assert.equal(normal.headers.get('set-cookie'), null);
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


test('UI gateway child handles slow, stalled, broken, and cancelled responses', async () => {
  const stalledClosed = Promise.withResolvers();
  const streamClosed = Promise.withResolvers();
  const waitForUpstreamClose = async closed => {
    let timer;
    try {
      return await Promise.race([
        closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upstream was not cancelled')), 2000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const backend = createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => res.end('slow success'), 3300); return; }
    if (req.url === '/stall') { res.once('close', () => stalledClosed.resolve(res.writableFinished)); return; }
    if (req.url === '/fail-before') { req.socket.destroy(); return; }
    if (req.url === '/broken') { res.writeHead(200).write('partial'); setTimeout(() => res.destroy(), 40); return; }
    if (req.url === '/stream') { res.writeHead(200).write('part'); res.once('close', () => streamClosed.resolve(res.writableFinished)); return; }
    res.end('still alive');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [new URL('./fixtures/monitoring-gateway-child.mjs', import.meta.url).pathname], {
    env: { ...process.env, TEST_COLLECTOR_URL: 'http://127.0.0.1:1', TEST_UI_URL: `http://127.0.0.1:${backend.address().port}`, TEST_UI_DEADLINE_MS: '5000' },
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
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Basic ${Buffer.from('viewer:secret').toString('base64')}` };
    const slow = await fetch(`${base}/slow`, { headers: auth });
    assert.equal(slow.status, 200);
    assert.equal(await slow.text(), 'slow success');
    assert.equal((await fetch(`${base}/fail-before`, { headers: auth })).status, 502);
    const broken = await fetch(`${base}/broken`, { headers: auth });
    await assert.rejects(broken.text());
    const started = Date.now();
    const stalled = await fetch(`${base}/stall`, { headers: auth });
    assert.equal(stalled.status, 504);
    assert.ok(Date.now() - started < 6000);
    assert.equal(await waitForUpstreamClose(stalledClosed.promise), false, 'stalled upstream response was aborted before completion');
    await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/stream`, { headers: auth }, response => {
        response.once('data', () => { request.destroy(); resolve(); });
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(await waitForUpstreamClose(streamClosed.promise), false, 'streamed upstream response was aborted before completion');
    const alive = await fetch(`${base}/api/services`, { headers: auth });
    assert.equal(alive.status, 200);
    assert.equal(await alive.text(), 'still alive');
    assert.equal(child.exitCode, null, stderr);
  } finally { child.kill(); backend.closeAllConnections(); backend.close(); }
});


test('Resources API p95 excludes aborted requests like the API dashboard', async () => {
  const resource = JSON.parse(await readFile(new URL('../monitoring/trace/resource-dashboard.json', import.meta.url), 'utf8'));
  const api = JSON.parse(await readFile(new URL('../monitoring/trace/api-dashboard.json', import.meta.url), 'utf8'));
  const resourceP95 = resource.panels.find(panel => panel.title === 'API request p95 latency').targets[0].expr;
  const apiP95 = api.panels.find(panel => panel.title === 'p95 request latency').targets[0].expr;
  assert.match(apiP95, /sporades_http_outcome!=\"abort\"/);
  assert.match(resourceP95, /sporades_http_outcome!=\"abort\"/);
});


test('incomplete authenticated UI uploads close their client sockets after deadline or early reply', async () => {
  const backend = createServer((req, res) => {
    if (req.url === '/early') res.end('early');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ ingestToken: 'token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: 'http://127.0.0.1:1', jaegerUrl: `http://127.0.0.1:${backend.address().port}`, uiRequestDeadlineMs: 200 });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  try {
    for (const [path, status] of [['/stall-upload', 504], ['/early', 200]]) {
      const socket = connect(gateway.address().port, '127.0.0.1');
      sockets.push(socket);
      const response = new Promise((resolve, reject) => {
        let data = '';
        socket.on('data', chunk => { data += chunk; });
        socket.once('error', reject);
        socket.once('close', () => resolve(data));
      });
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Basic ${Buffer.from('viewer:secret').toString('base64')}\r\nContent-Length: 1000000\r\n\r\nx`);
      const text = await Promise.race([response, new Promise((_, reject) => setTimeout(() => reject(new Error(`${path} client socket stayed open`)), 900))]);
      assert.match(text, new RegExp(`HTTP/1\.1 ${status} `));
      assert.equal(await new Promise(resolve => gateway.getConnections((error, count) => resolve(error ? -1 : count))), 0);
    }
  } finally {
    sockets.forEach(socket => socket.destroy());
    gateway.closeAllConnections(); backend.closeAllConnections();
    gateway.close(); backend.close();
  }
});
