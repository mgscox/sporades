import { randomUUID } from "node:crypto";
import { jobTimestampAfter } from "./jobs-runtime.js";
import { cardIdentityKey } from "./stripe-card-identity.js";
import { teamBillingDenied } from "./team-billing-runtime.js";
import { lockTeamLifecycle } from "./teams-runtime.js";

type Obj = Record<string, any>;
export const TEAM_BILLING_CARD_IDENTITY_JOB = "_sporades.team-billing-card-identity";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** This runs inside the Stripe fence and performs only local durable writes. */
export async function stageTeamBillingCardIdentity(db: Obj, operationId: string) {
  if (!db.paymentsConfig?.stripe?.cardIdentityKeyEnv) return;
  const tx = db.adapter;
  const op = await tx.prepare(tx.dialect.sql(
    "SELECT [id], [teamId] FROM [sporades_team_billing_operations] WHERE [id] = ? AND [status] = 'completed' " +
    "AND [kind] IN ('checkout', 'currency-handover') AND [providerCustomerId] IS NOT NULL AND [providerSubscriptionId] IS NOT NULL",
  )).get(operationId);
  if (!op) return;
  const generationId = randomUUID();
  const inserted = await tx.prepare(tx.dialect.sql(
    "INSERT INTO [sporades_team_billing_card_identities] ([operationId], [teamId], [generationId], [kind], [token], [capturedAt]) VALUES (?, ?, ?, 'pending', NULL, NULL) ON CONFLICT DO NOTHING",
  )).run(op.id, op.teamId, generationId);
  if (Number(inserted?.changes ?? inserted?.changesCount ?? 0) !== 1) return;
  await enqueue(db, tx, operationId, generationId);
}

async function enqueue(db: Obj, tx: Obj, operationId: string, generationId: string, availableAt?: string) {
  await db.enqueueTeamBillingCardIdentityJob(tx, { operationId, generationId }, `team-billing-card-identity:${operationId}:${generationId}`, availableAt);
}

async function replacePendingGeneration(db: Obj, tx: Obj, operationId: string, previous: string, availableAt?: string) {
  const generationId = randomUUID();
  const changed = await tx.prepare(tx.dialect.sql(
    "UPDATE [sporades_team_billing_card_identities] SET [generationId] = ? WHERE [operationId] = ? AND [generationId] = ? AND [kind] = 'pending'",
  )).run(generationId, operationId, previous);
  if (Number(changed?.changes ?? changed?.changesCount ?? 0) !== 1) return false;
  await enqueue(db, tx, operationId, generationId, availableAt);
  return true;
}

/** Durable delayed repair avoids stranding a capture when a bounded Job exhausts. */
export async function settleExhaustedTeamBillingCardIdentityJob(db: Obj, payload: Obj) {
  if (!db.teamBillingDefinition || !db.paymentsConfig?.stripe?.cardIdentityKeyEnv) return { replacementScheduled: false };
  if (!payload || Object.keys(payload).sort().join() !== "generationId,operationId" || !UUID.test(payload.operationId) || !UUID.test(payload.generationId)) return { replacementScheduled: false };
  const availableAt = jobTimestampAfter(db.clock.now(), 60_000);
  if (!availableAt) return { replacementScheduled: false };
  const settle = async (tx: Obj) => {
    const row = await tx.prepare(tx.dialect.sql(
      "SELECT [c].[teamId] FROM [sporades_team_billing_card_identities] [c] JOIN [sporades_teams] [t] ON [t].[id] = [c].[teamId] " +
      "JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [c].[operationId] AND [o].[teamId] = [c].[teamId] " +
      "WHERE [c].[operationId] = ? AND [c].[generationId] = ? AND [c].[kind] = 'pending' AND [o].[status] = 'completed' AND [o].[mode] = ?",
    )).get(payload.operationId, payload.generationId, db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
    if (!row) return false;
    await lockTeamLifecycle(tx, row.teamId, teamBillingDenied);
    return replacePendingGeneration(db, tx, payload.operationId, payload.generationId, availableAt);
  };
  const replacementScheduled = db.__transactionActive ? await settle(db.adapter) : await db.adapter.withTransaction(settle);
  if (replacementScheduled && !db.__transactionActive) db.scheduleTeamBillingJobDispatch?.();
  return { replacementScheduled };
}

/** Verified events are wake-up hints, never payment-method or entitlement evidence. */
export async function restageTeamBillingCardIdentities(db: Obj, customerId: string, subscriptionId?: string) {
  if (!db.paymentsConfig?.stripe?.cardIdentityKeyEnv) return;
  const tx = db.adapter;
  const rows = await tx.prepare(tx.dialect.sql(
    "SELECT [c].[operationId], [c].[teamId], [c].[generationId] FROM [sporades_team_billing_card_identities] [c] " +
    "JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [c].[operationId] AND [o].[teamId] = [c].[teamId] " +
    "JOIN [sporades_teams] [t] ON [t].[id] = [c].[teamId] " +
    "WHERE [c].[kind] = 'pending' AND [o].[status] = 'completed' AND [o].[mode] = ? AND [o].[providerCustomerId] = ?" +
    (subscriptionId ? " AND [o].[providerSubscriptionId] = ?" : ""),
  )).all(db.paymentsConfig.stripe.livemode ? "live" : "sandbox", customerId, ...(subscriptionId ? [subscriptionId] : []));
  for (const row of rows) {
    await lockTeamLifecycle(tx, row.teamId, teamBillingDenied);
    await replacePendingGeneration(db, tx, row.operationId, row.generationId);
  }
}

/** Restart replaces pending generations; older attempts can no longer settle them. */
export async function repairTeamBillingCardIdentities(db: Obj) {
  if (!db.teamBillingDefinition || !db.paymentsConfig?.stripe?.cardIdentityKeyEnv) return;
  await db.adapter.withTransaction(async (tx: Obj) => {
    const ops = await tx.prepare(tx.dialect.sql(
      "SELECT [o].[id], [o].[teamId] FROM [sporades_team_billing_operations] [o] JOIN [sporades_teams] [t] ON [t].[id] = [o].[teamId] " +
      "LEFT JOIN [sporades_team_billing_card_identities] [c] ON [c].[operationId] = [o].[id] " +
      "WHERE [o].[status] = 'completed' AND [o].[mode] = ? AND [o].[kind] IN ('checkout', 'currency-handover') " +
      "AND ([c].[kind] IS NULL OR [c].[kind] = 'pending') ORDER BY [o].[id]",
    )).all(db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
    for (const op of ops) {
      try { await lockTeamLifecycle(tx, op.teamId, teamBillingDenied); }
      catch (error) {
        const team = await tx.prepare(tx.dialect.sql("SELECT [id] FROM [sporades_teams] WHERE [id] = ?")).get(op.teamId);
        if (!team) continue;
        throw error;
      }
      const row = await tx.prepare(tx.dialect.sql("SELECT [kind] FROM [sporades_team_billing_card_identities] WHERE [operationId] = ?")).get(op.id);
      if (!row) await stageTeamBillingCardIdentity({ ...db, adapter: tx }, op.id);
      else if (row.kind === "pending") {
        const generationId = randomUUID();
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_card_identities] SET [generationId] = ? WHERE [operationId] = ? AND [kind] = 'pending'")).run(generationId, op.id);
        await enqueue(db, tx, op.id, generationId);
      }
    }
  });
}

export async function performTeamBillingCardIdentity(db: Obj, context: Obj, payload: Obj) {
  if (!payload || Object.keys(payload).sort().join() !== "generationId,operationId" || !UUID.test(payload.operationId) || !UUID.test(payload.generationId)) throw teamBillingDenied();
  const snapshot = await db.adapter.withTransaction(async (tx: Obj) => {
    const row = await tx.prepare(tx.dialect.sql(
      "SELECT [o].[teamId], [o].[mode], [o].[providerCustomerId], [o].[providerSubscriptionId] FROM [sporades_team_billing_operations] [o] " +
      "JOIN [sporades_team_billing_card_identities] [c] ON [o].[id] = [c].[operationId] " +
      "WHERE [o].[id] = ? AND [o].[status] = 'completed' AND [c].[kind] = 'pending' AND [c].[generationId] = ?",
    )).get(payload.operationId, payload.generationId);
    if (!row) return null;
    await lockTeamLifecycle(tx, row.teamId, teamBillingDenied);
    return row;
  });
  if (!snapshot) return null;
  const config = db.paymentsConfig.stripe;
  cardIdentityKey(config, db.serverEnv);
  if (snapshot.mode !== (config.livemode ? "live" : "sandbox")) throw teamBillingDenied();
  let result;
  try {
    const provider = db.createStripeTeamBillingProvider({ config, env: db.serverEnv, signal: context.signal,
      ...(db.stripeApiBaseUrl ? { apiBaseUrl: db.stripeApiBaseUrl } : {}) });
    result = await provider.readSubscriptionCardIdentity({ customerId: snapshot.providerCustomerId, subscriptionId: snapshot.providerSubscriptionId });
    if (result?.pending === true) throw Object.assign(new Error(), { retryable: true });
    if (result?.ok !== true || result.card !== null && (!result.card || Object.keys(result.card).join() !== "token" || !/^[A-Za-z0-9_-]{43}$/.test(result.card.token))) throw new Error();
  } catch (error: any) {
    // Never let custom provider diagnostics or transient provider evidence enter Job errors.
    throw Object.assign(new Error("Team card identity capture is unavailable."), { code: "TEAM_BILLING_CARD_IDENTITY_UNAVAILABLE", retryable: error?.retryable !== false });
  }
  if (context.signal?.aborted) throw Object.assign(new Error("Team card identity capture was cancelled."), { code: "ABORT_ERR", name: "AbortError" });
  await db.adapter.withTransaction(async (tx: Obj) => {
    // Erasure can remove the Team while provider I/O is in flight. Never recreate rows.
    const exists = await tx.prepare(tx.dialect.sql("SELECT [id] FROM [sporades_teams] WHERE [id] = ?")).get(snapshot.teamId);
    if (!exists) return;
    await lockTeamLifecycle(tx, snapshot.teamId, teamBillingDenied);
    await tx.prepare(tx.dialect.sql(
      "UPDATE [sporades_team_billing_card_identities] SET [kind] = ?, [token] = ?, [capturedAt] = ? " +
      "WHERE [operationId] = ? AND [generationId] = ? AND [kind] = 'pending'",
    )).run(result.card ? "card" : "none", result.card?.token ?? null, db.clock.now().toISOString(), payload.operationId, payload.generationId);
  });
  return null;
}

export async function readTeamBillingCardIdentity(db: Obj, tx: Obj, teamId: any) {
  if (!db.teamBillingDefinition || typeof teamId !== "string" || !UUID.test(teamId)) throw teamBillingDenied();
  cardIdentityKey(db.paymentsConfig?.stripe ?? {}, db.serverEnv);
  const row = await tx.prepare(tx.dialect.sql(
    "SELECT [c].[kind], [c].[token], [c].[capturedAt] FROM [sporades_team_billing_operations] [o] " +
    "LEFT JOIN [sporades_team_billing_card_identities] [c] ON [c].[operationId] = [o].[id] " +
    "WHERE [o].[teamId] = ? AND [o].[mode] = ? AND [o].[status] = 'completed' AND [o].[kind] IN ('checkout', 'currency-handover') ORDER BY [o].[createdAt] DESC, [o].[id] DESC LIMIT 1",
  )).get(teamId, db.paymentsConfig.stripe.livemode ? "live" : "sandbox");
  if (!row) return Object.freeze({ state: "none" as const });
  if (!row.capturedAt) return Object.freeze({ state: "pending" as const });
  if (!["card", "none"].includes(row.kind) || row.kind === "card" && !/^[A-Za-z0-9_-]{43}$/.test(row.token)
    || typeof row.capturedAt !== "string" || !/^\d{4}-/.test(row.capturedAt) || !Number.isFinite(Date.parse(row.capturedAt)) || new Date(row.capturedAt).toISOString() !== row.capturedAt) throw teamBillingDenied();
  return Object.freeze({ state: "captured" as const, card: row.kind === "card" ? Object.freeze({ token: row.token }) : null, capturedAt: row.capturedAt });
}
