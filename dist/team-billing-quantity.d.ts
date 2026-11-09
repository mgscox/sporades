type LooseRecord = Record<string, any>;
type LooseQuantityPolicy = {
    kind?: string;
    minimum?: number;
    maximum?: number;
    meter?: string;
    value?: number;
};
export declare function billableTeamMemberQuantity(policy: LooseQuantityPolicy | null | undefined, memberCount: number): number;
export declare function teamBillingQuantityPolicyFingerprint(policy: LooseQuantityPolicy): string;
/** All app count reads share the exact Team lifecycle transaction. Never clamp an over-limit resource count. */
export declare function readTeamBillingUsageCount(database: LooseRecord, transaction: LooseRecord, teamId: string, policy: LooseQuantityPolicy): Promise<number>;
export declare function readTeamBillingQuantity(database: LooseRecord, transaction: LooseRecord, teamId: string, policy: LooseQuantityPolicy): Promise<number>;
export {};
//# sourceMappingURL=team-billing-quantity.d.ts.map