import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { reportHostAvailability } from '../dist/cli/host-availability.js';

async function workerFixture(t) {
  const base = new URL('../.sporades/issue-120/', import.meta.url);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(new URL('worker-', base));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = directory + '/config.json';
  const callsFile = directory + '/calls.jsonl';
  const bin = directory + '/bin'; await mkdir(bin);
  await writeFile(bin + '/docker', `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(${JSON.stringify(configFile)}, 'utf8'));
const operation = process.argv[2];
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(operation) + '\\n');
if (operation === 'inspect') process.stdout.write(JSON.stringify(config.relay));
else if (config.exec === 'fail') process.exitCode = 1;
else if (config.exec === 'timeout') setTimeout(() => process.stdout.write('1'), 10000);
else process.stdout.write('1');
`, { mode: 0o755 });
  const originalPath = process.env.PATH; process.env.PATH = bin + ':' + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  const bodies = [];
  let status = 200;
  const relay = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/metrics');
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body)); res.writeHead(status).end('{}');
  }).listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const config = { relay: { Config: { Labels: { 'com.sporades.host-telemetry-relay': 'true' } }, NetworkSettings: { Networks: { private: { IPAddress: '127.0.0.1' } } } }, exec: 'ok' };
  const input = { host: 'host-one', network: 'private', capsules: [{ id: 'apps.example/demo', state: 'running' }] };
  return {
    config, bodies, setStatus: value => { status = value; },
    async report() { await writeFile(configFile, JSON.stringify(config)); return reportHostAvailability(input, relay.address().port); },
    async calls() { return (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse); },
  };
}

for (const [name, mutate] of [
  ['missing relay identity label', config => { config.relay.Config.Labels = {}; }],
  ['invalid relay identity label', config => { config.relay.Config.Labels['com.sporades.host-telemetry-relay'] = 'false'; }],
  ['missing private network address', config => { config.relay.NetworkSettings.Networks = {}; }],
  ['remote hostname instead of local relay IP', config => { config.relay.NetworkSettings.Networks.private.IPAddress = 'notify.example'; }],
  ['malformed relay IP', config => { config.relay.NetworkSettings.Networks.private.IPAddress = '127.0.0.1:80'; }],
  ['unsupported IPv6 relay address', config => { config.relay.NetworkSettings.Networks.private.IPAddress = '::1'; }],
]) {
  test(`Host worker denies ${name} before exec or relay delivery`, async t => {
    const fixture = await workerFixture(t); mutate(fixture.config);
    assert.equal(await fixture.report(), false);
    assert.deepEqual(await fixture.calls(), ['inspect']);
    assert.deepEqual(fixture.bodies, []);
  });
}

for (const outcome of ['fail', 'timeout']) {
  test(`Host worker reports readiness zero after ${outcome === 'fail' ? 'failed' : 'timed-out'} exec and recovers`, { timeout: 10_000 }, async t => {
    const fixture = await workerFixture(t); fixture.config.exec = outcome;
    assert.equal(await fixture.report(), true, 'unready Capsule still reports Host contact');
    const readiness = body => body.resourceMetrics[0].scopeMetrics[0].metrics.find(metric => metric.name === 'sporades.capsule.local.ready').gauge.dataPoints;
    assert.equal(readiness(fixture.bodies[0])[0].asInt, '0');
    assert.deepEqual(readiness(fixture.bodies[0])[0].attributes, [
      { key: 'host', value: { stringValue: 'host-one' } },
      { key: 'service.name', value: { stringValue: 'apps.example/demo' } },
    ]);
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]), /token|SPORADES_RUNTIME_PROBE|sqlite|fileStorage/);
    fixture.config.exec = 'ok';
    assert.equal(await fixture.report(), true);
    assert.equal(readiness(fixture.bodies[1])[0].asInt, '1');
    assert.deepEqual(await fixture.calls(), ['inspect', 'exec', 'inspect', 'exec']);
  });
}

test('Host worker returns false on failed relay delivery and succeeds on the next run', async t => {
  const fixture = await workerFixture(t); fixture.setStatus(503);
  assert.equal(await fixture.report(), false);
  assert.equal(fixture.bodies.length, 1, 'one bounded delivery attempt');
  fixture.setStatus(200);
  assert.equal(await fixture.report(), true);
  assert.equal(fixture.bodies.length, 2);
  assert.deepEqual(await fixture.calls(), ['inspect', 'exec', 'inspect', 'exec']);
});
