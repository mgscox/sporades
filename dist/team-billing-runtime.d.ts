type LooseRecord = Record<string, any>;
export declare const TEAM_BILLING_PRODUCT_MAX = 32;
export declare function createTeamBillingTables(adapter: LooseRecord): any;
export declare function normalizeTeamBillingDefinition(value: any): Readonly<{
    catalogue: Readonly<LooseRecord>;
    authorize: any;
}>;
export declare function readCurrentUserTeamBilling(database: LooseRecord, auth: LooseRecord, teamId: any): Promise<any>;
/**
 * Reusable last-moment admission for provider-facing Team Billing operations.
 * It deliberately returns no capability: callers must invoke it in the same
 * transaction immediately before persisting provider work.
 */
export declare function admitTeamBillingActor(database: LooseRecord, transaction: LooseRecord, auth: LooseRecord, input: LooseRecord): Promise<Readonly<{
    admitted: true;
}>>;
export declare function teamBillingDenied(): import("./runtime-errors.js").HelperError;
export {};
//# sourceMappingURL=team-billing-runtime.d.ts.map