import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveLocalTelemetryConfig, resolveContainerTelemetryConfig } from '../dist/cli/telemetry-profile.js';

test('installed CLI stores reference-only profiles and Dev selection honors explicit precedence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sporades-telemetry-profile-'));
  const oldConfigDir = process.env.SPORADES_CONFIG_DIR;
  const oldToken = process.env.TRACE_INGEST_TOKEN;
  process.env.SPORADES_CONFIG_DIR = directory;
  process.env.TRACE_INGEST_TOKEN = 'private-test-token';
  const cli = (...args) => spawnSync(process.execPath, ['bin/sporades.js', 'telemetry', 'profile', ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: process.env,
  });
  try {
    const added = cli('add', 'local', '--endpoint', 'http://127.0.0.1:4318', '--loopback', '--credential-env', 'TRACE_INGEST_TOKEN', '--json');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).data.profile.credentialEnv, 'TRACE_INGEST_TOKEN');
    assert.doesNotMatch(await readFile(path.join(directory, 'telemetry.json'), 'utf8'), /private-test-token/);
    const rejected = cli('add', 'bad', '--endpoint', 'https://user:password@example.com?token=secret', '--json');
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /password|secret/);
    assert.equal((await resolveLocalTelemetryConfig({ name: 'capsule' })), null);
    await assert.rejects(resolveLocalTelemetryConfig({ telemetry: { profile: 'constructor' } }), /Unknown Telemetry profile/);
    assert.equal(cli('show', 'constructor', '--json').status, 1);
    const inheritedName = cli('add', 'constructor', '--endpoint', 'http://localhost:4321', '--loopback', '--json');
    assert.equal(inheritedName.status, 0, inheritedName.stderr);
    assert.equal((await resolveLocalTelemetryConfig({ telemetry: { profile: 'constructor' } })).endpoint, 'http://localhost:4321');
    assert.equal(JSON.parse(cli('show', 'constructor', '--json').stdout).data.profile.endpoint, 'http://localhost:4321');
    assert.equal(cli('remove', 'constructor', '--json').status, 0);
    await assert.rejects(resolveLocalTelemetryConfig({ telemetry: { profile: 'constructor' } }), /Unknown Telemetry profile/);
    assert.equal((await resolveLocalTelemetryConfig({ name: 'capsule', telemetry: { profile: 'local' } })).endpoint, 'http://127.0.0.1:4318');
    assert.equal((await resolveLocalTelemetryConfig({ name: 'capsule', telemetry: { profile: 'local' } })).environment, 'dev');
    const tuned = cli('add', 'tuned', '--endpoint', 'http://localhost:4318', '--loopback', '--metrics-interval-ms', '5000', '--json');
    assert.equal(tuned.status, 0, tuned.stderr);
    assert.equal(JSON.parse(cli('show', 'tuned', '--json').stdout).data.profile.metricsIntervalMs, 5000);
    assert.equal((await resolveLocalTelemetryConfig({ telemetry: { profile: 'tuned' } })).metricsIntervalMs, 5000);
    assert.equal(cli('add', 'too-fast', '--endpoint', 'http://localhost:4318', '--loopback', '--metrics-interval-ms', '100', '--json').status, 1);
    const precision = cli('add', 'precise', '--endpoint', 'http://localhost:4318', '--loopback', '--event-loop-delay-resolution-ms', '40', '--json');
    assert.equal(precision.status, 0, precision.stderr);
    assert.equal((await resolveLocalTelemetryConfig({ telemetry: { profile: 'precise' } })).eventLoopDelayResolutionMs, 40);
    for (const invalid of ['0', '9', '1001', '20.5', 'NaN']) {
      assert.equal(cli('add', 'invalid-precision', '--endpoint', 'http://localhost:4318', '--loopback', '--event-loop-delay-resolution-ms', invalid, '--json').status, 1, invalid);
    }
    const propagation = cli('add', 'outbound', '--endpoint', 'http://localhost:4318', '--loopback', '--trace-propagation-origin', 'https://DEPENDENCY.example:443/', '--trace-propagation-origin', 'http://127.0.0.1:5218', '--json');
    assert.equal(propagation.status, 0, propagation.stderr);
    const origins = ['https://dependency.example', 'http://127.0.0.1:5218'];
    assert.deepEqual(JSON.parse(cli('show', 'outbound', '--json').stdout).data.profile.tracePropagationOrigins, origins);
    assert.deepEqual((await resolveLocalTelemetryConfig({}, 'outbound')).tracePropagationOrigins, origins);
    assert.deepEqual((await resolveContainerTelemetryConfig({}, 'outbound')).tracePropagationOrigins, origins);
    for (const value of ['*', 'https://user:private-secret@example.com', 'https://example.com/private-secret', 'https://example.com?private-secret']) {
      const rejectedOrigin = cli('add', 'invalid-outbound', '--endpoint', 'http://localhost:4318', '--loopback', '--trace-propagation-origin', value, '--json');
      assert.equal(rejectedOrigin.status, 1);
      assert.doesNotMatch(rejectedOrigin.stdout + rejectedOrigin.stderr, /private-secret/);
    }

    const second = cli('add', 'other', '--endpoint', 'http://localhost:4320', '--loopback', '--json');
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await resolveLocalTelemetryConfig({ name: 'capsule', telemetry: { profile: 'local' } }, 'other')).endpoint, 'http://localhost:4320');
    delete process.env.TRACE_INGEST_TOKEN;
    await assert.rejects(resolveLocalTelemetryConfig({ telemetry: { profile: 'local' } }), /credential is unavailable/);
  } finally {
    if (oldConfigDir === undefined) delete process.env.SPORADES_CONFIG_DIR; else process.env.SPORADES_CONFIG_DIR = oldConfigDir;
    if (oldToken === undefined) delete process.env.TRACE_INGEST_TOKEN; else process.env.TRACE_INGEST_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  }
});
