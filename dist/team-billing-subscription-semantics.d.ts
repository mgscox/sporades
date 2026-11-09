export type TeamBillingSubscriptionState = "trialing" | "active" | "past-due" | "cancelled";
export type TeamBillingSubscriptionEventType = "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
export type TeamBillingSubscriptionSemantics = Readonly<{
    kind: "trialing" | "active" | "cancelling" | "past-due" | "cancelled";
    rank: 15 | 20 | 30 | 40 | 50;
    terminalLatch: 0 | 1;
}>;
/** One semantic map shared by normal convergence and provider-free legacy import. */
export declare function teamBillingSubscriptionSemantics(eventType: TeamBillingSubscriptionEventType, state: TeamBillingSubscriptionState, cancelAtPeriodEnd: boolean): TeamBillingSubscriptionSemantics | null;
/** Canonical persisted ratchet implied by verified Subscription state. */
export declare function teamBillingStoredSubscriptionSemantics(state: TeamBillingSubscriptionState, cancelAtPeriodEnd: boolean): TeamBillingSubscriptionSemantics | null;
/** Provider-free refusals shared by durable admission and the final provider read. */
export declare function teamBillingTransitionRefusal(state: string, cancelling: boolean, hasSchedule: boolean): string | null;
//# sourceMappingURL=team-billing-subscription-semantics.d.ts.map