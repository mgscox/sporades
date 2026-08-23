type LooseRecord = Record<string, any>;
/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export declare function createStripeTeamBillingProvider(options: LooseRecord): Readonly<{
    create(input: LooseRecord): Promise<Readonly<{
        ok: true;
        sessionId: any;
        url: any;
    }>>;
    retrievePortalConfiguration(input: LooseRecord): Promise<Readonly<{
        ok: true;
    }>>;
    createPortal(input: LooseRecord): Promise<Readonly<{
        ok: true;
        sessionId: any;
        url: any;
    }>>;
    updateManagedSubscription(input: LooseRecord): Promise<Readonly<{
        ok: true;
        outcome: "payment-action-required" | "acknowledged";
    }>>;
}>;
export {};
//# sourceMappingURL=stripe-team-billing-provider.d.ts.map