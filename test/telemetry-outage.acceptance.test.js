import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setupEnvironment } from '../monitoring/trace/setup.mjs';
import { renderHostRelayCollectorConfig } from '../dist/cli/host-telemetry-relay.js';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const enabled = process.env.SPORADES_REAL_TELEMETRY_OUTAGE === '1';
const repository = process.cwd();
const source = `import { capsule, endpoint, job } from 'sporades/server';
export default capsule({ name: 'outage-business', jobs: { work: job(() => 'completed') }, endpoints: {
  work: endpoint({ method: 'GET', path: '/work' }, async ctx => ({status:200,body:await ctx.privileged.run({operation:'test.enqueue',targetResourceKind:'job-queue'},p=>p.jobs.enqueue('work',{}))})),
  state: endpoint({ method:'GET', path:'/state' }, async ctx => ({status:200,body:await ctx.privileged.run({operation:'test.inspect',targetResourceKind:'job-queue'},p=>p.jobs.get(ctx.request.query.id))})),
}});`;

async function until(callback, message, budget = 30_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { if (await callback()) return; await pause(200); }
  assert.fail(message);
}

test('isolated shipped stack recovers bounded persistent queues, rejects saturation and preserves Capsule Jobs', {
  skip: enabled ? false : 'Set SPORADES_REAL_TELEMETRY_OUTAGE=1 for disposable Docker fault drills.', timeout: 300_000,
}, async t => {
  assert(path.resolve(process.env.SPORADES_CONFIG_DIR ?? '').startsWith(repository + path.sep), 'SPORADES_CONFIG_DIR must be inside this worktree');
  const base = path.join(repository, '.sporades', 'outage-drills');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'run-'));
  const prefix = `barbara129-${randomBytes(5).toString('hex')}`;
  const volume = `${prefix}-queue`;
  const anchor = `${prefix}-quota`;
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config'), COMPOSE_PROJECT_NAME: prefix };
  const run = async (program, args, options = {}) => (await execute(program, args, { cwd: root, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim();
  const compose = (...args) => run('docker', ['compose', '--env-file', '.compose.env', '-f', 'compose.yaml', '-f', 'acceptance.yaml', ...args]);
  const report = { project: prefix, versions: {}, budgets: { quotaBytes: 134217728, queueBytes: 65536, retrySeconds: 10, relayBatchSpans: 16, collectorMemoryBytes: 268435456, relayMemoryBytes: 201326592 }, phases: [] };
  let child;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await writeFile(path.join(root, 'compose.log'), await compose('logs', '--no-color').catch(() => 'unavailable'));
    await compose('down', '--volumes', '--remove-orphans', '--rmi', 'local').catch(() => {});
    await run('docker', ['rm', '-f', anchor]).catch(() => {});
    await run('docker', ['volume', 'rm', volume]).catch(() => {});
    await writeFile(path.join(root, 'resource-report.json'), JSON.stringify(report, null, 2) + '\n');
  });
  await run(process.execPath, [path.join(repository, 'bin/sporades.js'), 'monitoring', 'stack', 'init', '--dir', root, '--json']);
  await writeFile(path.join(root, '.env'), 'TRACE_TLS_MODE=proxy\nTRACE_BIND=127.0.0.1\nTRACE_PORT=5688\nGRAFANA_ROOT_URL=http://127.0.0.1:5688/grafana/\n');
  await setupEnvironment(path.join(root, '.env'));
  const credentials = JSON.parse(await readFile(path.join(root, '.private', 'credentials.json')));
  const origin = 'http://127.0.0.1:5688';
  const uiHeaders = { authorization: `Basic ${Buffer.from(`${credentials.uiUser}:${credentials.uiPassword}`).toString('base64')}` };
  const post = (endpoint, body, authenticated = true) => fetch(endpoint + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${credentials.ingestToken}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  const query = async expression => {
    const response = JSON.parse(await probe(`http://prometheus:9090/api/v1/query?query=${encodeURIComponent(expression)}`));
    assert.equal(response.status, 'success'); return response.data.result;
  };
  const probe = url => compose('exec', '-T', 'gateway', 'node', '-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))`);
  const collectorMetrics = () => probe('http://collector:8888/metrics');
  const relayMetrics = async () => {
    const id = await compose('ps', '-q', 'relay');
    const probeName = `${prefix}-relay-probe-${randomBytes(3).toString('hex')}`;
    try {
      return await run('docker', ['run', '--rm', '--name', probeName, '--network', `container:${id}`, 'node:24-bookworm-slim', 'node', '-e', "fetch('http://127.0.0.1:8888/metrics',{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))"], { timeout: 10_000 });
    } finally {
      await run('docker', ['rm', '-f', probeName], { timeout: 5000 }).catch(() => {});
    }
  };
  const relayMemory = async () => {
    const id = await compose('ps', '-q', 'relay');
    const probeName = `${prefix}-memory-probe-${randomBytes(3).toString('hex')}`;
    try {
      // Read only this fixture relay's cgroup through its process root.
      // SYS_PTRACE permits the cross-UID read inside its private PID namespace.
      const values = (await run('docker', ['run', '--rm', '--name', probeName, '--pid', `container:${id}`, '--cap-add', 'SYS_PTRACE', 'busybox:1.37.0', 'cat', '/proc/1/root/sys/fs/cgroup/memory.current', '/proc/1/root/sys/fs/cgroup/memory.peak', '/proc/1/root/sys/fs/cgroup/memory.max', '/proc/1/root/sys/fs/cgroup/memory.events'], { timeout: 10_000 })).split('\n');
      return { currentBytes: Number(values[0]), peakBytes: Number(values[1]), limitBytes: Number(values[2]), events: Object.fromEntries(values.slice(3).map(line => { const [name, value] = line.split(' '); return [name, Number(value)]; })) };
    } finally {
      await run('docker', ['rm', '-f', probeName], { timeout: 5000 }).catch(() => {});
    }
  };
  const metricValue = (text, name) => [...text.matchAll(new RegExp(`^${name}(?:\\{[^\\n]*\\})? ([0-9.e+]+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0);
  const phase = async name => {
    const metrics = await collectorMetrics();
    await writeFile(path.join(root, `metrics-${name}.txt`), metrics);
    const gatewayMetrics = await probe('http://127.0.0.1:8889/metrics');
    const sdkRss = child?.exitCode === null ? Number(await run('ps', ['-o', 'rss=', '-p', String(child.pid)])) * 1024 : null;
    const disk = Number(await run('docker', ['exec', anchor, 'sh', '-c', 'du -sk /queue | cut -f1']));
    report.phases.push({ name, at: new Date().toISOString(), collectorRss: metricValue(metrics, 'otelcol_process_memory_rss_bytes'), queueSize: metricValue(metrics, 'otelcol_exporter_queue_size'), queueCapacity: metricValue(metrics, 'otelcol_exporter_queue_capacity'), enqueueFailures: metricValue(metrics, 'otelcol_exporter_enqueue_failed_spans_total'), sendFailures: metricValue(metrics, 'otelcol_exporter_send_failed_spans_total'), gatewayRss: metricValue(gatewayMetrics, 'sporades_gateway_memory_rss_bytes'), sdkRss, diskKiB: disk });
    assert(disk * 1024 <= report.budgets.quotaBytes);
    assert(report.phases.at(-1).collectorRss < report.budgets.collectorMemoryBytes);
    assert(report.phases.at(-1).collectorRss > 0, 'Collector RSS metric must exist');
    assert(report.phases.at(-1).gatewayRss > 0, 'gateway RSS metric must exist');
  };
  // A fixture-only tmpfs quota, kept mounted across Collector restarts. Not reboot durable.
  await run('docker', ['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=128m,uid=10001,gid=10001,mode=0700', volume]);
  await run('docker', ['run', '-d', '--name', anchor, '--mount', `type=volume,source=${volume},target=/queue`, 'busybox:1.37.0', 'sleep', 'infinity']);
  const persistent = (await readFile(path.join(root, 'collector-persistent.yaml'), 'utf8')).replaceAll('queue_size: 16777216', 'queue_size: 65536').replaceAll('max_elapsed_time: 30s', 'max_elapsed_time: 10s');
  await writeFile(path.join(root, 'drill-collector.yaml'), persistent);
  // Production connect validates HTTPS. This disposable private-network copy
  // uses HTTP solely to avoid contacting an operator TLS endpoint.
  // Keep trace batches below this drill's accelerated 64 KiB byte queue.
  // A 256-span batch can be rejected as oversized before any export attempt.
  const relay = renderHostRelayCollectorConfig({ endpoint: 'https://gateway:8443/', caFile: false }).replace('https://gateway:8443/', 'http://gateway:8443/').replace('queue_size: 16777216', 'queue_size: 65536').replace('send_batch_size: 256', 'send_batch_size: 16').replace('send_batch_max_size: 256', 'send_batch_max_size: 16').replace('max_elapsed_time: 300s', 'max_elapsed_time: 10s');
  await writeFile(path.join(root, 'drill-relay.yaml'), relay);
  await writeFile(path.join(root, 'acceptance.yaml'), `services:
  collector:
    user: "10001:10001"
    volumes:
      - ./drill-collector.yaml:/etc/otelcol/config.yaml:ro
      - drill-queue:/var/lib/otelcol/queue
  relay:
    image: otel/opentelemetry-collector-contrib:0.138.0
    command: ["--config=/config.yaml"]
    environment:
      SPORADES_INGEST_AUTH: "Bearer ${credentials.ingestToken}"
    volumes: ["./drill-relay.yaml:/config.yaml:ro"]
    ports: ["127.0.0.1::4318"]
    read_only: true
    mem_limit: 192m
    cpus: 0.5
    pids_limit: 128
    stop_grace_period: 5s
volumes:
  drill-queue:
    external: true
    name: ${volume}
`);
  await compose('up', '-d', '--build');
  report.versions = JSON.parse(await compose('images', '--format', 'json'));
  await until(() => fetch(origin + '/health', { signal: AbortSignal.timeout(9000) }).then(r => r.ok, () => false), 'stack readiness did not recover', 60_000);
  await phase('idle');
  const relayPort = (await compose('port', 'relay', '4318')).split(':').at(-1);
  const relayOrigin = `http://127.0.0.1:${relayPort}`;
  const config = { name: 'outage-business', __sporadesTelemetry: { endpoint: relayOrigin, tls: { mode: 'loopback' }, serviceName: 'outage-business', metricsIntervalMs: 1000 } };
  const serverModuleSource = await bundleServerCapsuleModule({ serverSource: source, serverSourcePath: path.join(repository, 'server/index.ts') });
  await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({ config, serverEnv: {}, serverSource: source, serverModuleSource }));
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', part => { errors += part; });
  const business = `http://127.0.0.1:${port}`;
  const work = async () => {
    const response = await fetch(business + '/work'); assert.equal(response.status, 200);
    const job = await response.json();
    await until(async () => (await (await fetch(`${business}/state?id=${job.id}`)).json()).status === 'succeeded', 'business Job failed during monitoring outage', 5000);
  };
  await until(() => fetch(business + '/state?id=missing').then(() => true, () => false), 'generated Capsule not ready');
  await phase('sdk-idle');
  await work();
  await until(async () => (await query('sporades_job_execution_duration_seconds_count{service_name="outage-business"}')).length > 0, 'generated Job metrics were not stored');
  assert((await query('otel_sdk_processor_span_queue_capacity{service_name="outage-business"}')).some(item => Number(item.value[1]) === 128), 'shipped SDK queue capacity is queryable in Prometheus');
  await until(async () => (await query('up{job="sporades-pipeline-collector"}')).some(item => item.value[1] === '1'), 'private pipeline scrape failed');
  await until(async () => {
    const response = await fetch(origin + '/grafana/api/dashboards/uid/sporades-pipeline', { headers: uiHeaders });
    return response.ok && (await response.json()).dashboard?.title === 'Sporades Telemetry Pipeline';
  }, 'pipeline dashboard was not provisioned');
  const metricAt = Date.now();
  for (const age of [0, 20_000]) {
    const response = await fetch(origin + '/v1/metrics', { method: 'POST', headers: { authorization: `Bearer ${credentials.ingestToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'sporades.drill.reordered', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(metricAt - age) * 1000000n), asDouble: age + 1 }] } }] }] }] }) });
    assert.equal(response.status, 200);
    await pause(1500); // Store the newer sample before replaying the older one.
  }
  await until(async () => (await query('count_over_time(sporades_drill_reordered[1m])')).some(item => Number(item.value[1]) === 2), 'bounded out-of-order metric replay was not retained', 5000);
  await compose('stop', 'jaeger');
  const traceId = randomBytes(16).toString('hex');
  const payload = id => ({ resourceSpans: [{ scopeSpans: [{ spans: Array.from({ length: 8 }, (_, i) => ({ traceId: id, spanId: randomBytes(8).toString('hex'), name: 'fault-drill', startTimeUnixNano: String(BigInt(Date.now()) * 1000000n), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n), attributes: [{ key: 'drill', value: { stringValue: 'x'.repeat(1000) } }] })) }] }] });
  assert.equal((await post(origin, payload(traceId))).status, 200);
  await until(async () => metricValue(await collectorMetrics(), 'otelcol_exporter_queue_size') > 0, 'persistent queue did not buffer disconnected backend');
  await phase('backend-disconnected');
  await compose('kill', '-s', 'SIGKILL', 'collector');
  await compose('start', 'jaeger', 'collector');
  await until(async () => { const response = await fetch(origin + '/api/traces/' + traceId, { headers: uiHeaders }); return response.ok && (await response.json()).data?.length > 0; }, 'persisted trace did not survive Collector crash/restart');
  await work();
  await phase('restart-recovered');
  await compose('stop', 'jaeger', 'prometheus');
  for (let i = 0; i < 40; i++) await post(origin, payload(randomBytes(16).toString('hex')));
  await work();
  await until(async () => metricValue(await collectorMetrics(), 'otelcol_exporter_enqueue_failed_spans_total') > 0, 'queue saturation was not observable');
  await phase('saturated');
  await pause(12_000);
  await phase('retry-expired');
  assert(report.phases.at(-1).sendFailures > 0, 'expired retry/export failures are counted');
  await compose('stop', 'gateway');
  for (let i = 0; i < 30; i++) await post(relayOrigin, payload(randomBytes(16).toString('hex')), false);
  await work();
  await compose('start', 'gateway', 'jaeger', 'prometheus');
  await until(() => fetch(origin + '/health', { signal: AbortSignal.timeout(9000) }).then(r => r.ok, () => false), 'stack did not recover after prolonged outage');
  await work();
  await until(async () => (await query('sporades_telemetry_collection_time_seconds{service_name="outage-business"}')).some(item => Number(item.value[1]) > Date.now() / 1000 - 5), 'source metrics did not become fresh after reconnect');
  await until(async () => metricValue(await collectorMetrics(), 'otelcol_exporter_queue_size') === 0, 'queue did not drain after reconnect');
  await phase('fully-recovered');
  const relayFailuresBeforeSlowExport = metricValue(await relayMetrics(), 'otelcol_exporter_send_failed_spans_total');
  await compose('pause', 'gateway');
  for (let i = 0; i < 8; i++) assert.equal((await post(relayOrigin, payload(randomBytes(16).toString('hex')), false)).status, 200);
  await work();
  // Observe a new failure, allowing batching, export deadlines and retry jitter.
  // Each diagnostics probe is bounded too; a stalled probe cannot hang cleanup.
  const slowExportAt = Date.now();
  let slowRelay;
  await until(async () => {
    slowRelay = await relayMetrics();
    await writeFile(path.join(root, 'metrics-relay-slow.txt'), slowRelay);
    return metricValue(slowRelay, 'otelcol_exporter_send_failed_spans_total') > relayFailuresBeforeSlowExport;
  }, 'slow relay exports did not fail within the observation budget', 45_000);
  report.relaySlowExport = { observationMs: Date.now() - slowExportAt, failuresBefore: relayFailuresBeforeSlowExport, rss: metricValue(slowRelay, 'otelcol_process_memory_rss_bytes'), queueSize: metricValue(slowRelay, 'otelcol_exporter_queue_size'), queueCapacity: metricValue(slowRelay, 'otelcol_exporter_queue_capacity'), sendFailures: metricValue(slowRelay, 'otelcol_exporter_send_failed_spans_total') };
  // RSS includes shared executable pages; enforce the Docker budget against
  // charged cgroup memory, including its peak over this whole container run.
  report.relaySlowExport.memory = await relayMemory();
  const relayMemoryEvidence = report.relaySlowExport.memory;
  assert(report.relaySlowExport.rss > 0, 'relay RSS metric must exist');
  assert.equal(relayMemoryEvidence.limitBytes, report.budgets.relayMemoryBytes);
  assert(relayMemoryEvidence.currentBytes > 0 && relayMemoryEvidence.currentBytes <= report.budgets.relayMemoryBytes);
  assert(relayMemoryEvidence.peakBytes > 0 && relayMemoryEvidence.peakBytes <= report.budgets.relayMemoryBytes);
  assert.equal(relayMemoryEvidence.events.oom, 0);
  assert.equal(relayMemoryEvidence.events.oom_kill, 0);
  assert(report.relaySlowExport.sendFailures > relayFailuresBeforeSlowExport, 'slow relay exports produce a new failure');
  await compose('unpause', 'gateway');
  await until(() => fetch(origin + '/health', { signal: AbortSignal.timeout(9000) }).then(r => r.ok, () => false), 'slow relay/gateway did not recover');
  // Reserve almost all quota, then prove a write failure is bounded and service
  // stays available. Space is freed before any further Collector restart.
  await compose('stop', 'jaeger');
  await compose('stop', 'collector');
  await run('docker', ['exec', anchor, 'sh', '-c', 'dd if=/dev/zero of=/queue/full bs=1048576 count=128 2>/dev/null || true']);
  await compose('start', 'collector');
  await work();
  await until(async () => /no space left on device/.test(await compose('logs', '--no-color', 'collector')), 'full disk did not cause a real bounded storage failure', 5000);
  const diskKiB = Number(await run('docker', ['exec', anchor, 'sh', '-c', 'du -sk /queue | cut -f1']));
  report.phases.push({ name: 'disk-full', at: new Date().toISOString(), diskKiB, collectorRss: null, queueSize: null, diagnostics: 'unavailable: storage startup failed with ENOSPC' });
  assert(diskKiB > 120 * 1024 && diskKiB * 1024 <= report.budgets.quotaBytes, 'quota was actually exhausted');
  await run('docker', ['exec', anchor, 'rm', '/queue/full']);
  await compose('start', 'jaeger', 'collector');
  await until(() => fetch(origin + '/health', { signal: AbortSignal.timeout(9000) }).then(r => r.ok, () => false), 'pipeline did not recover after full disk');
  await phase('disk-recovered');
  if (process.env.SPORADES_OUTAGE_BROWSER_HOLD === '1') {
    // Browser uses a fixture-only credential file, never an operator profile.
    await writeFile(path.join(root, 'browser-auth.json'), JSON.stringify({ origin, username: credentials.uiUser, password: credentials.uiPassword }), { mode: 0o600 });
    console.log('Disposable dashboard ready for browser verification on port 5688');
    await until(async () => { try { await readFile(path.join(root, 'browser-done')); return true; } catch { return false; } }, 'browser verification did not finish', 120_000);
  }
  await compose('stop', 'gateway', 'relay');
  await work();
  const exited = once(child, 'exit'); const shutdownAt = Date.now(); child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, errors); assert.equal(signal, null); assert(Date.now() - shutdownAt < 2500);
  report.shutdownMs = Date.now() - shutdownAt;
  console.log(`Isolated resource evidence: ${path.relative(repository, path.join(root, 'resource-report.json'))}`);
});
