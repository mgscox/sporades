/** One semantic map shared by normal convergence and provider-free legacy import. */
export function teamBillingSubscriptionSemantics(eventType, state, cancelAtPeriodEnd) {
    if (eventType === "customer.subscription.deleted") {
        return state === "cancelled" ? Object.freeze({ kind: "cancelled", rank: 50, terminalLatch: 1 }) : null;
    }
    if (state === "cancelled")
        return null;
    return teamBillingStoredSubscriptionSemantics(state, cancelAtPeriodEnd);
}
/** Canonical persisted ratchet implied by verified Subscription state. */
export function teamBillingStoredSubscriptionSemantics(state, cancelAtPeriodEnd) {
    if (state === "cancelled")
        return Object.freeze({ kind: "cancelled", rank: 50, terminalLatch: 1 });
    if (state === "past-due")
        return Object.freeze({ kind: "past-due", rank: 40, terminalLatch: 0 });
    if (state === "trialing")
        return Object.freeze({ kind: "trialing", rank: 15, terminalLatch: 0 });
    if (state !== "active")
        return null;
    return cancelAtPeriodEnd
        ? Object.freeze({ kind: "cancelling", rank: 30, terminalLatch: 0 })
        : Object.freeze({ kind: "active", rank: 20, terminalLatch: 0 });
}
/** Provider-free refusals shared by durable admission and the final provider read. */
export function teamBillingTransitionRefusal(state, cancelling, hasSchedule) {
    if (cancelling)
        return "TEAM_BILLING_SUBSCRIPTION_CANCELLING";
    if (["past-due", "past_due", "unpaid"].includes(state))
        return "TEAM_BILLING_SUBSCRIPTION_PAST_DUE";
    if (hasSchedule)
        return "TEAM_BILLING_UNKNOWN_SCHEDULE";
    return state === "active" || state === "trialing" ? null : "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS";
}
//# sourceMappingURL=team-billing-subscription-semantics.js.map