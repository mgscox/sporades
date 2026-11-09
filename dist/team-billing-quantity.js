import { countAcceptedTeamMembers, lockTeamLifecycle } from "./teams-runtime.js";
import { commandError } from "./runtime-errors.js";
export function billableTeamMemberQuantity(policy, memberCount) {
    return Math.max(memberCount, policy?.minimum ?? 1);
}
export function teamBillingQuantityPolicyFingerprint(policy) {
    if (policy.kind === "fixed")
        return `fixed:${policy.value}`;
    if (policy.kind === "usage")
        return `usage:${policy.meter}:minimum:${policy.minimum ?? 1}:maximum:${policy.maximum ?? "none"}`;
    return policy.minimum === undefined ? "team-members" : `team-members:minimum:${policy.minimum}`;
}
/** All app count reads share the exact Team lifecycle transaction. Never clamp an over-limit resource count. */
export async function readTeamBillingUsageCount(database, transaction, teamId, policy) {
    await lockTeamLifecycle(transaction, teamId, usageUnavailable);
    const usage = await database.runTeamBillingUsage?.(transaction, Object.freeze({ teamId }));
    const descriptor = usage && typeof usage === "object" && !Array.isArray(usage)
        ? Object.getOwnPropertyDescriptor(usage, policy.meter) : undefined;
    const count = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (!Number.isSafeInteger(count) || count < 0 || count > 999_999)
        throw usageUnavailable();
    return count;
}
export async function readTeamBillingQuantity(database, transaction, teamId, policy) {
    if (policy.kind === "fixed")
        return Number(policy.value);
    const count = policy.kind === "usage"
        ? await readTeamBillingUsageCount(database, transaction, teamId, policy)
        : await countAcceptedTeamMembers(transaction, teamId, usageUnavailable);
    return billableTeamMemberQuantity(policy, count);
}
function usageUnavailable() {
    return commandError("Team Billing usage is unavailable.", "Supply an exact nonnegative integer count for the declared meter.", "TEAM_BILLING_USAGE_UNAVAILABLE");
}
//# sourceMappingURL=team-billing-quantity.js.map