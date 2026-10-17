import { createBoundedFixedWindow } from "./bounded-fixed-window.js";

export type RateLimitOptions = Readonly<{ limit: number; windowMs: number }>;
export type RateLimitResult = Readonly<{ ok: boolean; retryAfterMs: number }>;

export function validRateLimitOptions(value: any): value is RateLimitOptions {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit < Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(value.windowMs) && value.windowMs > 0 && value.windowMs <= 86_400_000;
}

/** One synchronous backend per Capsule runtime; replaceable independently of handler APIs. */
export function createCapsuleRateLimiter(options: { now?: () => number; maxBuckets?: number } = {}) {
  // Never idle-expire a still-active window (the longest supported window is a day).
  const windows = createBoundedFixedWindow({ ...options, idleMs: 86_400_000, expireWindows: true });
  return Object.freeze({
    consume(key: string, parameters: RateLimitOptions): RateLimitResult {
      if (typeof key !== "string" || !key.length || Buffer.byteLength(key, "utf8") > 1024 || !validRateLimitOptions(parameters)) {
        throw Object.assign(new Error("Invalid rate limit key or options."), { code: "INVALID_RATE_LIMIT" });
      }
      const bucket = windows.record(JSON.stringify([key, parameters.limit, parameters.windowMs]), parameters.windowMs, parameters.limit + 1);
      const ok = bucket.count <= parameters.limit;
      return Object.freeze({ ok, retryAfterMs: ok ? 0 : bucket.remainingMs });
    },
    stats: windows.stats,
  });
}

export type RegistrationThrottle = Readonly<{ email: RateLimitOptions; address: RateLimitOptions }>;

/** Opt-in for 0.9.x compatibility; explicit configuration enables both dimensions. */
export function resolveRegistrationThrottle(auth: any): RegistrationThrottle | null {
  const value = auth?.email?.registration?.throttle;
  if (value === undefined || value === false) return null;
  const invalid = () => { throw Object.assign(new Error("Invalid auth.email.registration.throttle configuration."), { code: "INVALID_AUTH_CONFIG" }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["email", "address"].includes(key))) return invalid();
  const email = value.email === undefined ? { limit: 5, windowMs: 900_000 } : value.email;
  const address = value.address === undefined ? { limit: 20, windowMs: 900_000 } : value.address;
  for (const parameters of [email, address]) {
    if (!validRateLimitOptions(parameters) || Object.keys(parameters).some(key => !["limit", "windowMs"].includes(key))) return invalid();
  }
  return Object.freeze({ email: Object.freeze({ ...email }), address: Object.freeze({ ...address }) });
}
