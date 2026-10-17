import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapsuleRateLimiter } from '../dist/capsule-rate-limit.js';

test('fixed windows allow exact boundaries and round fractional remaining time up', () => {
  let now = 100.25;
  const limiter = createCapsuleRateLimiter({ now: () => now });
  assert.deepEqual(limiter.consume('capsule-a', { limit: 2, windowMs: 1000 }), { ok: true, retryAfterMs: 0 });
  now = 1000.25;
  assert.deepEqual(limiter.consume('capsule-a', { limit: 2, windowMs: 1000 }), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume('capsule-a', { limit: 2, windowMs: 1000 }), { ok: false, retryAfterMs: 100 });
  now = 1100;
  assert.deepEqual(limiter.consume('capsule-a', { limit: 2, windowMs: 1000 }), { ok: false, retryAfterMs: 1 });
  now = 1100.25;
  assert.deepEqual(limiter.consume('capsule-a', { limit: 2, windowMs: 1000 }), { ok: true, retryAfterMs: 0 });
});

test('denials saturate without extending the window or consuming additional quota', () => {
  let now = 0;
  const limiter = createCapsuleRateLimiter({ now: () => now });
  assert.equal(limiter.consume('key', { limit: 1, windowMs: 500 }).ok, true);
  for (const time of [1, 50.1, 499.999]) {
    now = time;
    assert.deepEqual(limiter.consume('key', { limit: 1, windowMs: 500 }), { ok: false, retryAfterMs: Math.ceil(500 - time) });
  }
  now = 500;
  assert.deepEqual(limiter.consume('key', { limit: 1, windowMs: 500 }), { ok: true, retryAfterMs: 0 });
});

test('LRU capacity eviction is deterministic and only evicts the least recently used bucket', () => {
  let now = 0;
  const limiter = createCapsuleRateLimiter({ now: () => now, maxBuckets: 2 });
  const options = { limit: 1, windowMs: 10000 };
  limiter.consume('a', options);
  limiter.consume('b', options);
  assert.equal(limiter.consume('a', options).ok, false); // refresh a
  limiter.consume('c', options); // evicts b
  assert.deepEqual(limiter.stats(), { buckets: 2, maxBuckets: 2, evictions: 1 });
  assert.deepEqual(limiter.consume('a', options), { ok: false, retryAfterMs: 10000 });
  assert.deepEqual(limiter.consume('b', options), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.stats(), { buckets: 2, maxBuckets: 2, evictions: 2 });
});

test('keys and limiter parameters are validated at the boundary', () => {
  assert.throws(() => createCapsuleRateLimiter({ maxBuckets: 0 }));
  assert.throws(() => createCapsuleRateLimiter({ maxBuckets: 1.5 }));
  const limiter = createCapsuleRateLimiter();
  for (const key of ['', 'x'.repeat(1025), 'é'.repeat(513)]) {
    assert.throws(() => limiter.consume(key, { limit: 1, windowMs: 1000 }));
  }
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    assert.throws(() => limiter.consume('key', { limit, windowMs: 1000 }));
  }
  for (const windowMs of [0, -1, 1.5, 86400001, Infinity, NaN]) {
    assert.throws(() => limiter.consume('key', { limit: 1, windowMs }));
  }
});

test('key byte limit, parameter isolation, and active long windows are preserved', () => {
  let now = 0;
  const limiter = createCapsuleRateLimiter({ now: () => now });
  const key = 'é'.repeat(512); // exactly 1024 UTF-8 bytes
  const first = { limit: 1, windowMs: 86400000 };
  assert.deepEqual(limiter.consume(key, first), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume(key, first), { ok: false, retryAfterMs: 86400000 });
  assert.deepEqual(limiter.consume(key, { limit: 2, windowMs: 86400000 }), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume(key, { limit: 1, windowMs: 86399999 }), { ok: true, retryAfterMs: 0 });
  now = 3600000;
  assert.equal(limiter.consume(key, first).ok, false, 'a one-hour idle gap cannot erase an active daily window');
  now = 86400000;
  assert.deepEqual(limiter.consume(key, first), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.stats(), { buckets: 1, maxBuckets: 10000, evictions: 0 });
});
