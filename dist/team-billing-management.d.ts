type LooseRecord = Record<string, any>;
export declare const TEAM_BILLING_PLAN_PREVIEW_JOB = "_sporades.team-billing-plan-preview";
export declare const TEAM_BILLING_PLAN_PREVIEW_EXPIRY_JOB = "_sporades.team-billing-plan-preview-expiry";
export declare const TEAM_BILLING_PLAN_TRANSITION_JOB = "_sporades.team-billing-plan-transition";
export declare const TEAM_BILLING_SEAT_CONVERGENCE_JOB = "_sporades.team-billing-seat-convergence";
/** Preview is an ordinary durable short Job; polling never performs provider I/O. */
export declare function previewTeamBillingPlanTransition(database: LooseRecord, auth: LooseRecord, input: any): Promise<any>;
export declare function expireTeamBillingPlanPreview(database: LooseRecord, _context: LooseRecord, payload: any): Promise<null>;
/** Recover previews written before expiry Jobs were scheduled, or left overdue at shutdown. */
export declare function repairTeamBillingPlanPreviewExpiries(database: LooseRecord): Promise<void>;
export declare function performTeamBillingPlanPreview(database: LooseRecord, context: LooseRecord, payload: any, attempt?: number): Promise<{
    superseded: boolean;
    ready?: undefined;
} | {
    ready: boolean;
    superseded?: undefined;
}>;
export declare function requestTeamBillingPlanTransition(database: LooseRecord, auth: LooseRecord, teamId: any, requestId: any, productKey: any, interval?: any, resume?: any, currency?: any, quoteId?: any): Promise<any>;
/** Releases the runtime-owned schedule of a scheduled period-end plan change. */
export declare function cancelScheduledTeamBillingPlanTransition(database: LooseRecord, auth: LooseRecord, teamId: any, requestId: any): Promise<any>;
/** Called after a membership transaction commits. It performs no provider I/O. */
export declare function stageTeamBillingMembershipChange(database: LooseRecord, teamId: any, effectiveAt?: number): Promise<any>;
/** Repair only an already-associated usage Subscription; quarantined evidence grants no entitlement. */
export declare function stageTeamBillingUsageRepair(database: LooseRecord, teamId: string): Promise<any>;
/** Only an acknowledged durable Plan target authorizes repair at a different usage Price. */
export declare function stageAcknowledgedTeamBillingUsageTransitionRepair(database: LooseRecord, teamId: string, productKey: string): Promise<any>;
/** Called only after lifecycle admission, before the Capsule's resource reads/writes. */
export declare function prepareTeamBillingUsageChange(database: LooseRecord, teamId: string): Promise<(() => Promise<void>) | undefined>;
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