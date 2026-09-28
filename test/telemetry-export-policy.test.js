import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { createServer as createSecureServer } from 'node:https';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect as connectTls } from 'node:tls';
import { promisify } from 'node:util';

import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';

async function receiver() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const bytes = Buffer.concat(parts);
    const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes;
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(body.toString()) });
    response.writeHead(200).end('{}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` };
}

test('selected profile alone controls OTLP requests and cumulative metrics despite ambient exporter settings', async () => {
  const selected = await receiver();
  const ambient = await receiver();
  const envKeys = [
    'SPORADES_TELEMETRY_POLICY_FIXTURE_TOKEN',
    'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_COMPRESSION', 'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION', 'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
    'OTEL_EXPORTER_OTLP_CERTIFICATE', 'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE', 'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE', 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE', 'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
    'OTEL_EXPORTER_OTLP_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
    'OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT', 'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT',
    'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  ];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  let telemetry;
  let app;
  try {
    process.env.SPORADES_TELEMETRY_POLICY_FIXTURE_TOKEN = 'profile-fixture-token';
    for (const preference of ['delta', 'lowmemory']) {
      selected.requests.length = 0;
      ambient.requests.length = 0;
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-ambient-generic=fixture-only,host=ambient.invalid';
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-ambient-traces=fixture-only,authorization=Bearer%20ambient-traces';
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'x-ambient-metrics=fixture-only,authorization=Bearer%20ambient-metrics';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ambient.origin;
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${ambient.origin}/traces`;
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${ambient.origin}/metrics`;
      process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
      process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION = 'gzip';
      process.env.OTEL_EXPORTER_OTLP_METRICS_COMPRESSION = 'gzip';
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = '/nonexistent/ambient-ca.pem';
      process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = '/nonexistent/ambient-traces-ca.pem';
      process.env.OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE = '/nonexistent/ambient-metrics-ca.pem';
      for (const key of envKeys.filter((key) => key.includes('CLIENT_CERTIFICATE') || key.includes('CLIENT_KEY'))) process.env[key] = '/nonexistent/ambient-client.pem';
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '1';
      process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '1';
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '1';
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = preference;
      const atCreation = { ...process.env };
      telemetry = createHttpRequestTelemetry({ endpoint: selected.origin, tls: { mode: 'loopback' }, credentialEnv: 'SPORADES_TELEMETRY_POLICY_FIXTURE_TOKEN', serviceName: 'export-policy-test' });
      assert.deepEqual({ ...process.env }, atCreation, 'exporter construction preserves ambient environment');

      // A delayed SDK callback must use the snapshot from construction, not these later values.
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-ambient-late=fixture-only,host=late.invalid';
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-ambient-traces-late=fixture-only';
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'x-ambient-metrics-late=fixture-only';
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${ambient.origin}/late-traces`;
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${ambient.origin}/late-metrics`;
      process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = '/nonexistent/late-ca.pem';
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = preference === 'delta' ? 'lowmemory' : 'delta';
      const beforeExport = { ...process.env };
      app = createServer((request, response) => telemetry.run(request, response, [{ method: 'GET', path: '/ok' }], () => response.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
      await once(app, 'listening');
      assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/ok`)).status, 200);
      await telemetry.shutdown();
      telemetry = undefined;
      app.close();
      app = undefined;
      assert.deepEqual({ ...process.env }, beforeExport, 'export preserves ambient environment');
      assert.equal(ambient.requests.length, 0, 'ambient receiver gets no signal');
      assert.deepEqual(new Set(selected.requests.map((request) => request.path)), new Set(['/v1/traces', '/v1/metrics']));
      for (const request of selected.requests) {
        assert.equal(request.headers.authorization, 'Bearer profile-fixture-token');
        assert.equal(request.headers.host, `127.0.0.1:${new URL(selected.origin).port}`);
        assert.equal(request.headers['content-encoding'], undefined);
        assert.equal(Object.keys(request.headers).filter((key) => key.startsWith('x-ambient')).length, 0);
      }
      const metrics = selected.requests.flatMap((request) => request.body.resourceMetrics ?? []).flatMap((resource) => resource.scopeMetrics ?? []).flatMap((scope) => scope.metrics ?? []);
      assert.equal(metrics.find((metric) => metric.name === 'http.server.request.count')?.sum?.aggregationTemporality, 2);
      assert.equal(metrics.find((metric) => metric.name === 'http.server.request.duration')?.histogram?.aggregationTemporality, 2);
    }
    const beforeFailure = { ...process.env };
    assert.throws(() => createHttpRequestTelemetry({ endpoint: selected.origin, tls: { mode: 'loopback' }, serviceName: 'bad-reader', metricsIntervalMs: 0 }));
    assert.deepEqual({ ...process.env }, beforeFailure, 'failed construction preserves ambient environment');
  } finally {
    if (telemetry) await telemetry.shutdown();
    app?.closeAllConnections();
    app?.close();
    selected.server.closeAllConnections();
    selected.server.close();
    ambient.server.closeAllConnections();
    ambient.server.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('verified profile rejects an untrusted collector even when Node ambient TLS verification is disabled', async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), 'sporades-telemetry-tls-policy-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  let collector;
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    let accepted = 0;
    collector = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      for await (const _ of request) { /* drain */ }
      accepted += 1;
      response.writeHead(200).end('{}');
    }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const moduleUrl = new URL('../dist/runtime-telemetry.js', import.meta.url).href;
    const child = `import { createHttpRequestTelemetry } from ${JSON.stringify(moduleUrl)};
      const events = [];
      const denied = createHttpRequestTelemetry({ endpoint: process.argv[1], tls: { mode: 'verified' }, serviceName: 'tls-policy-test' }, event => events.push(event));
      await denied.shutdown();
      const trusted = createHttpRequestTelemetry({ endpoint: process.argv[1], tls: { mode: 'verified', caFile: process.argv[2] }, serviceName: 'tls-policy-test' }, event => events.push(event));
      await trusted.shutdown();
      console.log(JSON.stringify(events));`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', child, `https://127.0.0.1:${collector.address().port}`, cert], {
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', OTEL_EXPORTER_OTLP_CERTIFICATE: '/nonexistent/ambient-ca.pem' },
      timeout: 10_000,
    });
    const events = JSON.parse(stdout.trim());
    assert(events.some(event => event.event === 'telemetry.export.failed' && event.reason === 'TLS_FAILED'));
    assert.equal(events.some(event => event.event === 'telemetry.export.failed' && event.reason !== 'TLS_FAILED'), false);
    assert.equal(accepted, 1, 'only the explicitly trusted export reaches the collector');
  } finally {
    collector?.closeAllConnections();
    collector?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CA-issued leaf chain reports bounded TLS failure without trust and exports with explicit CA trust', async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), 'sporades-telemetry-ca-chain-'));
  let collector;
  try {
    const caKey = path.join(dir, 'ca.key');
    const caCert = path.join(dir, 'ca.pem');
    const leafKey = path.join(dir, 'leaf.key');
    const leafCsr = path.join(dir, 'leaf.csr');
    const leafCert = path.join(dir, 'leaf.pem');
    const extension = path.join(dir, 'leaf.ext');
    await writeFile(extension, 'subjectAltName=IP:127.0.0.1\n');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '1', '-subj', '/CN=Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
    await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', leafCsr, '-subj', '/CN=127.0.0.1']);
    await run('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', leafCert, '-days', '1', '-extfile', extension]);
    const accepted = [];
    collector = createSecureServer({ key: await readFile(leafKey), cert: Buffer.concat([await readFile(leafCert), await readFile(caCert)]) }, async (request, response) => {
      for await (const _ of request) { /* drain */ }
      accepted.push(request.url);
      response.writeHead(200).end('{}');
    }).listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const endpoint = `https://127.0.0.1:${collector.address().port}`;
    const socketCode = await new Promise(resolve => {
      const socket = connectTls({ host: '127.0.0.1', port: collector.address().port });
      socket.once('error', error => { socket.destroy(); resolve(error.code); });
    });
    assert(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(socketCode), `Unexpected pinned Node trust failure: ${socketCode}`);
    const diagnostic = [];
    const denied = createHttpRequestTelemetry({ endpoint, tls: { mode: 'verified' }, serviceName: 'chain-denied' }, event => diagnostic.push(event));
    await denied.shutdown();
    assert.deepEqual(diagnostic, [{ event: 'telemetry.export.failed', reason: 'TLS_FAILED' }]);
    assert.deepEqual(accepted, []);
    const trusted = createHttpRequestTelemetry({ endpoint, tls: { mode: 'verified', caFile: caCert }, serviceName: 'chain-trusted' }, event => diagnostic.push(event));
    await trusted.shutdown();
    assert.deepEqual(new Set(accepted), new Set(['/v1/metrics']));
    assert.deepEqual(diagnostic, [{ event: 'telemetry.export.failed', reason: 'TLS_FAILED' }]);
  } finally {
    collector?.closeAllConnections();
    collector?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
