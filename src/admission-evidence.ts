import { performance } from "node:perf_hooks";
import type { AdmissionEvidence, AdmissionHealth } from "./types/admission-policy.js";

export const ADMISSION_EVIDENCE_LIMITS = Object.freeze({ windowMs: 60_000, decisionsPerWindow: 20, sampleKeys: 20, counterMax: "18446744073709551615" });
const counterMax = BigInt(ADMISSION_EVIDENCE_LIMITS.counterMax);
const counterNames = ["evaluated", "admitted", "denied", "rateLimited", "reloadFailures", "reloadRecoveries", "limiterEvictions", "decisionsEmitted", "decisionsSuppressed"] as const;
type Counter = typeof counterNames[number];
export type AdmissionDecision = Readonly<{
  digest: string; ruleId: string | null; action: "deny" | "rate-limit" | null;
  outcome: "admitted" | "denied" | "rate-limited";
  sessionKind: "dev" | "public-dev" | "container" | "hosted";
  transport: "http" | "websocket"; routeClass: "ordinary" | "capsule-transport" | "invalid";
}>;

/** Fixed aggregate counters; at most twenty retained sample keys, never request values. */
export function createAdmissionEvidence(now = () => performance.now()) {
  const counters = Object.fromEntries(counterNames.map(name => [name, 0n])) as Record<Counter, bigint>;
  let saturated = false;
  let startedAt = now();
  const samples = new Set<string>();
  function count(name: Counter) {
    if (counters[name] === counterMax) saturated = true;
    else counters[name]++;
  }
  function decision(value: AdmissionDecision, emit?: (value: AdmissionDecision) => void) {
    count("evaluated");
    count(value.outcome === "rate-limited" ? "rateLimited" : value.outcome);
    const elapsed = now();
    if (elapsed - startedAt >= ADMISSION_EVIDENCE_LIMITS.windowMs) { startedAt = elapsed; samples.clear(); }
    // The global bound also caps distinct rule IDs across arbitrary policy churn.
    const key = `${value.ruleId ?? ""}:${value.outcome}`;
    if (!emit || samples.size >= ADMISSION_EVIDENCE_LIMITS.decisionsPerWindow || samples.has(key)) { count("decisionsSuppressed"); return; }
    samples.add(key); count("decisionsEmitted");
    try { emit(value); } catch { /* Evidence cannot alter admission. */ }
  }
  function snapshot(): AdmissionEvidence {
    return Object.freeze({ version: 1, counters: Object.freeze(Object.fromEntries(counterNames.map(name => [name, String(counters[name])])) as AdmissionEvidence["counters"]), saturated,
      sampling: Object.freeze({ ...ADMISSION_EVIDENCE_LIMITS, retainedKeys: samples.size }) });
  }
  return Object.freeze({ count, decision, snapshot });
}

/** Operator surfaces reconstruct a closed shape, even from an untrusted runtime response. */
export function inspectAdmissionHealth(value: any): AdmissionHealth | null {
  if (!value || !["healthy", "degraded", "disabled"].includes(value.state) || !(value.digest === null || (typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)))) return null;
  const health: { state: AdmissionHealth["state"]; digest: string | null; rateLimit?: AdmissionHealth["rateLimit"]; evidence?: AdmissionEvidence } = { state: value.state, digest: value.digest };
  const rate = value.rateLimit;
  if (rate && [rate.buckets, rate.maxBuckets, rate.evictions].every(item => Number.isSafeInteger(item) && item >= 0) && rate.buckets <= rate.maxBuckets) health.rateLimit = Object.freeze({ buckets: rate.buckets, maxBuckets: rate.maxBuckets, evictions: rate.evictions });
  const evidence = value.evidence;
  if (evidence?.version === 1 && typeof evidence.saturated === "boolean" && counterNames.every(name => typeof evidence.counters?.[name] === "string" && /^(0|[1-9][0-9]{0,19})$/.test(evidence.counters[name]) && BigInt(evidence.counters[name]) <= counterMax)) {
    const retainedKeys = evidence.sampling?.retainedKeys;
    if (Number.isInteger(retainedKeys) && retainedKeys >= 0 && retainedKeys <= ADMISSION_EVIDENCE_LIMITS.sampleKeys) health.evidence = Object.freeze({ version: 1, saturated: evidence.saturated,
      counters: Object.freeze(Object.fromEntries(counterNames.map(name => [name, evidence.counters[name]])) as AdmissionEvidence["counters"]),
      sampling: Object.freeze({ ...ADMISSION_EVIDENCE_LIMITS, retainedKeys }) });
  }
  return Object.freeze(health);
}
