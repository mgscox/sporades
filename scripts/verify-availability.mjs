#!/usr/bin/env node
// Disposable local Docker acceptance. No production endpoints or profiles.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { setupEnvironment, parseEnvironment } from '../monitoring/trace/setup.mjs';
const run = promisify(execFile);
const repo = process.cwd();
assert(process.env.SPORADES_CONFIG_DIR?.startsWith(repo + path.sep), 'Use worktree-local SPORADES_CONFIG_DIR.');
await mkdir('.sporades/issue-120', { recursive: true });
const directory = await mkdtemp(path.join(repo, '.sporades/issue-120/acceptance-'));
const project = `barbara120-${randomBytes(4).toString('hex')}`;
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const compose = async (...args) => (await run('docker', ['compose', '--env-file', '.compose.env', ...args], { cwd: directory, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const until = async (callback, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await callback(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error('Acceptance deadline exceeded.');
};
let launched = false;
try {
  await cp(path.join(repo, 'monitoring/trace'), directory, { recursive: true });
  await mkdir(path.join(directory, 'fixture'));
  await writeFile(path.join(directory, '.env'), `TRACE_TLS_MODE=proxy\nTRACE_PORT=5691\nTRACE_BIND=127.0.0.1\nINVENTORY_HOSTS='{"test-host":"${randomBytes(24).toString('hex')}"}'\nALERT_WEBHOOK_URL=http://127.0.0.1:5689/alerts\nMONITORING_PUBLIC_URL=http://127.0.0.1:5691\n`);
  await setupEnvironment(path.join(directory, '.env'));
  const settings = parseEnvironment(await readFile(path.join(directory, '.env'), 'utf8'));
  const capsuleSource = `import { capsule, endpoint } from 'sporades/server'; export default capsule({name:'availability-drill',endpoints:{ block:endpoint({method:'GET',path:'/block'},async()=>{const end=Date.now()+100000; while(Date.now()<end){}; return {status:200,body:'recovered'};})}});`;
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource: capsuleSource, serverSourcePath: path.join(repo, 'server/index.ts') });
  const bundle = await createServerBundleModuleSource({ config: { name: 'availability-drill', __sporadesTelemetry: { endpoint: 'http://sporades-telemetry:4318/', tls: { mode: 'loopback' }, serviceName: 'apps.example/demo', environment: 'hosted', metricsIntervalMs: 5000 } }, serverEnv: {}, serverSource: capsuleSource, serverModuleSource });
  await writeFile(path.join(directory, 'fixture/server.mjs'), bundle);
  await writeFile(path.join(directory, 'fixture/notifier.mjs'), `import { createServer } from 'node:http'; import { appendFileSync } from 'node:fs'; createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;appendFileSync('/fixture/deliveries.jsonl',body+'\\n');res.writeHead(200).end();}).listen(5689,'127.0.0.1');`);
  await writeFile(path.join(directory, 'fixture/cached.mjs'), `import {createServer} from 'node:http';createServer((req,res)=>{res.writeHead(200,{'cache-control':'no-store'});res.end('sporades-application-probe-v1:'+ '0'.repeat(32)+'\\n');}).listen(80);`);
  await writeFile(path.join(directory, 'compose.override.yaml'), `services:\n  collector:\n    networks:\n      default:\n        aliases: [sporades-telemetry]\n  capsule:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/server.mjs]\n    working_dir: /data\n    environment:\n      PORT: '80'\n      SPORADES_RUNTIME_PROBE_TOKEN: '${randomBytes(32).toString('hex')}'\n      SPORADES_CONFIG_DIR: /data/config\n    volumes: ['./fixture:/fixture:ro']\n    tmpfs: [/data]\n    networks:\n      default:\n        aliases: [demo.apps.example]\n    ports: ['127.0.0.1:5692:80']\n  cached:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/cached.mjs]\n    volumes: ['./fixture:/fixture:ro']\n    networks:\n      default:\n        aliases: [cached.apps.example]\n  notifier:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/notifier.mjs]\n    network_mode: service:alertmanager\n    volumes: ['./fixture:/fixture']\n`);
  await run('docker', ['run', '--rm', '--name', project + '-rules', '--entrypoint', 'promtool', '-v', repo + ':/workspace:ro', '-w', '/workspace/test/fixtures', 'prom/prometheus:v3.13.3', 'test', 'rules', 'availability-rules.test.yaml'], { timeout: 30_000 });
  launched = true;
  await compose('up', '-d', '--build');
  const origin = 'http://127.0.0.1:5691';
  const auth = `Bearer ${JSON.parse(settings.get('INVENTORY_HOSTS'))['test-host']}`;
  const inventory = { schemaVersion: 1, host: 'test-host', revision: 1, capsules: [{ id: 'apps.example/demo', state: 'running', changedAt: new Date().toISOString(), release: 'drill', targets: ['http://demo.apps.example/'] }] };
  const put = async value => assert.equal((await fetch(origin + '/v1/inventory/test-host', { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(value) })).status, 200);
  await until(async () => (await fetch(origin + '/health')).ok);
  assert.equal((await fetch('http://127.0.0.1:5692/__sporades/health/runtime')).status, 404);
  await put(inventory);
  await compose('exec', '-T', 'prometheus', 'promtool', 'check', 'rules', '/etc/prometheus/availability-rules.yaml');
  await compose('exec', '-T', 'alertmanager', 'amtool', 'check-config', '/etc/alertmanager/alertmanager.yaml');
  const query = async expression => JSON.parse(await compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', `console.log(await(await fetch('http://prometheus:9090/api/v1/query?query='+encodeURIComponent(${JSON.stringify(expression)}))).text())`)).data.result;
  await until(async () => (await query('probe_success{job="capsule-probes"}')).some(item => item.value[1] === '1'));
  assert((await query('process_uptime_seconds{service_name="apps.example/demo"}')).length, 'real runtime metrics stored');
  const stale = await compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', `const groups=await(await fetch('http://gateway:9091/targets')).json(); const url=new URL(groups[0].targets[0]);url.hostname='cached.apps.example'; console.log(await(await fetch('http://blackbox:9115/probe?module='+groups[0].labels.__param_module+'&target='+encodeURIComponent(url.href))).text());`);
  assert.match(stale, /probe_success 0/);
  const readDeliveries = async () => (await readFile(path.join(directory, 'fixture/deliveries.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const began = Date.now();
  // A finite synchronous loop; failure ends on its own without production impact.
  const block = fetch('http://127.0.0.1:5692/block', { signal: AbortSignal.timeout(115_000) }).catch(() => null);
  const firing = await until(async () => (await readDeliveries()).find(item => item.alerts.some(alert => alert.labels.alertname === 'SporadesProbeFailure' && alert.status === 'firing')), 120_000);
  const elapsed = Date.now() - began;
  assert(elapsed <= 120_000);
  const alert = firing.alerts.find(alert => alert.labels.alertname === 'SporadesProbeFailure');
  assert.match(alert.annotations.dashboard, /from=now-15m/);
  assert.equal(alert.annotations.target, 'http://demo.apps.example/');
  await block;
  await until(async () => (await readDeliveries()).find(item => item.alerts.some(alert => alert.labels.alertname === 'SporadesProbeFailure' && alert.status === 'resolved')), 60_000);
  // Stopping below is deliberately out-of-band. It cannot acknowledge intent.
  await compose('stop', 'capsule');
  await until(async () => (await query('ALERTS{alertname="SporadesCapsuleTelemetryAbsent",alertstate="firing"}')).length, 160_000);
  assert((await query('sporades_expected_capsule')).length, 'Host loss preserves expectation');
  await put({ ...inventory, revision: 2, capsules: [{ ...inventory.capsules[0], state: 'stopped', targets: [] }] });
  await until(async () => !(await query('sporades_expected_capsule')).length, 45_000);
  await writeFile(path.join(repo, '.sporades/issue-120/docker-evidence.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), project, topology: 'single Docker Desktop Linux VM; not separate-VM acceptance', probeNotificationMs: elapsed, realWebhookFiringAndRecovery: true, runtimeTelemetryAbsence: true, acknowledgedStopRemovedExpectation: true }, null, 2) + '\n');
  console.log(`Availability Docker acceptance passed: probe notification in ${elapsed} ms, recovery and absence observed.`);
} finally {
  if (launched) await compose('down', '--volumes', '--remove-orphans', '--rmi', 'local');
  await rm(directory, { recursive: true, force: true });
}
