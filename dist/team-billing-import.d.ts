type LooseRecord = Record<string, any>;
export type LegacyTeamBillingEvidence = Readonly<{
    sourceKey: string;
    teamId: string;
    mode: "sandbox" | "live";
    providerCustomerId: string;
    providerSubscriptionId: string;
    providerSubscriptionItemId: string;
    providerPriceId: string;
    productKey: string;
    quantity: number;
    state: "active" | "past-due" | "cancelled";
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    providerEventId: string;
    providerEventType: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
    providerEventDigest: string;
    providerObservedAt: string;
    retainedUntil: string;
}>;
export type LegacyTeamBillingImportResult = Readonly<{
    outcome: "imported" | "unchanged";
}>;
export type LegacyTeamBillingReplayGuard = Readonly<{
    providerEventId: string;
    providerEventType: string;
    providerEventDigest: string;
    mode: "sandbox" | "live";
    settledAt: string;
    retainedUntil: string;
}>;
/** Imports legacy processed-event evidence as a provider-free replay guard. */
export declare function importLegacyTeamBillingReplayGuard(adapter: LooseRecord, input: LegacyTeamBillingReplayGuard): Promise<LegacyTeamBillingImportResult>;
/**
 * Imports one already-verified legacy Subscription snapshot into Sporades-owned
 * billing state. Classification and product policy remain with the Capsule;
 * this primitive accepts only a complete, exact provider tuple and fails closed
 * on every conflict. It performs no provider I/O.
 */
export declare function importLegacyTeamBillingEvidence(adapter: LooseRecord, input: LegacyTeamBillingEvidence): Promise<LegacyTeamBillingImportResult>;
export {};
//# sourceMappingURL=team-billing-import.d.ts.map