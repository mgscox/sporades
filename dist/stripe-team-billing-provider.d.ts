type LooseRecord = Record<string, any>;
/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export declare function createStripeTeamBillingProvider(options: LooseRecord): Readonly<{
    create(input: LooseRecord): Promise<Readonly<{
        ok: true;
        sessionId: any;
        url: any;
    }>>;
}>;
export {};
//# sourceMappingURL=stripe-team-billing-provider.d.ts.map