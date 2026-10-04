export declare const ADMISSION_INSPECTION_SCRIPT: string;
export declare function readAdmissionInspection(response: Response): Promise<Readonly<{
    state: "healthy" | "degraded" | "disabled";
    digest: string | null;
    rateLimit?: Readonly<{
        buckets: number;
        maxBuckets: number;
        evictions: number;
    }>;
    evidence?: import("../server.js").AdmissionEvidence;
}> | null>;
//# sourceMappingURL=admission-inspection.d.ts.map