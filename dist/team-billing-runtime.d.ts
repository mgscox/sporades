type LooseRecord = Record<string, any>;
export declare const TEAM_BILLING_PRODUCT_MAX = 32;
export declare const TEAM_BILLING_CHECKOUT_JOB = "_sporades.team-billing-checkout";
export declare const TEAM_BILLING_CHECKOUT_EXPIRY_JOB = "_sporades.team-billing-checkout-expiry";
export declare const TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS = 4;
export declare function createTeamBillingTables(adapter: LooseRecord): any;
export declare function normalizeTeamBillingDefinition(value: any): Readonly<{
    catalogue: Readonly<LooseRecord>;
    authorize: any;
    checkout: Readonly<{
        successPath: string;
        cancelPath: string;
        continuationTtlSeconds: any;
    }> | null;
}>;
export declare function readCurrentUserTeamBilling(database: LooseRecord, auth: LooseRecord, teamId: any): Promise<any>;
export declare function startTeamBillingCheckout(database: LooseRecord, auth: LooseRecord, teamId: any, requestId: any, productKey: any): Promise<any>;
export declare function performTeamBillingCheckout(database: LooseRecord, context: LooseRecord, payload: any, attempt?: number): Promise<{
    observed: boolean;
    ready?: undefined;
} | {
    ready: boolean;
    observed?: undefined;
} | null>;
/** Durably erases an abandoned Checkout continuation when its local exposure window closes. */
export declare function expireTeamBillingCheckout(database: LooseRecord, _context: LooseRecord, payload: any): Promise<null>;
/** Reconciles a runtime-owned Checkout operation when its final claimed Job lease expires after a process crash. */
export declare function settleExhaustedTeamBillingCheckoutJob(transaction: LooseRecord, handler: any, payloadJson: any, now: string): Promise<void>;
/** Applies only terminal, verified Checkout observations; Subscription truth is a later convergence concern. */
export declare function applyVerifiedTeamBillingCheckoutObservation(database: LooseRecord, event: any): Promise<any>;
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