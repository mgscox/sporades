#!/usr/bin/env node
// Real local Prometheus -> Alertmanager -> webhook evidence, no operator channel.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, rm, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setupEnvironment } from '../monitoring/trace/setup.mjs';
import { createInventoryStore } from '../monitoring/trace/inventory-store.mjs';
import { createAvailabilityServer } from '../monitoring/trace/availability.mjs';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const repo = process.cwd();
const logicalRoot = process.env.PWD && await realpath(process.env.PWD) === repo ? process.env.PWD : repo;
assert([repo, logicalRoot].some(root => process.env.SPORADES_CONFIG_DIR?.startsWith(root + path.sep)), 'Use worktree-local SPORADES_CONFIG_DIR.');
assert(process.env.SPORADES_PROMETHEUS_BIN && process.env.SPORADES_ALERTMANAGER_BIN, 'Supply the pinned local Prometheus and Alertmanager binaries.');
for (const [binary, version] of [[process.env.SPORADES_PROMETHEUS_BIN, '3.13.3'], [process.env.SPORADES_ALERTMANAGER_BIN, '0.34.1']]) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert((result.stdout + result.stderr).includes('version ' + version + ' '), 'Use the pinned version for reproducible delivery evidence.');
}
await mkdir('.sporades/issue-121', { recursive: true });
const directory = await mkdtemp(path.join(repo, '.sporades/issue-121/delivery-'));
const children = [], servers = [], logs = [], deliveries = [];
const evidence = { topology: 'local native Prometheus 3.13.3 + Alertmanager 0.34.1 + generated Node Bundle', policy: 'API errors use starting 5-minute/100-request/5% policy', firing: null, resolved: null };
const port = async () => {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve));
  return value;
};
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server); return server.address().port; };
const wait = async (condition, timeout = 120000) => {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    for (const child of children) assert.equal(child.exitCode, null, 'fixture process exited unexpectedly');
    try { const value = await condition(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Local drill timed out: ' + (lastError?.message ?? 'evidence unavailable'));
};
const start = async (bin, args, name, env = {}) => {
  const log = await open(path.join(directory, name + '.log'), 'a'); logs.push(log);
  const child = spawn(bin, args, { cwd: directory, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] }); children.push(child);
  child.on('error', error => { console.error(name + ': ' + error.message); });
  await once(child, 'spawn');
  return child;
};
try {
  const prometheusPort = await port(), alertPort = await port(), capsulePort = await port();
  const prometheus = `http://127.0.0.1:${prometheusPort}`;
  const notifierPort = await listen(createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    deliveries.push({ ...JSON.parse(body), receivedAt: new Date().toISOString() }); res.end('{}');
  }));
  await writeFile(path.join(directory, '.env'), `TRACE_TLS_MODE=proxy\nMONITORING_PUBLIC_URL=http://127.0.0.1:${prometheusPort}\nALERT_WEBHOOK_URL=http://127.0.0.1:${notifierPort}/alerts\n`);
  await setupEnvironment(path.join(directory, '.env'));
  const inventoryDirectory = path.join(directory, 'inventory'); await mkdir(inventoryDirectory, { mode: 0o700 });
  await createInventoryStore(inventoryDirectory).update({ schemaVersion: 1, host: 'drill-host', revision: 1, capsules: [{ id: 'apps.example/drill', state: 'running', changedAt: new Date().toISOString(), release: 'isolated', targets: [] }] });
  const inventoryPort = await listen(createAvailabilityServer({ inventoryDirectory }));
  // Trace acceptance is deliberately discarded: this drill proves metric-driven
  // warnings, independent of trace sampling/storage and later trace features.
  const ingestPort = await listen(createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url === '/v1/metrics') {
      const result = await fetch(prometheus + '/api/v1/otlp/v1/metrics', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
      res.writeHead(result.status).end(await result.text());
    } else res.end('{}');
  }));
  await writeFile(path.join(directory, 'prometheus.yaml'), JSON.stringify({ global: { scrape_interval: '1s', evaluation_interval: '15s' }, rule_files: [path.join(directory, '.private/performance-rules.yaml')], alerting: { alertmanagers: [{ static_configs: [{ targets: [`127.0.0.1:${alertPort}`] }] }] }, scrape_configs: [{ job_name: 'inventory', static_configs: [{ targets: [`127.0.0.1:${inventoryPort}`] }] }], otlp: { promote_resource_attributes: ['service.name', 'deployment.environment.name'] } }));
  await start(process.env.SPORADES_ALERTMANAGER_BIN, [`--config.file=${directory}/.private/alertmanager.yaml`, `--storage.path=${directory}/alerts`, `--web.listen-address=127.0.0.1:${alertPort}`, '--cluster.listen-address='], 'alertmanager');
  await start(process.env.SPORADES_PROMETHEUS_BIN, [`--config.file=${directory}/prometheus.yaml`, `--storage.tsdb.path=${directory}/metrics`, `--web.listen-address=127.0.0.1:${prometheusPort}`, '--web.enable-otlp-receiver'], 'prometheus');
  await wait(async () => (await fetch(prometheus + '/-/ready')).ok);
  const source = `import {capsule,endpoint} from 'sporades/server'; import {existsSync} from 'node:fs'; export default capsule({name:'performance-drill',endpoints:{work:endpoint({method:'GET',path:'/work'},()=>({status:existsSync('failure')?503:200,body:'isolated'}))}});`;
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource: source, serverSourcePath: path.join(repo, 'server/index.ts') });
  const bundle = await createServerBundleModuleSource({ config: { name: 'performance-drill', __sporadesTelemetry: { endpoint: `http://127.0.0.1:${ingestPort}`, tls: { mode: 'loopback' }, serviceName: 'apps.example/drill', environment: 'hosted', metricsIntervalMs: 1000 } }, serverEnv: {}, serverSource: source, serverModuleSource });
  await writeFile(path.join(directory, 'server.mjs'), bundle);
  await start(process.execPath, ['server.mjs'], 'capsule', { PORT: String(capsulePort), SPORADES_CONFIG_DIR: path.join(directory, 'config') });
  const capsule = `http://127.0.0.1:${capsulePort}`;
  await wait(async () => (await fetch(capsule + '/work')).status === 200);
  // Establish an exported zero/error baseline before degradation.
  const query = async expr => (await (await fetch(prometheus + '/api/v1/query?query=' + encodeURIComponent(expr))).json()).data.result;
  await wait(async () => (await query('http_server_request_count_total{service_name="apps.example/drill"}')).length);
  // Seed a small 5xx series so the later delta is measurable immediately.
  await writeFile(path.join(directory, 'failure'), 'isolated');
  assert.equal((await fetch(capsule + '/work')).status, 503);
  await wait(async () => (await query('http_server_request_count_total{http_response_status_code="5xx"}')).length);
  await Promise.all(Array.from({ length: 150 }, async () => assert.equal((await fetch(capsule + '/work')).status, 503)));
  const find = state => deliveries.find(delivery => delivery.alerts.some(alert => alert.labels.alertname === 'SporadesApiErrors' && alert.status === state));
  const firing = await wait(() => find('firing'));
  const alert = firing.alerts.find(alert => alert.labels.alertname === 'SporadesApiErrors');
  assert.equal(alert.labels.service_name, 'apps.example/drill');
  assert.match(alert.annotations.dashboard, /\/grafana\/d\/sporades-api/);
  assert.match(alert.annotations.fleet, /\/grafana\/d\/sporades-fleet/);
  evidence.firing = firing;
  await rm(path.join(directory, 'failure'));
  // Enough successful traffic drives the actual rolling ratio under 5%; no
  // alert API injection, wall-clock manipulation or rule edits are used.
  for (let batch = 0; batch < 40; batch++) await Promise.all(Array.from({ length: 100 }, async () => assert.equal((await fetch(capsule + '/work')).status, 200)));
  evidence.resolved = await wait(() => find('resolved'));
  assert(!(await query('ALERTS{alertname="SporadesApiErrors",alertstate="firing"}')).length);
  console.log(JSON.stringify({ result: 'passed', firing: evidence.firing.receivedAt, resolved: evidence.resolved.receivedAt, generatedBundle: true }));
} finally {
  await writeFile(path.join(repo, '.sporades/issue-121/delivery-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  for (const child of children.reverse()) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const deadline = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(deadline); }
  }
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const log of logs) await log.close();
  // Preserve local log evidence; no services remain running.
}
