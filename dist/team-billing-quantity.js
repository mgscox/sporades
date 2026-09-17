export function billableTeamMemberQuantity(policy, memberCount) {
    return Math.max(memberCount, policy?.minimum ?? 1);
}
export function teamBillingQuantityPolicyFingerprint(policy) {
    if (policy.kind === "fixed")
        return `fixed:${policy.value}`;
    return policy.minimum === undefined ? "team-members" : `team-members:minimum:${policy.minimum}`;
}
//# sourceMappingURL=team-billing-quantity.js.map