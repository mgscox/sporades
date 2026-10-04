#!/usr/bin/env node
// Disposable local Docker acceptance. No production endpoints or profiles.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { waitForEvidence, findProbeFiring, assertNotificationDeadline } from './availability-drill-timing.mjs';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { setupEnvironment, parseEnvironment } from '../monitoring/trace/setup.mjs';
import { verifyAvailabilityRules } from './availability-rule-preflight.mjs';
const run = promisify(execFile);
const repo = process.cwd();
assert(process.env.SPORADES_CONFIG_DIR?.startsWith(repo + path.sep), 'Use worktree-local SPORADES_CONFIG_DIR.');
await mkdir('.sporades/issue-120', { recursive: true });
const directory = await mkdtemp(path.join(repo, '.sporades/issue-120/acceptance-'));
const project = `barbara120-${randomBytes(4).toString('hex')}`;
const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
const capsuleId = `${domain}/${'n'.repeat(62)}a`;
const siblingId = `${domain}/${'n'.repeat(62)}b`;
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const compose = async (...args) => (await run('docker', ['compose', '--env-file', '.compose.env', ...args], { cwd: directory, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const until = (callback, timeoutMs = 120_000) => waitForEvidence(callback, { timeoutMs });
const notificationTimeline = { project, events: [] };
const timelineFile = `.sporades/issue-120/${project}-notification-timeline.json`;
let launched = false;
try {
  await cp(path.join(repo, 'monitoring/trace'), directory, { recursive: true });
  await mkdir(path.join(directory, 'fixture'));
  await mkdir(path.join(directory, 'evidence'));
  await writeFile(path.join(directory, '.env'), `TRACE_TLS_MODE=proxy\nTRACE_PORT=5691\nTRACE_BIND=127.0.0.1\nINVENTORY_HOSTS='{"test-host":"${randomBytes(24).toString('hex')}"}'\nALERT_WEBHOOK_URL=http://127.0.0.1:5689/alerts\nMONITORING_PUBLIC_URL=http://127.0.0.1:5691\n`);
  await setupEnvironment(path.join(directory, '.env'));
  const settings = parseEnvironment(await readFile(path.join(directory, '.env'), 'utf8'));
  const capsuleSource = `import { capsule, endpoint } from 'sporades/server'; import {writeFileSync} from 'node:fs'; export default capsule({name:'availability-drill',endpoints:{ block:endpoint({method:'GET',path:'/block'},async()=>{const began=process.hrtime.bigint(); writeFileSync('/evidence/blocked.json',JSON.stringify({atNs:began.toString(),unixAtMs:Date.now()})); const end=began+100000000000n; while(process.hrtime.bigint()<end){}; writeFileSync('/evidence/recovered.json',JSON.stringify({atNs:process.hrtime.bigint().toString(),unixAtMs:Date.now()})); return {status:200,body:'recovered'};})}});`;
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource: capsuleSource, serverSourcePath: path.join(repo, 'server/index.ts') });
  const makeBundle = serviceName => createServerBundleModuleSource({ config: { name: 'availability-drill', __sporadesTelemetry: { endpoint: 'http://sporades-telemetry:4318/', tls: { mode: 'loopback' }, serviceName, environment: 'hosted', metricsIntervalMs: 5000 } }, serverEnv: {}, serverSource: capsuleSource, serverModuleSource });
  const bundle = await makeBundle(capsuleId);
  await writeFile(path.join(directory, 'fixture/server.mjs'), bundle);
  await writeFile(path.join(directory, 'fixture/sibling.mjs'), await makeBundle(siblingId));
  await writeFile(path.join(directory, 'fixture/notifier.mjs'), `import { createServer } from 'node:http'; import { appendFileSync } from 'node:fs'; createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const receivedAtNs=process.hrtime.bigint().toString();appendFileSync('/evidence/deliveries.jsonl',JSON.stringify({...JSON.parse(body),receivedAtNs,receivedUnixMs:Date.now()})+'\\n');res.writeHead(200).end();}).listen(5689,'127.0.0.1');`);
  await writeFile(path.join(directory, 'fixture/cached.mjs'), `import {createServer} from 'node:http';createServer((req,res)=>{res.writeHead(200,{'cache-control':'no-store'});res.end('sporades-application-probe-v1:'+ '0'.repeat(32)+'\\n');}).listen(80);`);
  await writeFile(path.join(directory, 'compose.override.yaml'), `services:\n  collector:\n    networks:\n      default:\n        aliases: [sporades-telemetry]\n  capsule:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/server.mjs]\n    working_dir: /data\n    environment:\n      PORT: '80'\n      SPORADES_RUNTIME_PROBE_TOKEN: '${randomBytes(32).toString('hex')}'\n      SPORADES_CONFIG_DIR: /data/config\n    volumes: ['./fixture:/fixture:ro', './evidence:/evidence']\n    tmpfs: [/data]\n    networks:\n      default:\n        aliases: [demo.apps.example]\n    ports: ['127.0.0.1:5692:80']\n  cached:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/cached.mjs]\n    volumes: ['./fixture:/fixture:ro']\n    networks:\n      default:\n        aliases: [cached.apps.example]\n  notifier:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/notifier.mjs]\n    network_mode: service:alertmanager\n    volumes: ['./fixture:/fixture:ro', './evidence:/evidence']\n`);
  await writeFile(path.join(directory, 'compose.override.yaml'), `  sibling:\n    image: node:24.13.0-alpine3.23\n    command: [node, /fixture/sibling.mjs]\n    working_dir: /data\n    environment:\n      PORT: '80'\n      SPORADES_CONFIG_DIR: /data/config\n    volumes: ['./fixture:/fixture:ro', './evidence:/evidence']\n    tmpfs: [/data]\n`, { flag: 'a' });
  await verifyAvailabilityRules({ run, repo, project });
  notificationTimeline.events.push({ phase: 'rule-preflight', result: 'passed' });
  launched = true;
  await compose('up', '-d', '--build');
  const origin = 'http://127.0.0.1:5691';
  const auth = `Bearer ${JSON.parse(settings.get('INVENTORY_HOSTS'))['test-host']}`;
  const inventory = { schemaVersion: 1, host: 'test-host', revision: 1, capsules: [
    { id: capsuleId, state: 'running', changedAt: new Date().toISOString(), release: 'drill', targets: ['http://demo.apps.example/'] },
    { id: siblingId, state: 'running', changedAt: new Date().toISOString(), release: 'drill', targets: [] },
  ] };
  const put = async value => assert.equal((await fetch(origin + '/v1/inventory/test-host', { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(value) })).status, 200);
  await until(async () => (await fetch(origin + '/health')).ok);
  assert.equal((await fetch('http://127.0.0.1:5692/__sporades/health/runtime')).status, 404);
  await put(inventory);
  await compose('exec', '-T', 'prometheus', 'promtool', 'check', 'rules', '/etc/prometheus/availability-rules.yaml');
  await compose('exec', '-T', 'prometheus', 'promtool', 'check', 'rules', '/etc/prometheus/performance-rules.yaml');
  await compose('exec', '-T', 'alertmanager', 'amtool', 'check-config', '/etc/alertmanager/alertmanager.yaml');
  const query = async expression => JSON.parse(await compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', `console.log(await(await fetch('http://prometheus:9090/api/v1/query?query='+encodeURIComponent(${JSON.stringify(expression)}))).text())`)).data.result;
  await until(async () => (await query('probe_success{job="capsule-probes"}')).some(item => item.value[1] === '1'));
  for (const id of [capsuleId, siblingId]) await until(async () => (await query(`process_uptime_seconds{service_name="${id}"}`)).length);
  const acknowledgedAt = performance.now();
  const stale = await compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', `const groups=await(await fetch('http://gateway:9091/targets')).json(); const url=new URL(groups[0].targets[0]);url.hostname='cached.apps.example'; console.log(await(await fetch('http://blackbox:9115/probe?module='+groups[0].labels.__param_module+'&target='+encodeURIComponent(url.href))).text());`);
  assert.match(stale, /probe_success 0/);
  const readDeliveries = async () => (await readFile(path.join(directory, 'evidence/deliveries.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  // Ensure the rule has observed the healthy target, rather than inheriting
  // bootstrap pending state as part of the drill's failure window.
  await until(async () => !(await query('ALERTS{alertname="SporadesProbeFailure"}')).length);
  const observerBegan = performance.now();
  let lastSnapshot = -Infinity;
  const captureState = async () => {
    const observedAtMs = performance.now() - observerBegan;
    if (observedAtMs - lastSnapshot < 5000) return;
    lastSnapshot = observedAtMs;
    const expressions = ['probe_success{job="capsule-probes"}', 'up{job="capsule-probes"}', 'ALERTS{alertname="SporadesProbeFailure"}', 'ALERTS_FOR_STATE{alertname="SporadesProbeFailure"}'];
    const source = `const expressions=${JSON.stringify(expressions)};const samples=await Promise.all(expressions.map(async expression=>({expression,result:(await(await fetch('http://prometheus:9090/api/v1/query?query='+encodeURIComponent(expression))).json()).data.result})));const alerts=await(await fetch('http://alertmanager:9093/alertmanager/api/v2/alerts')).json();console.log(JSON.stringify({samples,alerts:alerts.filter(alert=>alert.labels.alertname==='SporadesProbeFailure').map(({startsAt,endsAt,updatedAt,status})=>({startsAt,endsAt,updatedAt,status}))}));`;
    try { notificationTimeline.events.push({ observedAtMs, ...JSON.parse(await compose('exec', '-T', 'gateway', 'node', '--input-type=module', '-e', source)) }); }
    catch { notificationTimeline.events.push({ observedAtMs, diagnosticUnavailable: true }); }
  };
  // A finite synchronous loop; failure ends on its own without production impact.
  const block = fetch('http://127.0.0.1:5692/block', { signal: AbortSignal.timeout(115_000) }).catch(() => null);
  const blocked = await until(async () => JSON.parse(await readFile(path.join(directory, 'evidence/blocked.json'), 'utf8')), 15_000);
  notificationTimeline.blocked = blocked;
  notificationTimeline.blockedAtNs = blocked.atNs;
  const firing = await until(async () => {
    await captureState();
    return findProbeFiring(await readDeliveries(), blocked.atNs);
  }, 125_000);
  // Five seconds of observer grace cannot turn a late delivery into a pass:
  // the 120-second assertion uses recorded same-VM monotonic event timestamps.
  const elapsed = assertNotificationDeadline(blocked.atNs, firing.receivedAtNs);
  notificationTimeline.firingReceivedAtNs = firing.receivedAtNs;
  notificationTimeline.notificationMs = elapsed;
  lastSnapshot = -Infinity;
  await captureState();
  const alert = firing.alerts.find(alert => alert.labels.alertname === 'SporadesProbeFailure');
  assert.match(alert.annotations.dashboard, /from=now-15m/);
  assert.equal(alert.annotations.target, 'http://demo.apps.example/');
  await block;
  await until(async () => (await readDeliveries()).find(item => item.alerts.some(alert => alert.labels.alertname === 'SporadesProbeFailure' && alert.status === 'resolved')), 60_000);
  await until(() => performance.now() - acknowledgedAt >= 130_000, 140_000);
  assert.equal((await query('ALERTS{alertname="SporadesCapsuleTelemetryAbsent",alertstate="firing"}')).length, 0, 'healthy maximum-length identities do not alert after the grace window');
  // Stopping below is deliberately out-of-band. It cannot acknowledge intent.
  await compose('stop', 'capsule');
  await until(async () => (await query('ALERTS{alertname="SporadesCapsuleTelemetryAbsent",alertstate="firing"}')).some(item => item.metric.service_name === capsuleId), 160_000);
  assert((await query(`process_uptime_seconds{service_name="${siblingId}"}`)).length, 'healthy prefix sibling keeps exporting');
  assert.equal((await query(`ALERTS{alertname="SporadesCapsuleTelemetryAbsent",alertstate="firing",service_name="${siblingId}"}`)).length, 0);
  assert((await query('sporades_expected_capsule')).length, 'Host loss preserves expectation');
  await put({ ...inventory, revision: 2, capsules: inventory.capsules.map(capsule => ({ ...capsule, state: 'stopped', targets: [] })) });
  await until(async () => !(await query('sporades_expected_capsule')).length, 45_000);
  await writeFile(path.join(repo, '.sporades/issue-120/docker-evidence.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), project, topology: 'single Linux Docker host; not separate-VM acceptance', probeNotificationMs: elapsed, notificationTimeline: timelineFile, realWebhookFiringAndRecovery: true, maximumLengthIdentity: capsuleId.length, healthySharedPrefixIdentities: true, runtimeTelemetryAbsence: true, acknowledgedStopRemovedExpectation: true }, null, 2) + '\n');
  console.log(`Availability Docker acceptance passed: probe notification in ${elapsed} ms, recovery and absence observed.`);
} catch (error) {
  notificationTimeline.failure = error.message;
  if (typeof error.code === 'string' && error.code.startsWith('AVAILABILITY_RULE_PREFLIGHT_')) notificationTimeline.events.push({ phase: 'rule-preflight', result: 'failed', code: error.code });
  throw error;
} finally {
  for (const [key, file] of [['recovered', 'recovered.json'], ['deliveries', 'deliveries.jsonl']]) {
    try { const data = await readFile(path.join(directory, 'evidence', file), 'utf8'); notificationTimeline[key] = key === 'deliveries' ? data.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(data); } catch {}
  }
  try {
    await writeFile(path.join(repo, timelineFile), JSON.stringify(notificationTimeline, null, 2) + '\n');
  } finally {
    try { if (launched) await compose('down', '--volumes', '--remove-orphans', '--rmi', 'local'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
