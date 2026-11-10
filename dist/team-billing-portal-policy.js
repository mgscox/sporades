/** Shared declaration and provider-input validation; only closed reviewed policies are allowed. */
export function normalizeTeamBillingPortalPolicy(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Team Billing Portal policy.");
    const prorationBehavior = value.prorationBehavior === undefined ? "create_prorations" : value.prorationBehavior;
    const billingCycleAnchor = value.billingCycleAnchor === undefined ? "unchanged" : value.billingCycleAnchor;
    const scheduleAtPeriodEnd = value.scheduleAtPeriodEnd === undefined ? [] : value.scheduleAtPeriodEnd;
    if (!["create_prorations", "always_invoice", "none"].includes(prorationBehavior)
        || !["now", "unchanged"].includes(billingCycleAnchor)
        || !Array.isArray(scheduleAtPeriodEnd) || new Set(scheduleAtPeriodEnd).size !== scheduleAtPeriodEnd.length
        || !scheduleAtPeriodEnd.every(type => ["decreasing_item_amount", "shortening_interval"].includes(type))) {
        throw new Error("Invalid Team Billing Portal policy.");
    }
    return Object.freeze({ prorationBehavior, billingCycleAnchor, scheduleAtPeriodEnd: Object.freeze([...scheduleAtPeriodEnd].sort()) });
}
//# sourceMappingURL=team-billing-portal-policy.js.map