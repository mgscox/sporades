type LooseRecord = Record<string, any>;
export declare const TEAM_BILLING_PLAN_TRANSITION_JOB = "_sporades.team-billing-plan-transition";
export declare const TEAM_BILLING_SEAT_CONVERGENCE_JOB = "_sporades.team-billing-seat-convergence";
export declare function requestTeamBillingPlanTransition(database: LooseRecord, auth: LooseRecord, teamId: any, requestId: any, productKey: any): Promise<any>;
/** Called after a membership transaction commits. It performs no provider I/O. */
export declare function stageTeamBillingMembershipChange(database: LooseRecord, teamId: any, effectiveAt?: number): Promise<any>;
export declare function performTeamBillingPlanTransition(database: LooseRecord, context: LooseRecord, payload: any): Promise<{
    superseded: boolean;
    failed?: undefined;
    safeFailureCode?: undefined;
    providerAcknowledged?: undefined;
} | {
    failed: boolean;
    safeFailureCode: string;
    superseded?: undefined;
    providerAcknowledged?: undefined;
} | {
    providerAcknowledged: boolean;
    superseded?: undefined;
    failed?: undefined;
    safeFailureCode?: undefined;
}>;
export declare function performTeamBillingSeatConvergence(database: LooseRecord, context: LooseRecord, payload: any): Promise<{
    superseded: boolean;
    failed?: undefined;
    safeFailureCode?: undefined;
    providerAcknowledged?: undefined;
} | {
    failed: boolean;
    safeFailureCode: string;
    superseded?: undefined;
    providerAcknowledged?: undefined;
} | {
    providerAcknowledged: boolean;
    superseded?: undefined;
    failed?: undefined;
    safeFailureCode?: undefined;
}>;
/** Invoked only after full verified-event validation has accepted this target. */
export declare function settleVerifiedTeamBillingTarget(database: LooseRecord, accepted: LooseRecord): Promise<any>;
/** Startup/scheduled repair. Provider acknowledgement never suppresses repair. */
export declare function repairTeamBillingDesiredState(database: LooseRecord): Promise<{
    queued: number;
}>;
export declare const repairTeamBillingDesiredStateAtStartup: typeof repairTeamBillingDesiredState;
export declare function settleExhaustedTeamBillingManagementJob(database: LooseRecord, payload: any, safeFailureCode?: string): Promise<any>;
export {};
//# sourceMappingURL=team-billing-management.d.ts.map