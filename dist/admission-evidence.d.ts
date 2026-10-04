import type { AdmissionEvidence, AdmissionHealth } from "./types/admission-policy.js";
export declare const ADMISSION_EVIDENCE_LIMITS: Readonly<{
    windowMs: 60000;
    decisionsPerWindow: 20;
    sampleKeys: 20;
    counterMax: "18446744073709551615";
}>;
declare const counterNames: readonly ["evaluated", "admitted", "denied", "rateLimited", "reloadFailures", "reloadRecoveries", "limiterEvictions", "decisionsEmitted", "decisionsSuppressed"];
type Counter = typeof counterNames[number];
export type AdmissionDecision = Readonly<{
    digest: string;
    ruleId: string | null;
    action: "deny" | "rate-limit" | null;
    outcome: "admitted" | "denied" | "rate-limited";
    sessionKind: "dev" | "public-dev" | "container" | "hosted";
    transport: "http" | "websocket";
    routeClass: "ordinary" | "capsule-transport" | "invalid";
}>;
/** Fixed aggregate counters; at most twenty retained sample keys, never request values. */
export declare function createAdmissionEvidence(now?: () => number): Readonly<{
    count: (name: Counter) => void;
    decision: (value: AdmissionDecision, emit?: (value: AdmissionDecision) => void) => void;
    snapshot: () => AdmissionEvidence;
}>;
/** Operator surfaces reconstruct a closed shape, even from an untrusted runtime response. */
export declare function inspectAdmissionHealth(value: any): AdmissionHealth | null;
export {};
//# sourceMappingURL=admission-evidence.d.ts.map