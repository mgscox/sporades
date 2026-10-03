/** Deployer-owned JSON policy. HTTP exact-path and trusted Hosted address denial/quotas precede Capsule code.
 * Fixed-window quotas require trusted Hosted identity; other conditions fail closed when indeterminate. */
export type AdmissionCondition =
  | { kind: "method"; value: string }
  | { kind: "pathname"; exact: string } | { kind: "pathname"; prefix: string }
  /** Exact IPv4/IPv6 or CIDR; mapped IPv6 normalizes to IPv4 (/96..128 maps to /0..32).
   * A potentially applicable enabled address rule without Host-authenticated identity denies.
   * Dev/local Container have no trusted address; other rules still operate. */
  | { kind: "address"; value: string }
  | { kind: "header"; name: string; value?: string }
  | { kind: "query-key"; name: string };
/** Rate limits use monotonic, per-process windows keyed by stable rule ID and trusted address.
 * Matching requests count, including over-quota requests; restart resets buckets.
 * Compatible IDs/parameters survive reload. Missing identity fails closed with 403. */
export type AdmissionAction = { kind: "deny" } | { kind: "rate-limit"; limit: number; windowMs: number };
export type AdmissionPolicy = { version: 1; rules: readonly { id: string; enabled: boolean; conditions: readonly AdmissionCondition[]; action: AdmissionAction }[] };
export type AdmissionGeneration = Readonly<{ digest: string; policy: AdmissionPolicy }>;
export type AdmissionHealth = Readonly<{ state: "healthy" | "degraded" | "disabled"; digest: string | null;
  /** Aggregate local quota diagnostics; no rule IDs or client addresses. */
  rateLimit?: Readonly<{ buckets: number; maxBuckets: number; evictions: number }>;
}>;
export type AdmissionPolicyConfig = { path: string };
