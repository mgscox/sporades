import { performance } from "node:perf_hooks";

type Bucket = { count: number; startedAt: number; lastSeenAt: number; windowMs: number };

/** Internal local fixed windows with deterministic least-recently-recorded eviction. */
export function createBoundedFixedWindow(options: {
  now?: () => number; maxBuckets?: number; idleMs?: number; expireWindows?: boolean;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const maxBuckets = options.maxBuckets ?? 10_000;
  const idleMs = options.idleMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1 || !Number.isFinite(idleMs) || idleMs < 0) throw new Error("Invalid limiter bounds.");
  const buckets = new Map<string, Bucket>();
  let evictions = 0;
  function retryAfter(key: string, limit: number, windowMs: number) {
    const bucket = buckets.get(key);
    const remaining = bucket ? windowMs - (now() - bucket.startedAt) : 0;
    return bucket && bucket.count >= limit && remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }
  function record(key: string, windowMs: number, ceiling = Number.MAX_SAFE_INTEGER) {
    const elapsed = now();
    const previous = buckets.get(key);
    const bucket = !previous || elapsed - previous.startedAt >= windowMs
      ? { count: 1, startedAt: elapsed, lastSeenAt: elapsed, windowMs }
      : { ...previous, count: Math.min(previous.count + 1, ceiling), lastSeenAt: elapsed };
    buckets.delete(key);
    buckets.set(key, bucket);
    // Access-key compatibility: idle expiry is strict and checked in LRU order.
    // Quotas also discard expired windows, including recent but already expired ones.
    for (const [candidate, state] of buckets) {
      if (elapsed - state.lastSeenAt > idleMs || (options.expireWindows && elapsed - state.startedAt >= state.windowMs)) buckets.delete(candidate);
      else if (!options.expireWindows) break;
    }
    while (buckets.size > maxBuckets) {
      buckets.delete(buckets.keys().next().value!);
      evictions++;
    }
    return { count: bucket.count, remainingSeconds: Math.ceil((windowMs - (elapsed - bucket.startedAt)) / 1000) };
  }
  return Object.freeze({ retryAfter, record,
    delete: (key: string) => buckets.delete(key),
    retain: (keep: (key: string) => boolean) => { for (const key of buckets.keys()) if (!keep(key)) buckets.delete(key); },
    stats: () => Object.freeze({ buckets: buckets.size, maxBuckets, evictions }),
  });
}
