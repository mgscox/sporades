type LooseRecord = Record<string, any>;
export declare const TEAM_BILLING_ERASURE_JOB = "_sporades.team-billing-erasure";
export declare function prepareTeamBillingErasure(database: LooseRecord, auth: LooseRecord, teamId: any, requestId: any): Promise<any>;
export declare function performTeamBillingErasure(database: LooseRecord, context: LooseRecord, payload: any): Promise<{
    superseded: boolean;
    providerQuiesced?: undefined;
} | {
    providerQuiesced: boolean;
    superseded?: undefined;
}>;
/**
 * Restart reconciliation deliberately rotates the Job generation. The provider
 * tuple remains stable, while any pre-crash worker becomes unable to settle the
 * current erasure state.
 */
export declare function repairTeamBillingErasureStateAtStartup(database: LooseRecord): Promise<{
    queued: number;
}>;
/** A terminal Job may fail only the generation it actually owned. */
export declare function settleExhaustedTeamBillingErasureJob(database: LooseRecord, payload: any, safeFailureCode?: string): Promise<any>;
/** Transaction-bound admission for the Capsule's separate local deletion mutation. */
export declare function createCurrentUserTeamBillingErasureApi(database: LooseRecord, auth: LooseRecord, contextGetter?: () => LooseRecord | null, isCurrentContext?: (context: LooseRecord) => boolean): Readonly<{
    get(teamId: any): Promise<any>;
    admitLocalErasure(teamId: any): Promise<Readonly<{
        allowed: true;
    }>>;
}>;
export {};
//# sourceMappingURL=team-billing-erasure.d.ts.map