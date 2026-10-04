/** Deployer-owned JSON policy. HTTP and pre-switch WebSocket upgrades share one generation,
 * AND conditions and ordered first-match denial/quotas, including /__sporades/ws Capsule traffic.
 * Reserved GET controls have no WebSocket transport and never count quota buckets.
 * Methods are uppercase ASCII; paths decode once and normalize dot segments, prefixes follow segment boundaries.
 * Header names are lowercase non-sensitive tokens; values have no outer whitespace. Presence accepts duplicates;
 * exact values require one raw occurrence (ambiguous duplicates fail closed). Query keys decode once, case-sensitively.
 * Missing trusted address identity is indeterminate; fixed-window quotas require trusted Hosted identity. */
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
/** v1 per-process unsigned 64-bit decimal totals, exact until the explicit saturation ceiling.
 * No request, rule, address or policy-value dimensions. Process restart resets evidence;
 * Dev runtime replacement, policy-path changes and disable/re-enable retain totals and sampling. */
export type AdmissionEvidence = Readonly<{
  version: 1;
  counters: Readonly<Record<"evaluated" | "admitted" | "denied" | "rateLimited" | "reloadFailures" | "reloadRecoveries" | "limiterEvictions" | "decisionsEmitted" | "decisionsSuppressed", string>>;
  saturated: boolean;
  sampling: Readonly<{ windowMs: number; decisionsPerWindow: number; sampleKeys: number; counterMax: string; retainedKeys: number }>;
}>;
export type AdmissionHealth = Readonly<{ state: "healthy" | "degraded" | "disabled"; digest: string | null;
  /** Aggregate local quota diagnostics; no rule IDs or client addresses. */
  rateLimit?: Readonly<{ buckets: number; maxBuckets: number; evictions: number }>;
  evidence?: AdmissionEvidence;
}>;
export type AdmissionPolicyConfig = { path: string };
