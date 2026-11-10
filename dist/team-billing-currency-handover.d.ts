type Obj = Record<string, any>;
export declare const TEAM_BILLING_CURRENCY_HANDOVER_JOB = "_sporades.team-billing-currency-handover";
export declare function assertCurrencyHandoverInactive(tx: Obj, teamId: string): Promise<void>;
export declare function startTeamBillingCurrencyHandover(db: Obj, auth: Obj, input: Obj): Promise<any>;
export declare function performTeamBillingCurrencyHandover(db: Obj, context: Obj, payload: Obj, attempt?: number): Promise<{
    acknowledged: boolean;
    deferred?: undefined;
} | {
    deferred: boolean;
    acknowledged?: undefined;
} | null>;
/** Called only inside the verified-event atomic fence, after envelope validation. */
export declare function applyCurrencySetup(db: Obj, event: Obj, mode: string): Promise<{
    teamId: any;
    objectId: any;
    rank: number;
    outcome: string;
} | null>;
export declare function readCurrencyHandoverLatch(tx: Obj, definition: Obj, teamId: string, clock: Date): Promise<Readonly<{
    renewsAt: any;
    interval?: any;
    state: "active";
    teamId: string;
    productKey: any;
    quantity: any;
    currency: any;
}> | null>;
export declare function repairTeamBillingCurrencyHandovers(db: Obj): Promise<void>;
export {};
//# sourceMappingURL=team-billing-currency-handover.d.ts.map