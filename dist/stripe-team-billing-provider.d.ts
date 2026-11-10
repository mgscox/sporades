type LooseRecord = Record<string, any>;
/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export declare function createStripeTeamBillingProvider(options: LooseRecord): Readonly<{
    create(input: LooseRecord): Promise<Readonly<{
        ok: true;
        sessionId: any;
        url: any;
    }>>;
    createCurrencySetup(input: LooseRecord): Promise<Readonly<{
        ok: true;
        sessionId: string;
        url: string | null;
    }>>;
    replaceCurrencySubscription(input: LooseRecord): Promise<Readonly<{
        ok: true;
        subscriptionId: string;
    }>>;
    reconcileCurrencyHandover(input: LooseRecord): Promise<Readonly<{
        subscriptionId?: any;
        closed: false;
        sourceUncancelled?: undefined;
    } | {
        closed: true;
        sourceUncancelled: boolean;
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
        outcome: "acknowledged";
    }> | Readonly<{
        paymentAction?: {
            url: string;
            expiresAt: string;
        } | undefined;
        ok: true;
        outcome: "payment-action-required" | "acknowledged";
    }>>;
    quiesceTeamBilling(input: LooseRecord): Promise<Readonly<{
        ok: true;
        outcome: "quiesced";
        providerObservedAt: string;
        checkouts: readonly Readonly<unknown>[];
        subscriptions: readonly Readonly<{
            id: any;
            state: "cancelled" | "safely-closed";
        }>[];
    }>>;
}>;
export {};
//# sourceMappingURL=stripe-team-billing-provider.d.ts.map