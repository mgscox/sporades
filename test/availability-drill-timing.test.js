import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForEvidence, findProbeFiring, assertNotificationDeadline } from '../scripts/availability-drill-timing.mjs';

const ns = milliseconds => (BigInt(milliseconds) * 1_000_000n).toString();
const receipt = (milliseconds, status = 'firing', alertname = 'SporadesProbeFailure') => ({
  receivedAtNs: ns(milliseconds), alerts: [{ labels: { alertname }, status }],
});

test('notification observation ignores frozen, backward and forward wall-clock changes', async () => {
  const original = Date.now;
  try {
    for (const wallClock of [() => 0, () => -200_000, () => 200_000]) {
      Date.now = wallClock;
      let now = 0;
      const found = await waitForEvidence(() => now >= 1000 && receipt(95_000), {
        now: () => now, sleep: async milliseconds => { now += milliseconds; },
      });
      assert.equal(assertNotificationDeadline(ns(0), found.receivedAtNs), 95_000);
      assert.equal(now, 1000);
    }
  } finally { Date.now = original; }
});

test('late observer accepts a recorded on-time firing without relaxing its 120-second deadline', async () => {
  let now = 0;
  const deliveries = [];
  const found = await waitForEvidence(() => findProbeFiring(deliveries, ns(0)), {
    now: () => now,
    // Model a descheduled observer. The receiver already recorded delivery.
    sleep: async () => { deliveries.push(receipt(120_000)); now = 125_000; },
  });
  assert.equal(assertNotificationDeadline(ns(0), found.receivedAtNs), 120_000);
});

test('notification deadline rejects even one nanosecond after its exact boundary', () => {
  assert.equal(assertNotificationDeadline(ns(1000), ns(121_000)), 120_000);
  assert.throws(() => assertNotificationDeadline(ns(1000), (BigInt(ns(121_000)) + 1n).toString()), /exceeded 120000 ms/);
  assert.throws(() => assertNotificationDeadline(ns(1000), ns(999)), /predates/);
});

test('observing an actually late receipt still fails the notification deadline', async () => {
  const found = await waitForEvidence(() => receipt(120_001), { now: () => 0 });
  assert.throws(() => assertNotificationDeadline(ns(0), found.receivedAtNs), /exceeded 120000 ms/);
});

test('firing correlation excludes startup deliveries, recovery and other alerts', () => {
  const firing = receipt(96_000);
  assert.equal(findProbeFiring([receipt(99), receipt(90_000, 'resolved'), receipt(95_000, 'firing', 'SporadesHostTelemetryAbsent'), firing], ns(100)), firing);
});

test('missing evidence fails within the injected monotonic budget despite a frozen wall clock', async () => {
  let now = 0; let reads = 0;
  await assert.rejects(waitForEvidence(() => { reads += 1; throw new Error('receipt not written'); }, {
    timeoutMs: 3000, now: () => now, sleep: async milliseconds => { now += milliseconds; },
  }), error => error.message === 'Acceptance evidence deadline exceeded.' && error.cause?.message === 'receipt not written');
  assert.equal(now, 3000); assert.equal(reads, 4);
});
