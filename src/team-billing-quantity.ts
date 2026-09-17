type LooseQuantityPolicy = { kind?: string; minimum?: number; value?: number };

export function billableTeamMemberQuantity(policy: LooseQuantityPolicy | null | undefined, memberCount: number) {
  return Math.max(memberCount, policy?.minimum ?? 1);
}

export function teamBillingQuantityPolicyFingerprint(policy: LooseQuantityPolicy) {
  if (policy.kind === "fixed") return `fixed:${policy.value}`;
  return policy.minimum === undefined ? "team-members" : `team-members:minimum:${policy.minimum}`;
}
