import { randomUUID } from "node:crypto";
import { jobTimestampAfter } from "./jobs-runtime.js";
import { cardIdentityKey } from "./stripe-card-identity.js";
import { teamBillingDenied } from "./team-billing-runtime.js";
import { lockTeamLifecycle } from "./teams-runtime.js";
export const TEAM_BILLING_CARD_IDENTITY_JOB = "_sporades.team-billing-card-identity";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Five timed generations, at most four SDK reads each. Events may admit one more
// bounded generation without replenishing this automatic budget.
const MAX_GENERATIONS = 5;
const MAX_READS = 4;
/** This runs inside the Stripe fence and performs only local durable writes. */
export async function stageTeamBillingCardIdentity(db, operationId) {
    if (!db.paymentsConfig?.stripe?.cardIdentityKeyEnv)
        return;
    const tx = db.adapter;
    const op = await tx.prepare(tx.dialect.sql("SELECT [id], [teamId] FROM [sporades_team_billing_operations] WHERE [id] = ? AND [status] = 'completed' " +
        "AND [kind] IN ('checkout', 'currency-handover') AND [providerCustomerId] IS NOT NULL AND [providerSubscriptionId] IS NOT NULL")).get(operationId);
    if (!op)
        return;
    const generationId = randomUUID(), availableAt = db.clock.now().toISOString();
    const inserted = await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_billing_card_identities] ([operationId], [teamId], [generationId], [kind], [token], [capturedAt], [generationCount], [readAttempts], [nextAttemptAt]) " +
        "VALUES (?, ?, ?, 'pending', NULL, NULL, 1, 0, ?) ON CONFLICT DO NOTHING")).run(op.id, op.teamId, generationId, availableAt);
    if (Number(inserted?.changes ?? inserted?.changesCount ?? 0) !== 1)
        return;
    await enqueue(db, tx, operationId, generationId, availableAt);
}
async function enqueue(db, tx, operationId, generationId, availableAt) {
    await db.enqueueTeamBillingCardIdentityJob(tx, { operationId, generationId }, `team-billing-card-identity:${operationId}:${generationId}`, availableAt);
}
async function lockedCapture(db, tx, payload) {
    const read = () => tx.prepare(tx.dialect.sql("SELECT [c].*, [o].[providerCustomerId], [o].[providerSubscriptionId], [s].[state] AS [subscriptionState], [s].[terminalLatch], [s].[replacedBy] " +
        "FROM [sporades_team_billing_card_identities] [c] JOIN [sporades_teams] [t] ON [t].[id] = [c].[teamId] " +
        "JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [c].[operationId] AND [o].[teamId] = [c].[teamId] " +
        "LEFT JOIN [sporades_team_billing_subscriptions] [s] ON [s].[teamId] = [o].[teamId] AND [s].[mode] = [o].[mode] AND [s].[providerSubscriptionId] = [o].[providerSubscriptionId] " +
        "WHERE [c].[operationId] = ? AND [c].[generationId] = ? AND [c].[kind] IN ('pending', 'unavailable') AND [o].[status] = 'completed' AND [o].[mode] = ?")).get(payload.operationId, payload.generationId, db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
    const row = await read();
    if (!row)
        return null;
    await lockTeamLifecycle(tx, row.teamId, teamBillingDenied);
    return read();
}
function retired(row) {
    return row.subscriptionState === "cancelled" || Number(row.terminalLatch) === 1 || !!row.replacedBy;
}
function validBudget(row) {
    return Number.isInteger(row.generationCount) && row.generationCount >= 1 && row.generationCount <= MAX_GENERATIONS
        && Number.isInteger(row.readAttempts) && row.readAttempts >= 0 && row.readAttempts <= MAX_READS;
}
async function stopCapture(db, tx, row) {
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_card_identities] SET [kind] = 'unavailable', [token] = NULL, [capturedAt] = NULL, [nextAttemptAt] = NULL " +
        "WHERE [operationId] = ? AND [generationId] = ? AND [kind] = 'pending'")).run(row.operationId, row.generationId);
    await db.cancelTeamBillingCardIdentityJobs?.(tx, row.operationId);
}
async function replaceGeneration(db, tx, row, generationCount, readAttempts, availableAt) {
    const generationId = randomUUID();
    const changed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_card_identities] SET [generationId] = ?, [kind] = 'pending', [generationCount] = ?, [readAttempts] = ?, [nextAttemptAt] = ? " +
        "WHERE [operationId] = ? AND [generationId] = ? AND [kind] = ?")).run(generationId, generationCount, readAttempts, availableAt, row.operationId, row.generationId, row.kind);
    if (Number(changed?.changes ?? changed?.changesCount ?? 0) !== 1)
        return false;
    await db.cancelTeamBillingCardIdentityJobs?.(tx, row.operationId);
    await enqueue(db, tx, row.operationId, generationId, availableAt);
    return true;
}
async function settleGeneration(db, tx, row) {
    if (row.kind !== "pending")
        return false;
    const availableAt = validBudget(row) && row.generationCount < MAX_GENERATIONS && !retired(row)
        ? jobTimestampAfter(db.clock.now(), 60_000 * 5 ** (row.generationCount - 1)) : null;
    if (!availableAt) {
        await stopCapture(db, tx, row);
        return false;
    }
    return replaceGeneration(db, tx, row, row.generationCount + 1, 0, availableAt);
}
/** Exhaustion consumes a persisted finite budget; delayed generations back off. */
export async function settleExhaustedTeamBillingCardIdentityJob(db, payload) {
    if (!db.teamBillingDefinition || !db.paymentsConfig?.stripe?.cardIdentityKeyEnv)
        return { replacementScheduled: false };
    if (!payload || Object.keys(payload).sort().join() !== "generationId,operationId" || !UUID.test(payload.operationId) || !UUID.test(payload.generationId))
        return { replacementScheduled: false };
    const settle = async (tx) => {
        const row = await lockedCapture(db, tx, payload);
        return row ? settleGeneration(db, tx, row) : false;
    };
    const replacementScheduled = db.__transactionActive ? await settle(db.adapter) : await db.adapter.withTransaction(settle);
    if (replacementScheduled && !db.__transactionActive)
        db.scheduleTeamBillingJobDispatch?.();
    return { replacementScheduled };
}
/** Verified events are wake-up hints, never payment-method or entitlement evidence. */
export async function restageTeamBillingCardIdentities(db, customerId, subscriptionId) {
    if (!db.paymentsConfig?.stripe?.cardIdentityKeyEnv)
        return;
    const tx = db.adapter;
    const rows = await tx.prepare(tx.dialect.sql("SELECT [c].[operationId], [c].[generationId] FROM [sporades_team_billing_card_identities] [c] " +
        "JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [c].[operationId] AND [o].[teamId] = [c].[teamId] " +
        "WHERE [c].[kind] IN ('pending', 'unavailable') AND [o].[status] = 'completed' AND [o].[mode] = ? AND [o].[providerCustomerId] = ?" +
        (subscriptionId ? " AND [o].[providerSubscriptionId] = ?" : ""))).all(db.paymentsConfig.stripe.livemode ? "live" : "sandbox", customerId, ...(subscriptionId ? [subscriptionId] : []));
    for (const payload of rows) {
        const row = await lockedCapture(db, tx, payload);
        if (!row)
            continue;
        if (retired(row) || !validBudget(row)) {
            await stopCapture(db, tx, row);
            continue;
        }
        await replaceGeneration(db, tx, row, row.kind === "unavailable" ? MAX_GENERATIONS : row.generationCount, 0, db.clock.now().toISOString());
    }
}
/** Retire queued work in the same transaction that cancels or replaces billing. */
export async function stopRetiredTeamBillingCardIdentities(db, teamId) {
    if (!db.paymentsConfig?.stripe?.cardIdentityKeyEnv || !teamId)
        return;
    const tx = db.adapter;
    const rows = await tx.prepare(tx.dialect.sql("SELECT [operationId], [generationId] FROM [sporades_team_billing_card_identities] WHERE [teamId] = ? AND [kind] = 'pending'")).all(teamId);
    for (const payload of rows) {
        const row = await lockedCapture(db, tx, payload);
        if (row && retired(row))
            await stopCapture(db, tx, row);
    }
}
/** Restart transfers ownership without resetting the read budget or due time. */
export async function repairTeamBillingCardIdentities(db) {
    if (!db.teamBillingDefinition || !db.paymentsConfig?.stripe?.cardIdentityKeyEnv)
        return;
    await db.adapter.withTransaction(async (tx) => {
        const ops = await tx.prepare(tx.dialect.sql("SELECT [o].[id], [o].[teamId] FROM [sporades_team_billing_operations] [o] JOIN [sporades_teams] [t] ON [t].[id] = [o].[teamId] " +
            "LEFT JOIN [sporades_team_billing_card_identities] [c] ON [c].[operationId] = [o].[id] " +
            "WHERE [o].[status] = 'completed' AND [o].[mode] = ? AND [o].[kind] IN ('checkout', 'currency-handover') " +
            "AND ([c].[kind] IS NULL OR [c].[kind] = 'pending') ORDER BY [o].[id]")).all(db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
        for (const op of ops) {
            try {
                await lockTeamLifecycle(tx, op.teamId, teamBillingDenied);
            }
            catch (error) {
                const team = await tx.prepare(tx.dialect.sql("SELECT [id] FROM [sporades_teams] WHERE [id] = ?")).get(op.teamId);
                if (!team)
                    continue;
                throw error;
            }
            const stored = await tx.prepare(tx.dialect.sql("SELECT [generationId] FROM [sporades_team_billing_card_identities] WHERE [operationId] = ?")).get(op.id);
            if (!stored) {
                await stageTeamBillingCardIdentity({ ...db, adapter: tx }, op.id);
                continue;
            }
            const row = await lockedCapture(db, tx, { operationId: op.id, generationId: stored.generationId });
            if (!row || row.kind !== "pending")
                continue;
            if (retired(row) || !validBudget(row)) {
                await stopCapture(db, tx, row);
                continue;
            }
            if (row.readAttempts === MAX_READS) {
                await settleGeneration(db, tx, row);
                continue;
            }
            await replaceGeneration(db, tx, row, row.generationCount, row.readAttempts, row.nextAttemptAt ?? db.clock.now().toISOString());
        }
    });
}
export async function performTeamBillingCardIdentity(db, context, payload) {
    if (!payload || Object.keys(payload).sort().join() !== "generationId,operationId" || !UUID.test(payload.operationId) || !UUID.test(payload.generationId))
        throw teamBillingDenied();
    const snapshot = await db.adapter.withTransaction(async (tx) => {
        const row = await lockedCapture(db, tx, payload);
        if (!row || row.kind !== "pending")
            return null;
        if (retired(row) || !validBudget(row)) {
            await stopCapture(db, tx, row);
            return null;
        }
        if (row.readAttempts === MAX_READS)
            return { exhausted: true };
        // Reserve the provider read durably before I/O, including across restarts.
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_card_identities] SET [readAttempts] = [readAttempts] + 1 WHERE [operationId] = ? AND [generationId] = ? AND [kind] = 'pending'")).run(payload.operationId, payload.generationId);
        return row;
    });
    if (!snapshot)
        return null;
    if (snapshot.exhausted)
        throw Object.assign(new Error("Team card identity capture is unavailable."), { retryable: false });
    const config = db.paymentsConfig.stripe;
    cardIdentityKey(config, db.serverEnv);
    let result;
    try {
        const provider = db.createStripeTeamBillingProvider({ config, env: db.serverEnv, signal: context.signal,
            ...(db.stripeApiBaseUrl ? { apiBaseUrl: db.stripeApiBaseUrl } : {}) });
        result = await provider.readSubscriptionCardIdentity({ customerId: snapshot.providerCustomerId, subscriptionId: snapshot.providerSubscriptionId });
        if (result?.pending === true)
            throw Object.assign(new Error(), { retryable: true });
        if (result?.ok !== true || result.card !== null && (!result.card || Object.keys(result.card).join() !== "token" || !/^[A-Za-z0-9_-]{43}$/.test(result.card.token)))
            throw new Error();
    }
    catch (error) {
        // Never let custom provider diagnostics or transient provider evidence enter Job errors.
        throw Object.assign(new Error("Team card identity capture is unavailable."), { code: "TEAM_BILLING_CARD_IDENTITY_UNAVAILABLE", retryable: error?.retryable !== false });
    }
    if (context.signal?.aborted)
        throw Object.assign(new Error("Team card identity capture was cancelled."), { code: "ABORT_ERR", name: "AbortError" });
    await db.adapter.withTransaction(async (tx) => {
        // Erasure can remove the Team while provider I/O is in flight. Never recreate rows.
        const row = await lockedCapture(db, tx, payload);
        if (!row || row.kind !== "pending")
            return;
        if (retired(row) || result.unavailable === true) {
            await stopCapture(db, tx, row);
            return;
        }
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_card_identities] SET [kind] = ?, [token] = ?, [capturedAt] = ? " +
            "WHERE [operationId] = ? AND [generationId] = ? AND [kind] = 'pending'")).run(result.card ? "card" : "none", result.card?.token ?? null, db.clock.now().toISOString(), payload.operationId, payload.generationId);
    });
    return null;
}
export async function readTeamBillingCardIdentity(db, tx, teamId) {
    if (!db.teamBillingDefinition || typeof teamId !== "string" || !UUID.test(teamId))
        throw teamBillingDenied();
    cardIdentityKey(db.paymentsConfig?.stripe ?? {}, db.serverEnv);
    const row = await tx.prepare(tx.dialect.sql("SELECT [c].[kind], [c].[token], [c].[capturedAt] FROM [sporades_team_billing_operations] [o] " +
        "LEFT JOIN [sporades_team_billing_card_identities] [c] ON [c].[operationId] = [o].[id] " +
        "WHERE [o].[teamId] = ? AND [o].[mode] = ? AND [o].[status] = 'completed' AND [o].[kind] IN ('checkout', 'currency-handover') ORDER BY [o].[createdAt] DESC, [o].[id] DESC LIMIT 1")).get(teamId, db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
    if (!row)
        return Object.freeze({ state: "none" });
    if (row.kind === "unavailable")
        return Object.freeze({ state: "unavailable" });
    if (!row.capturedAt)
        return Object.freeze({ state: "pending" });
    if (!["card", "none"].includes(row.kind) || row.kind === "card" && !/^[A-Za-z0-9_-]{43}$/.test(row.token)
        || typeof row.capturedAt !== "string" || !/^\d{4}-/.test(row.capturedAt) || !Number.isFinite(Date.parse(row.capturedAt)) || new Date(row.capturedAt).toISOString() !== row.capturedAt)
        throw teamBillingDenied();
    return Object.freeze({ state: "captured", card: row.kind === "card" ? Object.freeze({ token: row.token }) : null, capturedAt: row.capturedAt });
}
//# sourceMappingURL=team-billing-card-identity.js.map