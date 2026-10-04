import { createBoundedFixedWindow } from "./bounded-fixed-window.js";
import type { AdmissionGeneration } from "./types/admission-policy.js";

/** One quota table per runtime, bounded across all rules and trusted addresses. */
export function createAdmissionRateLimiter(options: { now?: () => number; maxBuckets?: number; onEviction?: () => void } = {}) {
  const windows = createBoundedFixedWindow({ ...options, idleMs: 86_400_000, expireWindows: true });
  let digest: string | null | undefined;
  let parameters = new Map<string, string>();
  function reconcile(generation: AdmissionGeneration | null) {
    if ((generation?.digest ?? null) === digest) return;
    const next = new Map<string, string>();
    for (const rule of generation?.policy.rules ?? []) {
      if (rule.enabled && rule.action.kind === "rate-limit") next.set(rule.id, `${rule.action.limit}:${rule.action.windowMs}`);
    }
    windows.retain(key => {
      const id = key.slice(0, key.indexOf("\0"));
      return next.has(id) && next.get(id) === parameters.get(id);
    });
    parameters = next;
    digest = generation?.digest ?? null;
  }
  function consume(id: string, address: string, limit: number, windowMs: number) {
    const key = `${id}\0${address}`;
    // Count denied matches too, saturating the counter to keep its size bounded.
    const counted = windows.record(key, windowMs, limit + 1);
    return counted.count <= limit ? 0 : counted.remainingSeconds;
  }
  return Object.freeze({ reconcile, consume, stats: windows.stats });
}
