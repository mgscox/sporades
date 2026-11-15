type Obj = Record<string, any>;
export declare const TEAM_BILLING_CARD_IDENTITY_JOB = "_sporades.team-billing-card-identity";
/** This runs inside the Stripe fence and performs only local durable writes. */
export declare function stageTeamBillingCardIdentity(db: Obj, operationId: string): Promise<void>;
/** Exhaustion consumes a persisted finite budget; delayed generations back off. */
export declare function settleExhaustedTeamBillingCardIdentityJob(db: Obj, payload: Obj): Promise<{
    replacementScheduled: any;
}>;
/** Verified events are wake-up hints, never payment-method or entitlement evidence. */
export declare function restageTeamBillingCardIdentities(db: Obj, customerId: string, subscriptionId?: string): Promise<void>;
/** Retire queued work in the same transaction that cancels or replaces billing. */
export declare function stopRetiredTeamBillingCardIdentities(db: Obj, teamId: string): Promise<void>;
/** Restart transfers ownership without resetting the read budget or due time. */
export declare function repairTeamBillingCardIdentities(db: Obj): Promise<void>;
export declare function performTeamBillingCardIdentity(db: Obj, context: Obj, payload: Obj): Promise<null>;
export declare function readTeamBillingCardIdentity(db: Obj, tx: Obj, teamId: any): Promise<Readonly<{
    state: "none";
}> | Readonly<{
    state: "unavailable";
}> | Readonly<{
    state: "pending";
}> | Readonly<{
    state: "captured";
    card: Readonly<{
        token: any;
    }> | null;
    capturedAt: any;
}>>;
export {};
//# sourceMappingURL=team-billing-card-identity.d.ts.map