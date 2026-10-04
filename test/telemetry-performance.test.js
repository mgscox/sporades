import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { setupEnvironment, inspectEnvironment } from '../monitoring/trace/setup.mjs';
await mkdir(new URL('../.sporades/issue-121/', import.meta.url), { recursive: true });


test('operator policy produces guarded performance rules and preserves exact route budgets', async t => {
  const dir = await mkdtemp(new URL('../.sporades/issue-121/policy-', import.meta.url).pathname);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = `TRACE_TLS_MODE=proxy\nMONITORING_PUBLIC_URL=https://monitor.example\nALERT_POLICY_JSON='{"apiErrorRatio":0.1,"routeBudgets":[{"service":"apps.example/demo","route":"/report","seconds":3}],"streamRoutes":["/events"],"expectedJobServices":["apps.example/batch"]}'\nOPERATOR_EXTRA=keep\n`;
  await writeFile(dir + '/.env', source);
  await setupEnvironment(dir + '/.env');
  assert((await readFile(dir + '/.env', 'utf8')).startsWith(source));
  const rules = JSON.parse(await readFile(dir + '/.private/performance-rules.yaml', 'utf8')).groups[0].rules;
  const errors = rules.find(rule => rule.alert === 'SporadesApiErrors');
  assert.match(errors.expr, /> 0.1/);
  assert.match(errors.expr, />= 100/);
  assert.match(errors.expr, /sporades_expected_capsule/);
  assert.equal(errors.for, '0s'); // the ratio already covers five minutes
  const slow = rules.filter(rule => rule.alert === 'SporadesApiLatency');
  assert.equal(slow.length, 2);
  assert(slow.some(rule => rule.expr.includes('http_route="/report"') && rule.expr.includes('> 3')));
  assert(slow.every(rule => rule.expr.includes('histogram_quantile') && rule.expr.includes('>= 100') && rule.expr.includes('http_route!~"/events"')));
  assert(slow.every(rule => rule.for === '600s'));
  assert.match(errors.annotations.dashboard, /^https:\/\/monitor.example\/grafana\/d\/sporades-api/);
  assert(rules.find(rule => rule.alert === 'SporadesProcessPressureCandidate').expr.includes(String.raw`apps\\.example/batch`));
  assert.doesNotMatch(await readFile(dir + '/.compose.env', 'utf8'), /ALERT_POLICY_JSON/);
  assert.match(await readFile(dir + '/.private/alertmanager.yaml', 'utf8'), /group_by: \[alertname, host, sporades_host, service_name\]/);
});

test('malformed policy fails before setup can replace provisioned files and redacts values', async t => {
  const dir = await mkdtemp(new URL('../.sporades/issue-121/invalid-', import.meta.url).pathname);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = ['{"apiErrorRatio":2}', '{"typo":1}', '{"routeBudgets":[{"service":"demo","route":"/items?secret=private","seconds":1}]}', '{"streamRoutes":[".*"]}', '{"hostCpuForSeconds":0}', '{"apiMinRequests":0}'];
  for (const policy of cases) {
    const source = `TRACE_TLS_MODE=proxy\nALERT_POLICY_JSON='${policy}'\n`;
    await writeFile(dir + '/.env', source);
    assert.throws(() => inspectEnvironment(source), /^Error: Invalid ALERT_POLICY_JSON$/);
    await assert.rejects(setupEnvironment(dir + '/.env'), /^Error: Invalid ALERT_POLICY_JSON$/);
    assert.equal(await readFile(dir + '/.env', 'utf8'), source);
  }
});

test('inventory exposes lifecycle timestamps and bounded backend disk capacity without release labels', async t => {
  const { createAvailabilityServer } = await import('../monitoring/trace/availability.mjs');
  const { createInventoryStore } = await import('../monitoring/trace/inventory-store.mjs');
  const { once } = await import('node:events');
  const dir = await mkdtemp(new URL('../.sporades/issue-121/metrics-', import.meta.url).pathname);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createInventoryStore(dir).update({ schemaVersion: 1, host: 'host-one', revision: 1, capsules: [{ id: 'apps.example/demo', state: 'stopped', changedAt: '2026-10-03T00:00:00.000Z', release: 'release-private', targets: [] }] });
  const server = createAvailabilityServer({ inventoryDirectory: dir, storagePaths: { metrics: dir, traces: dir + '/missing' } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const metrics = await (await fetch(`http://127.0.0.1:${server.address().port}/metrics`)).text();
  assert.match(metrics, /sporades_capsule_lifecycle_changed_seconds\{host="host-one",service_name="apps.example\/demo",state="stopped"\} 1790985600/);
  assert.match(metrics, /sporades_monitoring_storage_available_bytes\{backend="metrics"\} [1-9]/);
  assert.match(metrics, /sporades_monitoring_storage_stat_ok\{backend="traces"\} 0/);
  assert.doesNotMatch(metrics, /release-private|missing|storage_available_bytes\{backend="traces"/);
});

test('provisioned fleet navigation and lifecycle annotations use acknowledged timestamps and independent histograms', async () => {
  for (const file of ['fleet-dashboard.json','api-dashboard.json','resource-dashboard.json','host-dashboard.json','caddy-dashboard.json','pipeline-dashboard.json']) {
    const dashboard = JSON.parse(await readFile(new URL('../monitoring/trace/' + file, import.meta.url), 'utf8'));
    assert(dashboard.links.some(link => link.url.startsWith('/grafana/d/sporades-fleet')));
    assert(dashboard.links.some(link => link.url.startsWith('/grafana/d/sporades-api')));
    assert(dashboard.links.some(link => link.url.startsWith('/grafana/d/sporades-resources')));
    assert(dashboard.annotations.list.some(annotation => annotation.useValueForTime && annotation.expr.includes('sporades_capsule_lifecycle_changed_seconds')));
  }
});

test('shipped operator policy and public declarations stay in canonical parity', async () => {
  const { startingPolicy } = await import('../monitoring/trace/performance-policy.mjs');
  assert.equal(await readFile(new URL('../docs/reference/monitoring-performance.md', import.meta.url), 'utf8'), await readFile(new URL('../monitoring/trace/performance-policy.md', import.meta.url), 'utf8'));
  const declaration = await readFile(new URL('../src/types/monitoring.d.ts', import.meta.url), 'utf8');
  const fields = declaration.split('export interface MonitoringAlertPolicy {')[1].match(/^  ([A-Za-z]+)\?:/gm).map(field => field.trim().split('?')[0]);
  assert.deepEqual(fields.sort(), Object.keys(startingPolicy).sort());
});
