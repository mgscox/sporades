/** Internal local fixed windows with deterministic least-recently-recorded eviction. */
export declare function createBoundedFixedWindow(options?: {
    now?: () => number;
    maxBuckets?: number;
    idleMs?: number;
    expireWindows?: boolean;
    onEviction?: () => void;
}): Readonly<{
    retryAfter: (key: string, limit: number, windowMs: number) => number;
    record: (key: string, windowMs: number, ceiling?: number) => {
        count: number;
        remainingSeconds: number;
    };
    delete: (key: string) => boolean;
    retain: (keep: (key: string) => boolean) => void;
    stats: () => Readonly<{
        buckets: number;
        maxBuckets: number;
        evictions: number;
    }>;
}>;
//# sourceMappingURL=bounded-fixed-window.d.ts.map