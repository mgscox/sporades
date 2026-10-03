/** Deployer-owned JSON policy. HTTP exact-path and trusted Hosted address deny precede Capsule code.
 * Other conditions and quota actions are reserved for later slices and currently fail closed when indeterminate. */
export type AdmissionCondition =
  | { kind: "method"; value: string }
  | { kind: "pathname"; exact: string } | { kind: "pathname"; prefix: string }
  /** Exact IPv4/IPv6 or CIDR; mapped IPv6 normalizes to IPv4 (/96..128 maps to /0..32).
   * A potentially applicable enabled address rule without Host-authenticated identity denies.
   * Dev/local Container have no trusted address; other rules still operate. */
  | { kind: "address"; value: string }
  | { kind: "header"; name: string; value?: string }
  | { kind: "query-key"; name: string };
export type AdmissionAction = { kind: "deny" } | { kind: "rate-limit"; limit: number; windowMs: number };
export type AdmissionPolicy = { version: 1; rules: readonly { id: string; enabled: boolean; conditions: readonly AdmissionCondition[]; action: AdmissionAction }[] };
export type AdmissionGeneration = Readonly<{ digest: string; policy: AdmissionPolicy }>;
export type AdmissionHealth = Readonly<{ state: "healthy" | "degraded" | "disabled"; digest: string | null }>;
export type AdmissionPolicyConfig = { path: string };
