export type RateLimitOptions = Readonly<{
    limit: number;
    windowMs: number;
}>;
export type RateLimitResult = Readonly<{
    ok: boolean;
    retryAfterMs: number;
}>;
export declare function validRateLimitOptions(value: any): value is RateLimitOptions;
/** One synchronous backend per Capsule runtime; replaceable independently of handler APIs. */
export declare function createCapsuleRateLimiter(options?: {
    now?: () => number;
    maxBuckets?: number;
}): Readonly<{
    consume(key: string, parameters: RateLimitOptions): RateLimitResult;
    stats: () => Readonly<{
        buckets: number;
        maxBuckets: number;
        evictions: number;
    }>;
}>;
export type RegistrationThrottle = Readonly<{
    email: RateLimitOptions;
    address: RateLimitOptions;
}>;
/** Opt-in for 0.9.x compatibility; explicit configuration enables both dimensions. */
export declare function resolveRegistrationThrottle(auth: any): RegistrationThrottle | null;
//# sourceMappingURL=capsule-rate-limit.d.ts.map