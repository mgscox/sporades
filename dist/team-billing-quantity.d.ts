type LooseQuantityPolicy = {
    kind?: string;
    minimum?: number;
    value?: number;
};
export declare function billableTeamMemberQuantity(policy: LooseQuantityPolicy | null | undefined, memberCount: number): number;
export declare function teamBillingQuantityPolicyFingerprint(policy: LooseQuantityPolicy): string;
export {};
//# sourceMappingURL=team-billing-quantity.d.ts.map