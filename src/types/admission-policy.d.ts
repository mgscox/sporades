/** Deployer-owned JSON policy. HTTP exact-path deny is enforced before Capsule code.
 * Other conditions and quota actions are reserved for later slices and currently fail closed when indeterminate. */
export type AdmissionCondition =
  | { kind: "method"; value: string }
  | { kind: "pathname"; exact: string } | { kind: "pathname"; prefix: string }
  | { kind: "address"; value: string }
  | { kind: "header"; name: string; value?: string }
  | { kind: "query-key"; name: string };
export type AdmissionAction = { kind: "deny" } | { kind: "rate-limit"; limit: number; windowMs: number };
export type AdmissionPolicy = { version: 1; rules: readonly { id: string; enabled: boolean; conditions: readonly AdmissionCondition[]; action: AdmissionAction }[] };
export type AdmissionGeneration = Readonly<{ digest: string; policy: AdmissionPolicy }>;
export type AdmissionHealth = Readonly<{ state: "healthy" | "degraded" | "disabled"; digest: string | null }>;
export type AdmissionPolicyConfig = { path: string };
