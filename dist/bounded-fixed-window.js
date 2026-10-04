import { performance } from "node:perf_hooks";
/** Internal local fixed windows with deterministic least-recently-recorded eviction. */
export function createBoundedFixedWindow(options = {}) {
    const now = options.now ?? (() => performance.now());
    const maxBuckets = options.maxBuckets ?? 10_000;
    const idleMs = options.idleMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1 || !Number.isFinite(idleMs) || idleMs < 0)
        throw new Error("Invalid limiter bounds.");
    const buckets = new Map();
    let evictions = 0;
    function retryAfter(key, limit, windowMs) {
        const bucket = buckets.get(key);
        const remaining = bucket ? windowMs - (now() - bucket.startedAt) : 0;
        return bucket && bucket.count >= limit && remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }
    function record(key, windowMs, ceiling = Number.MAX_SAFE_INTEGER) {
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
            if (elapsed - state.lastSeenAt > idleMs || (options.expireWindows && elapsed - state.startedAt >= state.windowMs))
                buckets.delete(candidate);
            else if (!options.expireWindows)
                break;
        }
        while (buckets.size > maxBuckets) {
            buckets.delete(buckets.keys().next().value);
            evictions = Math.min(Number.MAX_SAFE_INTEGER, evictions + 1);
            try {
                options.onEviction?.();
            }
            catch { /* Diagnostics never alter quotas. */ }
        }
        return { count: bucket.count, remainingSeconds: Math.ceil((windowMs - (elapsed - bucket.startedAt)) / 1000) };
    }
    return Object.freeze({ retryAfter, record,
        delete: (key) => buckets.delete(key),
        retain: (keep) => { for (const key of buckets.keys())
            if (!keep(key))
                buckets.delete(key); },
        stats: () => Object.freeze({ buckets: buckets.size, maxBuckets, evictions }), });
}
//# sourceMappingURL=bounded-fixed-window.js.map