import type { AdmissionGeneration } from "./types/admission-policy.js";
/** One quota table per runtime, bounded across all rules and trusted addresses. */
export declare function createAdmissionRateLimiter(options?: {
    now?: () => number;
    maxBuckets?: number;
    onEviction?: () => void;
}): Readonly<{
    reconcile: (generation: AdmissionGeneration | null) => void;
    consume: (id: string, address: string, limit: number, windowMs: number) => number;
    stats: () => Readonly<{
        buckets: number;
        maxBuckets: number;
        evictions: number;
    }>;
}>;
//# sourceMappingURL=admission-rate-limit.d.ts.map