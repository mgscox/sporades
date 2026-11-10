type Policy = {
    prorationBehavior?: string;
    billingCycleAnchor?: string;
    scheduleAtPeriodEnd?: string[];
};
/** Shared declaration and provider-input validation; only closed reviewed policies are allowed. */
export declare function normalizeTeamBillingPortalPolicy(value?: Policy): Readonly<{
    prorationBehavior: string;
    billingCycleAnchor: string;
    scheduleAtPeriodEnd: readonly string[];
}>;
export {};
//# sourceMappingURL=team-billing-portal-policy.d.ts.map