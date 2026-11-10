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
/** Calendar-aware end of one recurring interval, clamped for short months. */
export function teamBillingIntervalEnd(start, interval, count) {
    if (interval === "day" || interval === "week")
        return start + count * 86400 * (interval === "week" ? 7 : 1);
    const date = new Date(start * 1000);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + count * (interval === "year" ? 12 : 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return Math.floor(date.getTime() / 1000);
}
/** Full recurring period containing an instant, always measured from the original anchor. */
export function teamBillingPeriodAt(anchor, interval, count, at) {
    if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(at) || at < anchor
        || !Number.isSafeInteger(count) || count < 1 || !["day", "week", "month", "year"].includes(interval))
        return null;
    const startDate = new Date(anchor * 1000);
    const atDate = new Date(at * 1000);
    let cycle = interval === "day" || interval === "week"
        ? Math.floor((at - anchor) / (count * 86400 * (interval === "week" ? 7 : 1)))
        : Math.floor(((atDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12
            + atDate.getUTCMonth() - startDate.getUTCMonth()) / (count * (interval === "year" ? 12 : 1)));
    if (!Number.isSafeInteger(cycle))
        return null;
    // The calendar month may have arrived before its anchored day/time.
    if (teamBillingIntervalEnd(anchor, interval, count * cycle) > at)
        cycle--;
    const start = teamBillingIntervalEnd(anchor, interval, count * cycle);
    const end = teamBillingIntervalEnd(anchor, interval, count * (cycle + 1));
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= at && at < end ? { start, end } : null;
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