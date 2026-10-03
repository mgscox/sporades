import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../monitoring/trace/gateway.mjs';
import { createAvailabilityServer } from '../monitoring/trace/availability.mjs';
import { INVENTORY_MAX_BYTES } from '../monitoring/trace/inventory-contract.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';

const host = 'capacity.example';
const token = 'capacity-test-inventory-token';
const longDomain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
const alias = n => `https://${String(n).padStart(6, '0')}${'a'.repeat(57)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}/`;

function nearLimitInventory(longIds) {
  const value = { schemaVersion: 1, host, revision: 1, capsules: Array.from({ length: 2000 }, (_, n) => ({
    id: longIds ? `${longDomain}/${String(n).padStart(6, '0')}${'n'.repeat(57)}` : `apps.example/capsule-${n.toString().padStart(4, '0')}`,
    state: 'running', changedAt: '2026-10-03T00:00:00.000Z', release: 'release-1',
    targets: [`https://capsule-${n}.apps.example/`],
  })) };
  let size = Buffer.byteLength(JSON.stringify(value));
  let n = 0;
  for (const capsule of value.capsules) {
    while (capsule.targets.length < 21) {
      const target = alias(n++);
      const added = Buffer.byteLength(JSON.stringify(target)) + 1;
      if (size + added > INVENTORY_MAX_BYTES) return value;
      capsule.targets.push(target);
      size += added;
    }
  }
  throw new Error('Capacity fixture did not reach the wire limit.');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

for (const longIds of [false, true]) {
  test(`near-limit acknowledged inventory remains readable, retryable and stoppable across restart (${longIds ? '317-character' : 'short'} Capsule IDs)`, { timeout: 30_000 }, async t => {
    const base = path.resolve('.sporades/issue-120/round-2');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'inventory-'));
    let gateway;
    let availability;
    let origin;
    let discovery;
    t.after(async () => { await close(gateway); await close(availability); await rm(directory, { recursive: true, force: true }); });
    const start = async () => {
      gateway = createGateway({ inventoryDirectory: directory, inventoryHosts: { [host]: token }, ingestToken: 'different-ingestion-token', uiUser: 'operator', uiPassword: 'operator-test-password' });
      availability = createAvailabilityServer({ inventoryDirectory: directory });
      origin = await listen(gateway);
      discovery = await listen(availability);
    };
    const put = value => fetch(`${origin}/v1/inventory/${host}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const read = async () => {
      const response = await fetch(`${origin}/v1/inventory/${host}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200, 'acknowledged inventory must remain readable');
      return (await response.json()).data.inventory;
    };
    const targets = async () => {
      const response = await fetch(discovery + '/targets');
      assert.equal(response.status, 200, 'discovery must read the acknowledged envelope');
      return response.json();
    };
    const metrics = async () => {
      const response = await fetch(discovery + '/metrics');
      assert.equal(response.status, 200, 'expectations must remain observable');
      return response.text();
    };
    const value = nearLimitInventory(longIds);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert(bytes <= INVENTORY_MAX_BYTES && bytes > INVENTORY_MAX_BYTES - 300);
    assert.equal(value.capsules[0].id.length, longIds ? 317 : 25);
    await start();
    assert.equal((await put(value)).status, 200);
    const acknowledged = await read();
    assert.equal(acknowledged.capsules.length, 2000);
    assert.deepEqual(acknowledged.capsules.map(capsule => capsule.id).sort(), value.capsules.map(capsule => capsule.id).sort());
    assert.equal((await targets()).length, value.capsules.reduce((count, capsule) => count + capsule.targets.length, 0));
    const firstMetrics = await metrics();
    assert.equal((firstMetrics.match(/^sporades_expected_capsule.* 1$/gm) ?? []).length, 2000);
    const expectationTimes = text => text.split('\n').filter(line => line.includes('_expected_since_seconds')).sort();
    assert.equal((await put(value)).status, 200, 'identical retry must remain acknowledged');
    assert.deepEqual(expectationTimes(await metrics()), expectationTimes(firstMetrics), 'retry must not reset expectation age');

    // An over-limit higher revision must leave the durable acknowledgement intact.
    const oversized = { ...value, revision: 2, capsules: value.capsules.map(capsule => ({ ...capsule, targets: [...capsule.targets] })) };
    oversized.capsules.at(-1).targets.push(alias(99_999));
    assert(Buffer.byteLength(JSON.stringify(oversized)) > INVENTORY_MAX_BYTES);
    assert.equal((await put(oversized)).status, 413);
    assert.equal((await read()).revision, 1);

    await close(gateway); await close(availability); await start();
    assert.equal((await read()).revision, 1);
    assert.equal((await targets()).length, value.capsules.reduce((count, capsule) => count + capsule.targets.length, 0));
    assert.deepEqual(expectationTimes(await metrics()), expectationTimes(firstMetrics), 'restart must preserve expectation age');
    assert.equal((await put(value)).status, 200);
    const stopped = { ...value, revision: 2, capsules: value.capsules.map(capsule => ({ ...capsule, state: 'stopped', targets: [] })) };
    assert.equal((await put(stopped)).status, 200, 'higher-revision acknowledged stop must remain repairable');
    assert.deepEqual(await targets(), []);
    assert.doesNotMatch(await metrics(), /^sporades_expected_capsule/gm);
    assert.match(await metrics(), /sporades_expected_host\{host="capacity.example"\} 0/);
    assert.equal((await read()).revision, 2);
    assert((await read()).capsules.every(capsule => capsule.state === 'stopped'));
    await close(gateway); await close(availability); await start();
    assert.deepEqual(await targets(), []);
    assert.equal((await read()).revision, 2);
  });
}
