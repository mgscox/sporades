import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHttpRequestTelemetry } from '../dist/runtime-telemetry.js';
import { validateInventory } from '../dist/cli/inventory-contract.js';
import { createInventoryStore } from '../monitoring/trace/inventory-store.mjs';
import { createAvailabilityServer } from '../monitoring/trace/availability.mjs';

const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
const identities = [`${domain}/${'n'.repeat(62)}a`, `${domain}/${'n'.repeat(62)}b`];

test('real runtime exporters retain maximum-length inventory identities and distinguish shared prefixes', async t => {
  assert.equal(identities[0].length, 317);
  assert.equal(identities[0].slice(0, 80), identities[1].slice(0, 80));
  const base = new URL('../.sporades/issue-120/', import.meta.url);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(new URL('identity-', base));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inventory = validateInventory({ schemaVersion: 1, host: 'host-one', revision: 1, capsules: identities.map(id => ({
    id, state: 'running', changedAt: '2026-10-03T00:00:00.000Z', release: null, targets: [],
  })) });
  assert.equal((await createInventoryStore(directory).update(inventory)).status, 200);
  const batches = [];
  const collector = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    batches.push(JSON.parse(body)); res.writeHead(200).end('{}');
  }).listen(0, '127.0.0.1');
  const availability = createAvailabilityServer({ inventoryDirectory: directory }).listen(0, '127.0.0.1');
  await Promise.all([once(collector, 'listening'), once(availability, 'listening')]);
  t.after(() => { for (const server of [collector, availability]) { server.closeAllConnections(); server.close(); } });
  for (const serviceName of identities) {
    const telemetry = createHttpRequestTelemetry({ endpoint: `http://127.0.0.1:${collector.address().port}`, tls: { mode: 'loopback' }, serviceName, environment: 'hosted' });
    const app = createServer((req, res) => telemetry.run(req, res, [], async () => res.writeHead(200).end('ok'))).listen(0, '127.0.0.1');
    await once(app, 'listening');
    try {
      assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/`)).status, 200);
    } finally {
      await telemetry.shutdown(); app.closeAllConnections(); app.close();
    }
  }
  const metrics = batches.flatMap(batch => batch.resourceMetrics ?? []);
  const traces = batches.flatMap(batch => batch.resourceSpans ?? []);
  const name = resource => resource.resource.attributes.find(attribute => attribute.key === 'service.name')?.value.stringValue;
  for (const resources of [metrics, traces]) assert.deepEqual([...new Set(resources.map(name))].sort(), identities);
  for (const id of identities) {
    assert(metrics.filter(resource => name(resource) === id).some(resource => resource.scopeMetrics.some(scope => scope.metrics.some(metric => metric.name === 'process.uptime' && metric.gauge.dataPoints.length))));
    assert(traces.filter(resource => name(resource) === id).some(resource => resource.scopeSpans.some(scope => scope.spans.length)));
  }
  const expectations = await (await fetch(`http://127.0.0.1:${availability.address().port}/metrics`)).text();
  for (const id of identities) assert(expectations.includes(`sporades_expected_capsule{host="host-one",service_name="${id}"} 1`));
});

test('every availability alert Grafana reference names a shipped dashboard UID', async () => {
  const stack = new URL('../monitoring/trace/', import.meta.url);
  const dashboards = await Promise.all((await readdir(stack)).filter(file => file.endsWith('-dashboard.json')).map(async file => JSON.parse(await readFile(new URL(file, stack), 'utf8')).uid));
  const rules = await readFile(new URL('availability-rules.yaml', stack), 'utf8');
  const references = [...rules.matchAll(/\/grafana\/d\/([^?'\s]+)/g)].map(match => match[1]);
  assert(references.length >= 4, 'Capsule and Host alerts must retain dashboard context');
  for (const uid of references) assert(dashboards.includes(uid), `Alert references unshipped dashboard ${uid}`);
  assert(references.includes('sporades-hosts'));
});
