import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// The observer budget is separate from the notification SLA. A delayed poll
// must inspect an already-recorded receipt before deciding that evidence is lost.
export async function waitForEvidence(read, {
  timeoutMs = 120_000,
  pollMs = 1000,
  now = () => performance.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  const began = now();
  let lastError;
  for (;;) {
    try { const value = await read(); if (value) return value; } catch (error) { lastError = error; }
    const remaining = timeoutMs - (now() - began);
    if (remaining <= 0) throw new Error('Acceptance evidence deadline exceeded.', { cause: lastError });
    await sleep(Math.min(pollMs, remaining));
  }
}

const timestamp = value => {
  assert.equal(typeof value, 'string', 'Expected a recorded monotonic timestamp');
  assert.match(value, /^\d+$/);
  return BigInt(value);
};

export function findProbeFiring(deliveries, blockedAtNs) {
  const began = timestamp(blockedAtNs);
  return deliveries.find(delivery => timestamp(delivery.receivedAtNs) >= began &&
    delivery.alerts.some(alert => alert.labels.alertname === 'SporadesProbeFailure' && alert.status === 'firing'));
}

// Both timestamps come from processes on the same disposable Docker Linux VM.
// Never compare a host observer clock with a container clock, or Date.now().
export function assertNotificationDeadline(blockedAtNs, receivedAtNs, deadlineMs = 120_000) {
  const elapsedNs = timestamp(receivedAtNs) - timestamp(blockedAtNs);
  assert(elapsedNs >= 0n, 'Notification predates the blocked request');
  assert(elapsedNs <= BigInt(deadlineMs) * 1_000_000n,
    `Probe firing notification exceeded ${deadlineMs} ms: ${Number(elapsedNs) / 1_000_000} ms`);
  return Number(elapsedNs) / 1_000_000;
}
