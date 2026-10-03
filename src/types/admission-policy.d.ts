/** Deployer-owned JSON policy. Non-address HTTP conditions use AND and ordered first-match denial.
 * Methods are uppercase ASCII; paths decode once and normalize dot segments, prefixes follow segment boundaries.
 * Header names are lowercase non-sensitive tokens; values have no outer whitespace. Presence accepts duplicates;
 * exact values require one raw occurrence (ambiguous duplicates fail closed). Query keys decode once, case-sensitively.
 * Address conditions and quota actions remain reserved and fail closed when indeterminate. */
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
