import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../monitoring/trace/gateway.mjs';

async function fixture(t, tls = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sporades-smoke-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(['smoke.mjs', 'setup.mjs', 'inventory-contract.mjs', 'sender-credentials.mjs'].map(name =>
    copyFile(new URL(`../monitoring/trace/${name}`, import.meta.url), join(directory, name))));
  const cert = join(directory, 'cert.pem');
  const key = join(directory, 'key.pem');
  if (tls) {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const certificate = spawnSync('openssl', ['x509', '-in', cert, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' });
    assert.match(certificate.stdout, /DNS:localhost/);
    assert.doesNotMatch(certificate.stdout, /IP Address:127\.0\.0\.1/);
  }
  const received = [];
  const backend = createServer(async (req, res) => {
    if (req.url === '/v1/traces' || req.url === '/v1/metrics') {
      const body = []; for await (const part of req) body.push(part);
      received.push({ path: req.url, body: Buffer.concat(body).toString() });
      res.writeHead(200).end('{}'); return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/grafana/api/dashboards/uid/sporades-api') res.end('{"dashboard":{"title":"Sporades Capsule API"}}');
    else if (req.url.startsWith('/api/traces/')) res.end('{"data":[{}]}');
    else res.end('{}');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.address().port}`;
  const gateway = createGateway({ ingestToken: 'test-token', uiUser: 'viewer', uiPassword: 'secret', collectorUrl: base, jaegerUrl: base, grafanaUrl: base }, tls ? { cert: await readFile(cert), key: await readFile(key) } : undefined);
  await new Promise(resolve => gateway.listen(0, tls ? '::' : '127.0.0.1', resolve));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); });
  await writeFile(join(directory, '.env'), `TRACE_TLS_MODE=${tls ? 'tls' : 'proxy'}\nTRACE_PORT=${gateway.address().port}\nTRACE_UI_USER=viewer\nTRACE_UI_PASSWORD=secret\nTRACE_INGEST_TOKEN=test-token\n`);
  return { directory, cert, received, origin: `${tls ? 'https://localhost' : 'http://127.0.0.1'}:${gateway.address().port}` };
}

function run(f, action, env = {}, nodeArgs = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...nodeArgs, join(f.directory, 'smoke.mjs'), action, '0123456789abcdef0123456789abcdef'], { env: { ...process.env, ...env }, timeout: 5000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('DNS-only TLS certificate supports trusted send and query at explicit hostname origin', async t => {
  const f = await fixture(t, true);
  const missing = await run(f, 'send', { SMOKE_ORIGIN: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SMOKE_ORIGIN is required in TLS mode/);
  const plain = await run(f, 'send', { SMOKE_ORIGIN: f.origin.replace('https:', 'http:') });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /SMOKE_ORIGIN must use HTTPS/);
  const env = { SMOKE_ORIGIN: f.origin.replace('localhost', 'LOCALHOST'), NODE_EXTRA_CA_CERTS: f.cert };
  const sent = await run(f, 'send', env);
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /Trace query passed/);
  assert.equal(f.received.filter(request => request.path === '/v1/traces' && request.body.includes('smoke-fixture')).length, 1);
  const queried = await run(f, 'query', env);
  assert.equal(queried.status, 0, queried.stderr);
  assert.match(queried.stdout, /Trace query passed/);
  const untrusted = await run(f, 'query', { SMOKE_ORIGIN: f.origin, NODE_EXTRA_CA_CERTS: '' });
  assert.notEqual(untrusted.status, 0);
  assert.match(untrusted.stderr, /fetch failed|certificate|self.signed/i);
});

test('unsafe smoke origins fail before authenticated requests', async t => {
  const f = await fixture(t);
  for (const origin of [`${f.origin}\\path`, `${f.origin}\n`, `${f.origin}\t`, `${f.origin}\r`, `${f.origin} `, 'http://example.com:8443', 'http://localhost.evil:8443', 'ftp://localhost:8443', 'https://viewer:secret@localhost:8443', 'http://127.0.0.1:8443/path', 'http://127.0.0.1:8443?x=1', 'http://127.0.0.1:8443/#fragment', 'http://127.0.0.1:8443/', 'http://viewer:secret@127.0.0.1:8443', 'not-an-origin']) {
    const before = f.received.length;
    const result = await run(f, 'send', { SMOKE_ORIGIN: origin });
    assert.notEqual(result.status, 0, origin);
    assert.match(result.stderr, /SMOKE_ORIGIN/, origin);
    assert.equal(f.received.length, before, origin);
  }
});

test('proxy smoke retains loopback HTTP default', async t => {
  const f = await fixture(t);
  const result = await run(f, 'send', { SMOKE_ORIGIN: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Trace query passed/);
});

test('clean origins accept explicit default ports without contacting another service', async t => {
  const f = await fixture(t);
  const preload = join(f.directory, 'fetch-marker.mjs');
  await writeFile(preload, "globalThis.fetch = async () => { throw new Error('FETCH_MARKER'); };\n");
  for (const [mode, origin] of [['proxy', 'http://LOCALHOST:80'], ['tls', 'https://LOCALHOST:443']]) {
    await writeFile(join(f.directory, '.env'), `TRACE_TLS_MODE=${mode}\nTRACE_PORT=8443\nTRACE_UI_USER=viewer\nTRACE_UI_PASSWORD=secret\nTRACE_INGEST_TOKEN=test-token\n`);
    const result = await run(f, 'send', { SMOKE_ORIGIN: origin }, ['--import', preload]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FETCH_MARKER/, origin);
    assert.doesNotMatch(result.stderr, /SMOKE_ORIGIN/, origin);
  }
});
