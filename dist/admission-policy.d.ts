import { createAdmissionRateLimiter } from "./admission-rate-limit.js";
import { type BuiltDeployFile } from "./deploy-files.js";
export declare const ADMISSION_LIMITS: Readonly<{
    bytes: 65536;
    depth: 8;
    rules: 128;
    conditions: 16;
    textBytes: 1024;
    reloadMs: 2000;
}>;
export type { AdmissionCondition, AdmissionAction, AdmissionPolicy, AdmissionGeneration, AdmissionHealth } from "../src/types/admission-policy.js";
import type { AdmissionGeneration, AdmissionHealth } from "../src/types/admission-policy.js";
export declare function parseAdmissionPolicy(bytes: Buffer): AdmissionGeneration;
/** First-match exact-path/address slice. An indeterminate condition never grants admission. */
export declare function matchExactAdmissionRule(generation: AdmissionGeneration, pathname: string, address?: string | null): {
    id: string;
    enabled: boolean;
    conditions: readonly import("../src/types/admission-policy.js").AdmissionCondition[];
    action: import("../src/types/admission-policy.js").AdmissionAction;
} | null;
export declare function resolveAdmissionPolicy(value: unknown, files?: unknown): string | null;
export declare function admissionStorageRoot(preservedRoot: string): string;
export declare function buildAdmissionPolicy(projectDir: string, value: unknown, files?: unknown): Promise<BuiltDeployFile[]>;
export declare function publishAdmissionPolicy(root: string, relative: string, bytes: Buffer | null): Promise<void>;
export declare function openAdmissionPolicy(root: string, relative: string, onHealth?: (health: AdmissionHealth) => void, limiterOptions?: Parameters<typeof createAdmissionRateLimiter>[0]): Promise<Readonly<{
    current: () => Readonly<{
        digest: string;
        policy: import("../src/types/admission-policy.js").AdmissionPolicy;
    }> | null;
    rateLimiter: Readonly<{
        reconcile: (generation: AdmissionGeneration | null) => void;
        consume: (id: string, address: string, limit: number, windowMs: number) => number;
        stats: () => Readonly<{
            buckets: number;
            maxBuckets: number;
            evictions: number;
        }>;
    }>;
    health: () => AdmissionHealth;
    reload: () => Promise<void>;
    close: () => Promise<void>;
}>>;
//# sourceMappingURL=admission-policy.d.ts.map