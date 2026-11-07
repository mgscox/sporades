import type { AcceptanceDriver, AcceptancePlan, AcceptanceReport } from '../../src/types/observability-acceptance.js';
export declare function validateAcceptancePlan(input: unknown, authorization: {
    authorizeTarget: string;
    release: string;
}): AcceptancePlan;
/** Explicit operator workflow; ordinary deploy verification never calls this. Drivers are trusted executable operator code. */
export declare function acceptObservability(input: unknown, driver: AcceptanceDriver, options: {
    authorizeTarget: string;
    release: string;
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
}): Promise<AcceptanceReport>;
//# sourceMappingURL=observability-acceptance.d.ts.map