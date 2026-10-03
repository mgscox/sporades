#!/usr/bin/env node
// Opt-in acceptance against an already running, disposable loopback Compose stack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { parseEnvironment } from '../monitoring/trace/setup.mjs';

const [directoryArg, originArg, project] = process.argv.slice(2);
if (!directoryArg || !originArg || !project || !/^[a-z0-9][a-z0-9-]+$/.test(project)) throw new Error('Use node scripts/verify-sender-credentials.mjs <disposable-stack-dir> <loopback-origin> <compose-project>');
const directory = path.resolve(directoryArg), origin = new URL(originArg);
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Acceptance requires a clean disposable loopback origin.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.SPORADES_ACCEPTANCE_CLI ?? path.join(root, 'bin/sporades.js');
const envPath = path.join(directory, '.env'), before = await readFile(envPath, 'utf8');
const env = parseEnvironment(before);
const uiAuthorization = `Basic ${Buffer.from(`${env.get('TRACE_UI_USER')}:${env.get('TRACE_UI_PASSWORD')}`).toString('base64')}`;
const prefix = `acceptance-${randomBytes(4).toString('hex')}`;
const names = [prefix + '-a', prefix + '-b'];
const hosts = names.map(name => name + '.example');
const handoffs = [];
const checks = [];
const command = (action, ...args) => {
  const result = spawnSync(process.execPath, [cli, 'monitoring', 'sender', action, '--dir', directory, ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, SPORADES_CONFIG_DIR: path.join(directory, '.acceptance-config') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
};
async function handoff(name) {
  const filename = path.join(directory, `${name}-${randomBytes(4).toString('hex')}.env`);
  handoffs.push(filename);
  command('export', '--sender', name, '--out', filename);
  const values = parseEnvironment(await readFile(filename, 'utf8'));
  return { ingest: values.get('TRACE_INGEST_TOKEN'), inventory: values.get('HOST_INVENTORY_TOKEN'), generation: values.get('SPORADES_SENDER_GENERATION') };
}
const request = (url, options) => fetch(new URL(url, origin), { ...options, signal: AbortSignal.timeout(5000) });
const ingest = pair => request('/v1/traces', { method: 'POST', headers: { authorization: `Bearer ${pair.ingest}`, 'content-type': 'application/json' }, body: '{}' });
const inventory = (pair, host, revision) => request(`/v1/inventory/${host}`, { method: 'PUT', headers: { authorization: `Bearer ${pair.inventory}`, 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, host, revision, capsules: [] }) });
async function eventually(check) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Expected stored telemetry did not become queryable.');
}
function restartGateway() {
  const restarted = spawnSync('docker', ['compose', '-p', project, '--project-directory', directory, '--env-file', path.join(directory, '.compose.env'), 'restart', 'gateway'], { encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
}
async function exportAndQuery(pair, phase) {
  const traceId = randomBytes(16).toString('hex');
  const service = `${prefix}-${phase}`;
  process.env.SPORADES_SENDER_ACCEPTANCE_TOKEN = pair.ingest;
  const telemetry = createHttpRequestTelemetry({ endpoint: origin.origin, tls: { mode: origin.protocol === 'http:' ? 'loopback' : 'verified' }, credentialEnv: 'SPORADES_SENDER_ACCEPTANCE_TOKEN', serviceName: service });
  const app = createServer((req, res) => telemetry.run(req, res, [{ method: 'GET', path: '/work' }], () => res.end('ok')));
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/work`, { headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` } })).status, 200);
    await telemetry.shutdown();
  } finally {
    await telemetry.shutdown(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
    delete process.env.SPORADES_SENDER_ACCEPTANCE_TOKEN;
  }
  await eventually(async () => {
    const response = await request(`/api/traces/${traceId}`, { headers: { authorization: uiAuthorization } });
    return response.ok && (await response.json()).data?.some(trace => trace.traceID === traceId);
  });
  await eventually(async () => {
    const query = encodeURIComponent(`http_server_request_count_total{service_name="${service}"}`);
    const response = await request(`/grafana/api/datasources/proxy/uid/sporades-prometheus/api/v1/query?query=${query}`, { headers: { authorization: uiAuthorization } });
    return response.ok && (await response.json()).data?.result?.some(series => Number(series.value[1]) >= 1);
  });
  checks.push(`${phase}: runtime trace stored in Jaeger and request metric stored in Prometheus`);
}
try {
  for (const [index, name] of names.entries()) command('issue', '--sender', name, '--host', hosts[index]);
  const a = await handoff(names[0]), b = await handoff(names[1]);
  await exportAndQuery(a, 'before-rotation');
  assert.equal((await inventory(a, hosts[0], 1)).status, 200);
  assert.equal((await inventory(a, hosts[1], 1)).status, 403);
  for (const route of ['/api/services', '/grafana/api/admin/users']) assert.equal((await request(route, { headers: { authorization: `Bearer ${a.ingest}` } })).status, 401);
  command('rotate', '--sender', names[0]);
  const next = await handoff(names[0]);
  restartGateway();
  await eventually(async () => { try { return (await ingest(a)).status === 200; } catch { return false; } });
  await exportAndQuery(next, 'pending-after-restart');
  assert.equal((await inventory(next, hosts[0], 2)).status, 200);
  command('commit', '--sender', names[0], '--generation', next.generation);
  assert.equal((await ingest(a)).status, 401);
  assert.equal((await inventory(a, hosts[0], 3)).status, 403);
  await exportAndQuery(next, 'committed');
  assert.equal((await inventory(next, hosts[0], 3)).status, 200);
  command('revoke', '--sender', names[0]);
  restartGateway();
  await eventually(async () => { try { return (await ingest(b)).status === 200; } catch { return false; } });
  assert.equal((await ingest(next)).status, 401);
  assert.equal((await inventory(next, hosts[0], 4)).status, 403);
  await exportAndQuery(b, 'unrelated-after-revocation');
  assert.equal((await inventory(b, hosts[1], 1)).status, 200);
  assert.equal(await readFile(envPath, 'utf8'), before);
  checks.push('exact Host scope, dashboard/query denial, old-generation denial, revoked denial, unrelated inventory and exports, env preservation');
  process.stdout.write(JSON.stringify({ verdict: 'pass', topology: 'disposable local Docker Compose plus real Node sender', project, checks }, null, 2) + '\n');
} finally {
  for (const name of names) command('revoke', '--sender', name);
  for (const filename of handoffs) await rm(filename, { force: true });
}
