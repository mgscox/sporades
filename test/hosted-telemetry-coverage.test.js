import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedTelemetryConfig, hostedTelemetryCoverage } from '../dist/cli/hosted-telemetry-coverage.js';

const connection = { schemaVersion: 1, internalEndpoint: 'http://sporades-telemetry:4318/', network: 'sporades-hosted-capsules', metricsIntervalMs: 10000 };
const capsule = { domain: 'capsules.example', subname: 'alpha' };

test('Host connection enables Capsules by default with a canonical identity', () => {
  assert.deepEqual(hostedTelemetryConfig(connection, capsule), { endpoint: connection.internalEndpoint, tls: { mode: 'loopback' }, serviceName: 'capsules.example/alpha', environment: 'hosted', metricsIntervalMs: 10000 });
  assert.equal(hostedTelemetryConfig(connection, { ...capsule, telemetry: { disabled: true } }), null);
  assert.equal(hostedTelemetryConfig(null, capsule), null);
  assert.deepEqual(hostedTelemetryConfig({ ...connection, tracePropagationOrigins: ['https://dependency.example'] }, capsule).tracePropagationOrigins, ['https://dependency.example']);
});

test('coverage distinguishes desired settings from live runtime proof', () => {
  assert.equal(hostedTelemetryCoverage(true, false, null).state, 'pending-start');
  assert.equal(hostedTelemetryCoverage(true, true, null).state, 'unverified');
  assert.equal(hostedTelemetryCoverage(true, true, null).restartRequired, null);
  assert.equal(hostedTelemetryCoverage(false, true, null).state, 'unverified');
  assert.equal(hostedTelemetryCoverage(true, true, { supported: true, enabled: true, serviceName: 'capsules.example/alpha' }, 'capsules.example/alpha').state, 'instrumented');
  assert.equal(hostedTelemetryCoverage(true, true, { supported: true, enabled: true, serviceName: 'other' }, 'capsules.example/alpha').state, 'pending-restart');
  assert.equal(hostedTelemetryCoverage(false, true, { supported: true, enabled: true }).state, 'pending-restart');
  assert.equal(hostedTelemetryCoverage(true, true, { supported: true, enabled: true, serviceName: 'capsules.example/alpha', configHash: 'old' }, 'capsules.example/alpha', 'new').state, 'pending-restart');
});
