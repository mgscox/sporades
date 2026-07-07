import type { LooseRecord } from "./cli-support.js";
export declare const DOCTOR_SESSIONS: Set<string>;
export declare const DOCTOR_STATUSES: readonly ["pass", "warn", "fail", "skip"];
export declare const DOCTOR_SEVERITIES: readonly ["info", "warning", "error"];
export declare function runDoctorChecks(options: LooseRecord): Promise<LooseRecord[]>;
export declare function createDoctorEnvelope(options: LooseRecord, checks: LooseRecord[]): {
    ok: boolean;
    data: {
        summary: LooseRecord;
        checks: LooseRecord[];
        subname?: any;
        host?: any;
        command: string;
        version: number;
        strict: any;
        session: any;
    };
    error: null;
};
export declare function summarizeDoctorChecks(checks: LooseRecord[]): LooseRecord;
export declare function doctorShouldExitNonZero(checks: LooseRecord[], strict: boolean): boolean;
export declare function renderDoctorHumanOutput(data: LooseRecord): string;
//# sourceMappingURL=doctor.d.ts.map