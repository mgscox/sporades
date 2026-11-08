import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptObservability } from '../dist/cli/observability-acceptance.js';

const target = { origin: 'https://capsule.example.test', capsule: 'synthetic', release: 'release-334', environment: 'acceptance' };
const surfaces = ['server-error', 'browser-error', 'browser-rejection'];
const plan = () => ({ version: 1, target, surfaces: Object.fromEntries(surfaces.map(surface => [surface, {
  provider: 'glitchtip', project: '42', state: 'enabled', diagnostic: { path: '/approved-diagnostic', approval: 'OPS-334' },
}])) });
function driver(change = event => event) {
  return {
    async probe() { return { capture: 'app-runtime', target, redactionCanaries: ['synthetic-password'] }; },
    async readBack(context) {
      return change({ handle: 'event-123', project: '42', marker: context.marker, timestamp: new Date().toISOString(),
        capsule: target.capsule, release: target.release, environment: target.environment, surface: context.surface,
        payload: { message: `${context.marker} password=[REDACTED]` } });
    },
    async cleanup() {},
  };
}

test('explicit acceptance records exact runtime events separately from Host health', async () => {
  const report = await acceptObservability(plan(), driver(), { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.target, target);
  for (const surface of surfaces) {
    assert.equal(report.surfaces[surface].status, 'pass');
    assert.equal(report.surfaces[surface].handle, 'event-123');
    assert.equal(report.surfaces[surface].project, '42');
    assert.match(report.surfaces[surface].marker, /^acceptance-[a-f0-9]{32}-/);
  }
  assert.equal(report.surfaces['analytics-pageview'].status, 'skipped');
  assert.equal(report.surfaces['notification-inbox'].status, 'skipped');
});

for (const [name, change, reason] of [
  ['wrong project', event => ({ ...event, project: '43' }), 'wrong-project'],
  ['stale event', event => ({ ...event, timestamp: '2020-01-01T00:00:00.000Z' }), 'stale-or-invalid-timestamp'],
  ['missing marker', event => ({ ...event, marker: undefined }), 'missing-or-wrong-marker'],
  ['historical marker', event => ({ ...event, marker: 'acceptance-previous' }), 'missing-or-wrong-marker'],
  ['wrong release', event => ({ ...event, release: 'old-release' }), 'wrong-runtime-tags'],
  ['wrong environment', event => ({ ...event, environment: 'production' }), 'wrong-runtime-tags'],
  ['wrong capsule', event => ({ ...event, capsule: 'sibling' }), 'wrong-runtime-tags'],
  ['redaction leak', event => ({ ...event, payload: { message: event.marker, secret: 'synthetic-password' } }), 'redaction-failed'],
  ['HTTP acknowledgement', () => ({ status: 200 }), 'invalid-provider-evidence'],
  ['empty error list', () => [], 'invalid-provider-evidence'],
]) test(`${name} cannot satisfy runtime acceptance and does not leak provider diagnostics`, async () => {
  let cleaned = false;
  const adapter = driver(change);
  adapter.cleanup = async () => { cleaned = true; };
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'fail');
  assert.equal(report.surfaces['server-error'].reason, reason);
  assert.equal(cleaned, true);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password/);
});

test('authorization and exact release are required before any probes', async () => {
  for (const auth of [{}, { authorizeTarget: 'https://other.example.test', release: target.release }, { authorizeTarget: target.origin, release: 'old' }]) {
    let touched = false;
    const adapter = driver(); adapter.probe = async () => { touched = true; throw new Error(); };
    await assert.rejects(acceptObservability(plan(), adapter, auth), /authorization/);
    assert.equal(touched, false);
  }
});

test('missing provider, disabled provider and absent approved server diagnostic are blocked', async () => {
  const selected = plan();
  delete selected.surfaces['server-error'].diagnostic;
  selected.surfaces['browser-error'].state = 'disabled';
  delete selected.surfaces['browser-rejection'];
  const report = await acceptObservability(selected, driver(), { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'blocked');
  assert.equal(report.surfaces['server-error'].reason, 'no-approved-diagnostic');
  assert.equal(report.surfaces['browser-error'].reason, 'provider-disabled');
  assert.equal(report.surfaces['browser-rejection'].reason, 'provider-missing');
});

test('direct capture cannot pass the app-runtime gate', async () => {
  const adapter = driver();
  adapter.probe = async () => ({ capture: 'direct', target, redactionCanaries: ['synthetic-password'] });
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'fail');
  assert.equal(report.surfaces['server-error'].reason, 'runtime-probe-unverified');
});

for (const fault of ['missing-event', 'hung-provider', 'unavailable', 'hung-probe', 'failed-probe']) test(`${fault} stays bounded, redacts errors and cleans up`, async () => {
  const adapter = driver(); let cleaned = false; const signals = [];
  adapter.cleanup = async () => { cleaned = true; };
  if (fault === 'missing-event') adapter.readBack = async () => null;
  if (fault === 'hung-provider' || fault === 'hung-probe') adapter[fault === 'hung-probe' ? 'probe' : 'readBack'] = async context => {
    signals.push(context.signal); return new Promise(() => {});
  };
  if (fault === 'unavailable' || fault === 'failed-probe') adapter[fault === 'unavailable' ? 'readBack' : 'probe'] = async () => { throw new Error('password=synthetic-password https://provider.test/?token=synthetic-token'); };
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release, timeoutMs: 40, pollMs: 1 });
  assert.equal(report.status, fault === 'unavailable' ? 'blocked' : 'fail');
  assert.equal(report.surfaces['server-error'].reason, fault === 'unavailable' ? 'provider-unavailable' : fault === 'failed-probe' ? 'probe-failed' : 'timeout');
  assert.equal(cleaned, true); assert.ok(signals.every(signal => signal.aborted));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password|synthetic-token|provider.test/);
});

test('cleanup failure prevents a successful gate', async () => {
  const adapter = driver(); adapter.cleanup = async () => { throw new Error('private-cleanup-details'); };
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'fail'); assert.equal(report.cleanup, 'fail');
  assert.doesNotMatch(JSON.stringify(report), /private-cleanup-details/);
});

test('optional pageviews run once and SMTP acceptance never implies inbox receipt', async () => {
  const selected = plan(); selected.analytics = true; selected.notifications = true;
  for (const surface of ['analytics-pageview', 'notification-smtp', 'notification-inbox']) selected.surfaces[surface] = {
    ...selected.surfaces['server-error'], provider: surface === 'analytics-pageview' ? 'umami' : 'glitchtip',
  };
  const adapter = driver(); const probes = []; let serverHandle;
  const probe = adapter.probe;
  adapter.probe = async context => { probes.push(context.surface); return probe(context); };
  const read = adapter.readBack;
  adapter.readBack = async context => {
    if (context.surface === 'notification-inbox') return null;
    const event = await read(context);
    if (context.surface === 'server-error') serverHandle = event.handle;
    return { ...event, handle: context.surface.startsWith('notification-') ? 'smtp-receipt-456' : event.handle, relatedEventHandle: context.serverEventHandle };
  };
  const report = await acceptObservability(selected, adapter, { authorizeTarget: target.origin, release: target.release, timeoutMs: 40, pollMs: 1 });
  assert.equal(report.surfaces['analytics-pageview'].status, 'pass');
  assert.equal(probes.filter(surface => surface === 'analytics-pageview').length, 1);
  assert.equal(report.surfaces['notification-smtp'].status, 'pass');
  assert.equal(report.surfaces['notification-smtp'].handle, 'smtp-receipt-456');
  assert.notEqual(report.surfaces['notification-smtp'].handle, serverHandle);
  assert.equal(report.surfaces['notification-inbox'].status, 'fail');
  assert.equal(report.status, 'fail');
  assert.ok(!probes.some(surface => surface.startsWith('notification-')));
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);
test('workflow requires explicit selection before loading executable driver and emits structured evidence', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.sporades', 'acceptance-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); await mkdir(config);
  const planFile = path.join(root, 'plan.json'); await writeFile(planFile, JSON.stringify(plan()));
  const driverFile = path.join(root, 'driver.mjs');
  const touched = path.join(root, 'loaded');
  await writeFile(driverFile, `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(touched)},'loaded'); export default { async probe(){throw new Error('synthetic-private-error');}, async cleanup(){}, async readBack(){return null;} };`);
  const args = ['scripts/accept-observability.mjs', '--plan', planFile, '--driver', driverFile];
  const invoke = extra => run(process.execPath, [...args, ...extra], { env: { ...process.env, SPORADES_CONFIG_DIR: config }, timeout: 60000 });
  const rejected = await invoke([]).then(() => null, error => error);
  assert.equal(rejected.code, 2);
  await assert.rejects(readFile(touched), { code: 'ENOENT' });
  const executed = await invoke(['--authorize-target', target.origin, '--release', target.release]).then(() => null, error => error);
  assert.equal(executed.code, 1);
  const report = JSON.parse(executed.stdout);
  assert.equal(report.status, 'fail');
  assert.equal(report.cleanup, 'pass');
  assert.equal(report.surfaces['server-error'].reason, 'probe-failed');
  assert.doesNotMatch(executed.stdout + executed.stderr, /synthetic-private-error/);
});

test('unrelated payloads and event-storage handles cannot pass redaction or notification delivery', async () => {
  const unrelated = await acceptObservability(plan(), driver(event => ({ ...event, payload: {} })), { authorizeTarget: target.origin, release: target.release });
  assert.equal(unrelated.status, 'fail');
  assert.equal(unrelated.surfaces['server-error'].reason, 'invalid-provider-evidence');
  const selected = plan(); selected.notifications = true;
  for (const surface of ['notification-smtp', 'notification-inbox']) selected.surfaces[surface] = { ...selected.surfaces['server-error'] };
  const adapter = driver(); const read = adapter.readBack;
  adapter.readBack = async context => ({ ...await read(context), relatedEventHandle: context.serverEventHandle });
  const report = await acceptObservability(selected, adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'fail');
  assert.equal(report.surfaces['notification-smtp'].reason, 'invalid-notification-receipt');
});

test('provider timestamps cannot smuggle private diagnostics into evidence', async () => {
  const adapter = driver(event => ({ ...event, timestamp: new Date().toUTCString() + ' (password=synthetic-private)' }));
  const probe = adapter.probe;
  adapter.probe = async context => { await new Promise(resolve => setTimeout(resolve, 1100)); return probe(context); };
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'pass');
  assert.match(report.surfaces['server-error'].timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private|password=/);
});

for (const canary of ['synthetic-"password"', 'synthetic-\\password', 'synthetic-\tpassword', 'synthetic-\npassword']) test('escaped synthetic credential leaks cannot pass redaction', async () => {
  const adapter = driver(event => ({ ...event, payload: { marker: event.marker, secret: canary } }));
  adapter.probe = async () => ({ capture: 'app-runtime', target, redactionCanaries: [canary] });
  const report = await acceptObservability(plan(), adapter, { authorizeTarget: target.origin, release: target.release });
  assert.equal(report.status, 'fail');
  assert.equal(report.surfaces['server-error'].reason, 'redaction-failed');
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
test('interrupting the command aborts its probe, cleans owned resources and emits unsuccessful evidence', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.sporades', 'acceptance-interrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); await mkdir(config);
  const planFile = path.join(root, 'plan.json'); await writeFile(planFile, JSON.stringify(plan()));
  const driverFile = path.join(root, 'driver.mjs'); const ready = path.join(root, 'owned-resource');
  await writeFile(driverFile, `import {writeFile,rm} from 'node:fs/promises'; export default { async probe(){await writeFile(${JSON.stringify(ready)},'ready');return new Promise(()=>{});}, async cleanup(){await rm(${JSON.stringify(ready)});}, async readBack(){return null;} };`);
  const child = spawn(process.execPath, ['scripts/accept-observability.mjs', '--plan', planFile, '--driver', driverFile,
    '--authorize-target', target.origin, '--release', target.release], { env: { ...process.env, SPORADES_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  const closed = once(child, 'close');
  const deadline = Date.now() + 15000;
  while (!await readFile(ready).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline && child.exitCode === null && child.signalCode === null, 'probe did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [1, null]);
  const report = JSON.parse(output);
  assert.equal(report.status, 'fail'); assert.equal(report.cleanup, 'pass');
  assert.equal(report.surfaces['server-error'].reason, 'interrupted');
  await assert.rejects(readFile(ready), { code: 'ENOENT' });
});

test('built workflow declarations resolve the shipped public driver and report types', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.sporades', 'acceptance-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'consumer.ts');
  const relative = target => path.relative(root, path.join(process.cwd(), target)).split(path.sep).join('/');
  await writeFile(file, `import {acceptObservability} from '${relative('dist/cli/observability-acceptance.js')}';
import type {AcceptanceDriver,AcceptancePlan,AcceptanceReport} from '${relative('src/types/observability-acceptance.js')}';
const gate: (plan: AcceptancePlan, driver: AcceptanceDriver, options: {authorizeTarget:string;release:string}) => Promise<AcceptanceReport> = acceptObservability;
void gate;
`);
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', file], {
    env: { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config') }, timeout: 150000,
  });
});
