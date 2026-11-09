export type TeamBillingSubscriptionState = "active" | "past-due" | "cancelled";
export type TeamBillingSubscriptionEventType =
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted";

export type TeamBillingSubscriptionSemantics = Readonly<{
  kind: "active" | "cancelling" | "past-due" | "cancelled";
  rank: 20 | 30 | 40 | 50;
  terminalLatch: 0 | 1;
}>;

/** One semantic map shared by normal convergence and provider-free legacy import. */
export function teamBillingSubscriptionSemantics(
  eventType: TeamBillingSubscriptionEventType,
  state: TeamBillingSubscriptionState,
  cancelAtPeriodEnd: boolean,
): TeamBillingSubscriptionSemantics | null {
  if (eventType === "customer.subscription.deleted") {
    return state === "cancelled" ? Object.freeze({ kind: "cancelled", rank: 50, terminalLatch: 1 }) : null;
  }
  if (state === "cancelled") return null;
  return teamBillingStoredSubscriptionSemantics(state, cancelAtPeriodEnd);
}

/** Canonical persisted ratchet implied by verified Subscription state. */
export function teamBillingStoredSubscriptionSemantics(
  state: TeamBillingSubscriptionState,
  cancelAtPeriodEnd: boolean,
): TeamBillingSubscriptionSemantics | null {
  if (state === "cancelled") return Object.freeze({ kind: "cancelled", rank: 50, terminalLatch: 1 });
  if (state === "past-due") return Object.freeze({ kind: "past-due", rank: 40, terminalLatch: 0 });
  if (state !== "active") return null;
  return cancelAtPeriodEnd
    ? Object.freeze({ kind: "cancelling", rank: 30, terminalLatch: 0 })
    : Object.freeze({ kind: "active", rank: 20, terminalLatch: 0 });
}

/** Calendar-aware end of one recurring interval, clamped for short months. */
export function teamBillingIntervalEnd(start: number, interval: string, count: number) {
  if (interval === "day" || interval === "week") return start + count * 86400 * (interval === "week" ? 7 : 1);
  const date = new Date(start * 1000);
  const day = date.getUTCDate(); date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count * (interval === "year" ? 12 : 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay)); return Math.floor(date.getTime() / 1000);
}
