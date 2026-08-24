// Provider-safe Team Billing erasure. Sporades proves provider quiescence and
// returns only deletion authorization; the Capsule owns its separate local
// deletion transaction.
import { createHash, randomUUID } from "node:crypto";

import { admitTeamBillingActor, readCapsuleTeamBillingProjection, teamBillingErasureKey, teamBillingErasureObjectKey } from "./team-billing-runtime.js";

type LooseRecord = Record<string, any>;

export const TEAM_BILLING_ERASURE_JOB = "_sporades.team-billing-erasure";
const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKOUT_ID = /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,240}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,120}$/;
const CLAIM_TTL_MS = 5 * 60_000;

export async function prepareTeamBillingErasure(
  database: LooseRecord,
  auth: LooseRecord,
  teamId: any,
  requestId: any,
) {
  if (!TEAM_ID.test(String(teamId ?? "")) || !TEAM_ID.test(String(requestId ?? ""))) throw unavailable();
  let dispatch = false;
  const result = await database.adapter.withTransaction(async (transaction: LooseRecord) => {
    await admitTeamBillingActor(database, transaction, auth, { operation: "erasure", teamId });
    const key = teamBillingErasureKey(database, teamId);
    if (await tombstone(transaction, key)) return Object.freeze({ state: "authorized" as const, teamId, requestId });
    const existing = await transaction.prepare(transaction.dialect.sql(
      "SELECT [e].[operationId], [e].[status], [o].[requestId], [o].[createdAt] " +
      "FROM [sporades_team_billing_erasure_state] [e] JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [e].[operationId] WHERE [e].[teamId] = ?",
    )).get(teamId);
    if (existing) {
      // The durable provider intent is Team-scoped. A refreshed client cannot
      // recover its previous public request UUID, so a fresh command identity
      // is allowed to observe (but never replace or duplicate) that work.
      return Object.freeze({ state: "pending" as const, teamId, requestId, requestedAt: existing.createdAt });
    }
    const operationId = randomUUID();
    const generationId = randomUUID();
    const now = database.clock.now().toISOString();
    await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [safeFailureCode] = 'ERASURE_REQUESTED', [updatedAt] = ? " +
      "WHERE [teamId] = ? AND [kind] <> 'checkout' AND [status] IN ('queued', 'running', 'retrying', 'ready', 'awaiting-observation')",
    )).run(now, teamId);
    await transaction.prepare(transaction.dialect.sql(
      "DELETE FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
    )).run(teamId);
    await transaction.prepare(transaction.dialect.sql(
      "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt]) " +
      "VALUES (?, ?, ?, ?, 'erasure', NULL, 'queued', NULL, ?, NULL, ?, ?)",
    )).run(operationId, requestId, teamId, auth.userId, providerIdempotency(database, key), now, now);
    await transaction.prepare(transaction.dialect.sql(
      "INSERT INTO [sporades_team_billing_erasure_state] ([teamId], [erasureKey], [operationId], [activeJobGenerationId], [status], [safeFailureCode], [createdAt], [updatedAt]) " +
      "VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?)",
    )).run(teamId, key, operationId, generationId, now, now);
    if (typeof database.enqueueTeamBillingErasureJob !== "function") throw unavailable();
    await database.enqueueTeamBillingErasureJob(
      transaction,
      { operationId, generationId },
      `team-billing-erasure:${operationId}:${generationId}`,
    );
    dispatch = true;
    return Object.freeze({ state: "pending" as const, teamId, requestId, requestedAt: now });
  });
  if (dispatch) database.scheduleTeamBillingJobDispatch?.();
  return result;
}

export async function performTeamBillingErasure(database: LooseRecord, context: LooseRecord, payload: any) {
  if (!exactPayload(payload)) return { superseded: true };
  const claimToken = randomUUID();
  const snapshot = await database.adapter.withTransaction(async (transaction: LooseRecord) => {
    const state = await transaction.prepare(transaction.dialect.sql(
      "SELECT [e].*, [o].[actorUserId] FROM [sporades_team_billing_erasure_state] [e] JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [e].[operationId] " +
      "WHERE [e].[operationId] = ?",
    )).get(payload.operationId);
    if (!state || state.activeJobGenerationId !== payload.generationId) return null;
    const auth = await database.readTeamBillingActorAuth?.(transaction, state.actorUserId);
    await admitTeamBillingActor(database, transaction, auth, { operation: "erasure", teamId: state.teamId });
    await ensureLane(transaction, state.teamId, database);
    const expiresAt = new Date(database.clock.now().getTime() + CLAIM_TTL_MS).toISOString();
    const claimed = await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? " +
      "WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)",
    )).run(claimToken, expiresAt, now(database), state.teamId, now(database));
    if (Number(claimed?.changes ?? claimed?.changesCount ?? 0) !== 1) throw retryable("TEAM_BILLING_PROVIDER_LANE_BUSY");
    const customer = await transaction.prepare(transaction.dialect.sql(
      "SELECT [mode], [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ?",
    )).get(state.teamId);
    const subscriptions = await transaction.prepare(transaction.dialect.sql(
      "SELECT [mode], [providerSubscriptionId] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? ORDER BY [providerSubscriptionId]",
    )).all(state.teamId);
    const checkouts = await transaction.prepare(transaction.dialect.sql(
      "SELECT [id], [productKey], [providerObjectId], [mode], [quantity], [providerPriceId], [providerExpiresAt], [idempotencyKey], [status], [attemptedAt] " +
      "FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [kind] = 'checkout' ORDER BY [providerObjectId], [id]",
    )).all(state.teamId);
    const mode = customer?.mode ?? subscriptions[0]?.mode ?? checkouts.find((row: LooseRecord) => row.mode)?.mode
      ?? (database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox");
    if (!["sandbox", "live"].includes(mode)
      || customer && customer.mode !== mode
      || subscriptions.some((row: LooseRecord) => row.mode !== mode)
      || checkouts.some((row: LooseRecord) => row.mode && row.mode !== mode)) throw unavailable();
    const checkoutSessionIds = checkouts.map((row: LooseRecord) => row.providerObjectId).filter(Boolean);
    const checkoutRecoveries = checkouts.filter((row: LooseRecord) => row.attemptedAt && !row.providerObjectId).map((row: LooseRecord) => ({
      operationId: row.id,
      teamId: state.teamId,
      productKey: row.productKey,
      mode: "subscription",
      priceId: row.providerPriceId,
      quantity: Number(row.quantity),
      successPath: database.teamBillingDefinition?.checkout?.successPath,
      cancelPath: database.teamBillingDefinition?.checkout?.cancelPath,
      idempotencyKey: row.idempotencyKey,
      businessReference: row.id,
      providerExpiresAt: Number(row.providerExpiresAt),
      ...(customer ? { customerId: customer.providerCustomerId } : {}),
    }));
    const subscriptionIds = subscriptions.map((row: LooseRecord) => row.providerSubscriptionId);
    if (!checkoutSessionIds.every((id: any) => CHECKOUT_ID.test(id))
      || !subscriptionIds.every((id: any) => SUBSCRIPTION_ID.test(id))
      || customer && !CUSTOMER_ID.test(customer.providerCustomerId)) throw unavailable();
    await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_erasure_state] SET [status] = 'running', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [operationId] = ? AND [activeJobGenerationId] = ?",
    )).run(now(database), state.operationId, payload.generationId);
    return {
      teamId: state.teamId,
      erasureKey: state.erasureKey,
      operationId: state.operationId,
      generationId: payload.generationId,
      provider: {
        mode,
        ...(customer ? { customerId: customer.providerCustomerId } : {}),
        checkoutSessionIds,
        ...(checkoutRecoveries.length ? { checkoutRecoveries } : {}),
        subscriptionIds,
        idempotencyKey: providerIdempotency(database, state.erasureKey),
      },
    };
  });
  if (!snapshot) return { superseded: true };
  try {
    if (typeof database.quiesceTeamBillingProvider !== "function") throw retryable("TEAM_BILLING_PROVIDER_UNAVAILABLE");
    const evidence = await database.quiesceTeamBillingProvider(context, Object.freeze(snapshot.provider));
    const canonical = validateEvidence(evidence, snapshot.provider);
    const settled = await database.adapter.withTransaction(async (transaction: LooseRecord) => {
      const laneOwned = await transaction.prepare(transaction.dialect.sql(
        "UPDATE [sporades_team_billing_provider_lanes] SET [updatedAt] = [updatedAt] WHERE [teamId] = ? AND [claimToken] = ?",
      )).run(snapshot.teamId, claimToken);
      if (Number(laneOwned?.changes ?? laneOwned?.changesCount ?? 0) !== 1) return false;
      const current = await transaction.prepare(transaction.dialect.sql(
        "SELECT [teamId], [erasureKey] FROM [sporades_team_billing_erasure_state] WHERE [operationId] = ? AND [activeJobGenerationId] = ?",
      )).get(snapshot.operationId, snapshot.generationId);
      if (!current) {
        await transaction.prepare(transaction.dialect.sql(
          "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?",
        )).run(now(database), snapshot.teamId, claimToken);
        return false;
      }
      const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      await transaction.prepare(transaction.dialect.sql(
        "INSERT INTO [sporades_team_billing_erasure_tombstones] ([erasureKey], [evidenceDigest], [providerQuiescedAt], [createdAt]) VALUES (?, ?, ?, ?)",
      )).run(current.erasureKey, digest, canonical.providerObservedAt, now(database));
      for (const entry of [...canonical.checkouts.map((item: LooseRecord) => ({ ...item, kind: "checkout" })),
        ...canonical.subscriptions.map((item: LooseRecord) => ({ ...item, kind: "subscription" }))]) {
        await transaction.prepare(transaction.dialect.sql(
          "INSERT INTO [sporades_team_billing_erasure_object_tombstones] ([objectKey], [kind], [terminalState], [providerQuiescedAt], [createdAt]) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )).run(teamBillingErasureObjectKey(database, entry.id), entry.kind, entry.state, canonical.providerObservedAt, now(database));
      }
      for (const table of [
        "sporades_team_billing_observations",
        "sporades_team_billing_subscriptions",
        "sporades_team_billing_customers",
        "sporades_team_billing_desired_state",
        "sporades_team_billing_operations",
      ]) await transaction.prepare(transaction.dialect.sql(`DELETE FROM [${table}] WHERE [teamId] = ?`)).run(current.teamId);
      await transaction.prepare(transaction.dialect.sql("DELETE FROM [sporades_team_billing_erasure_state] WHERE [teamId] = ?")).run(current.teamId);
      const released = await transaction.prepare(transaction.dialect.sql(
        "DELETE FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ? AND [claimToken] = ?",
      )).run(current.teamId, claimToken);
      if (Number(released?.changes ?? released?.changesCount ?? 0) !== 1) throw retryable("TEAM_BILLING_PROVIDER_LANE_LOST");
      return true;
    });
    return settled ? { providerQuiesced: true } : { superseded: true };
  } catch (error: any) {
    await database.adapter.withTransaction(async (transaction: LooseRecord) => {
      await transaction.prepare(transaction.dialect.sql(
        "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?",
      )).run(now(database), snapshot.teamId, claimToken);
      await transaction.prepare(transaction.dialect.sql(
        "UPDATE [sporades_team_billing_erasure_state] SET [status] = 'queued', [safeFailureCode] = ?, [updatedAt] = ? WHERE [operationId] = ? AND [activeJobGenerationId] = ?",
      )).run(safeCode(error?.code), now(database), snapshot.operationId, snapshot.generationId);
    });
    error.retryable ??= true;
    throw error;
  }
}

/**
 * Restart reconciliation deliberately rotates the Job generation. The provider
 * tuple remains stable, while any pre-crash worker becomes unable to settle the
 * current erasure state.
 */
export async function repairTeamBillingErasureStateAtStartup(database: LooseRecord) {
  let queued = 0;
  await database.adapter.withTransaction(async (transaction: LooseRecord) => {
    const rows = await transaction.prepare(transaction.dialect.sql(
      "SELECT [operationId] FROM [sporades_team_billing_erasure_state] WHERE [status] IN ('queued', 'running', 'failed') ORDER BY [operationId]",
    )).all();
    for (const row of rows) {
      const generationId = randomUUID();
      const changed = await transaction.prepare(transaction.dialect.sql(
        "UPDATE [sporades_team_billing_erasure_state] SET [activeJobGenerationId] = ?, [status] = 'queued', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [operationId] = ?",
      )).run(generationId, now(database), row.operationId);
      if (Number(changed?.changes ?? changed?.changesCount ?? 0) !== 1) continue;
      await database.enqueueTeamBillingErasureJob(
        transaction,
        { operationId: row.operationId, generationId },
        `team-billing-erasure:${row.operationId}:${generationId}`,
      );
      queued += 1;
    }
  });
  if (queued) database.scheduleTeamBillingJobDispatch?.();
  return { queued };
}

/** A terminal Job may fail only the generation it actually owned. */
export async function settleExhaustedTeamBillingErasureJob(
  database: LooseRecord,
  payload: any,
  safeFailureCode = "RETRY_EXHAUSTED",
) {
  if (!exactPayload(payload)) return { settled: false };
  const failureCode = safeCode(safeFailureCode);
  let replacementScheduled = false;
  const result = await inTransaction(database, async (transaction) => {
    const state = await transaction.prepare(transaction.dialect.sql(
      "SELECT [teamId], [operationId], [activeJobGenerationId], [status] FROM [sporades_team_billing_erasure_state] WHERE [operationId] = ?",
    )).get(payload.operationId);
    if (!state || state.activeJobGenerationId !== payload.generationId
      || !["queued", "running"].includes(state.status)) return { settled: false };
    const lane = await transaction.prepare(transaction.dialect.sql(
      "SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
    )).get(state.teamId);
    const liveClaimExpiry = lane?.claimToken && canonicalTimestamp(lane.claimExpiresAt)
      && lane.claimExpiresAt > now(database) ? lane.claimExpiresAt : null;
    if (liveClaimExpiry || failureCode === "TEAM_BILLING_PROVIDER_LANE_BUSY") {
      const generationId = randomUUID();
      const availableAt = liveClaimExpiry ?? now(database);
      const changed = await transaction.prepare(transaction.dialect.sql(
        "UPDATE [sporades_team_billing_erasure_state] SET [activeJobGenerationId] = ?, [status] = 'queued', [safeFailureCode] = NULL, [updatedAt] = ? " +
        "WHERE [operationId] = ? AND [activeJobGenerationId] = ? AND [status] IN ('queued', 'running')",
      )).run(generationId, now(database), payload.operationId, payload.generationId);
      if (Number(changed?.changes ?? changed?.changesCount ?? 0) !== 1) return { settled: false };
      await database.enqueueTeamBillingErasureJob(
        transaction,
        { operationId: payload.operationId, generationId },
        `team-billing-erasure:${payload.operationId}:${generationId}`,
        availableAt,
      );
      replacementScheduled = true;
      return { settled: false, busy: true, replacementScheduled: true, availableAt };
    }
    const settled = await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_erasure_state] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? " +
      "WHERE [operationId] = ? AND [activeJobGenerationId] = ? AND [status] IN ('queued', 'running')",
    )).run(failureCode, now(database), payload.operationId, payload.generationId);
    return { settled: Number(settled?.changes ?? settled?.changesCount ?? 0) === 1 };
  });
  if (replacementScheduled && !database.__transactionActive) database.scheduleTeamBillingJobDispatch?.();
  return result;
}

/** Transaction-bound admission for the Capsule's separate local deletion mutation. */
export function createCurrentUserTeamBillingErasureApi(
  database: LooseRecord,
  auth: LooseRecord,
  contextGetter: () => LooseRecord | null = () => null,
  isCurrentContext: (context: LooseRecord) => boolean = () => false,
) {
  const requireActiveContext = () => {
    const context = contextGetter();
    if (!context || !isCurrentContext(context) || context.signal?.aborted) {
      throw inactiveContext();
    }
    return context;
  };
  const requireContext = () => {
    const context = requireActiveContext();
    if (!database.__transactionActive) throw inactiveContext();
    return context;
  };
  return Object.freeze({
    async get(teamId: any) {
      requireActiveContext();
      const result = database.__transactionActive
        ? await readCapsuleTeamBillingProjection(database, database.adapter, auth, teamId)
        : await database.adapter.withTransaction((transaction: LooseRecord) =>
          readCapsuleTeamBillingProjection(database, transaction, auth, teamId));
      requireActiveContext();
      return result;
    },
    async admitLocalErasure(teamId: any) {
      requireContext();
      if (!TEAM_ID.test(String(teamId ?? ""))) throw unavailable();
      await admitTeamBillingActor(database, database.adapter, auth, { operation: "erasure", teamId });
      requireContext();
      if (!await tombstone(database.adapter, teamBillingErasureKey(database, teamId))) throw unavailable();
      requireContext();
      return Object.freeze({ allowed: true as const });
    },
  });
}

async function tombstone(transaction: LooseRecord, key: string) {
  return transaction.prepare(transaction.dialect.sql(
    "SELECT [erasureKey] FROM [sporades_team_billing_erasure_tombstones] WHERE [erasureKey] = ?",
  )).get(key);
}

async function ensureLane(transaction: LooseRecord, teamId: string, database: LooseRecord) {
  await transaction.prepare(transaction.dialect.sql(
    "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?) ON CONFLICT DO NOTHING",
  )).run(teamId, now(database));
}

async function inTransaction(database: LooseRecord, callback: (transaction: LooseRecord) => Promise<any>) {
  if (database.__transactionActive || typeof database.adapter?.withTransaction !== "function") return callback(database.adapter);
  return database.adapter.withTransaction(callback);
}

function validateEvidence(value: any, expected: LooseRecord) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== "checkouts\0ok\0outcome\0providerObservedAt\0subscriptions"
    || value.ok !== true || value.outcome !== "quiesced" || !canonicalTimestamp(value.providerObservedAt)
    || !Array.isArray(value.checkouts) || !Array.isArray(value.subscriptions)) throw unavailable();
  const checkouts = value.checkouts.map((entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join("\0") !== "id\0state" || !CHECKOUT_ID.test(entry.id)
      || !["complete", "expired", "safely-closed"].includes(entry.state)) throw unavailable();
    return { id: entry.id, state: entry.state };
  }).sort(byId);
  const subscriptions = value.subscriptions.map((entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join("\0") !== "id\0state" || !SUBSCRIPTION_ID.test(entry.id)
      || !["cancelled", "safely-closed"].includes(entry.state)) throw unavailable();
    return { id: entry.id, state: entry.state };
  }).sort(byId);
  if (new Set(checkouts.map((entry: LooseRecord) => entry.id)).size !== checkouts.length
    || new Set(subscriptions.map((entry: LooseRecord) => entry.id)).size !== subscriptions.length
    || checkouts.length < expected.checkoutSessionIds.length + (expected.checkoutRecoveries?.length ?? 0)
    || expected.checkoutSessionIds.some((id: string) => !checkouts.some((entry: LooseRecord) => entry.id === id))
    || expected.subscriptionIds.some((id: string) => !subscriptions.some((entry: LooseRecord) => entry.id === id))) throw unavailable();
  return { providerObservedAt: value.providerObservedAt, checkouts, subscriptions };
}

function providerIdempotency(database: LooseRecord, key: string) {
  return `sporades-team-billing-erasure-${createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0${key}`).digest("hex")}`;
}

function exactPayload(value: any) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "generationId\0operationId"
    && TEAM_ID.test(value.operationId) && TEAM_ID.test(value.generationId);
}

function canonicalTimestamp(value: any) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function byId(left: LooseRecord, right: LooseRecord) { return left.id.localeCompare(right.id); }
function now(database: LooseRecord) { return database.clock.now().toISOString(); }
function safeCode(value: any) { return String(value ?? "PROVIDER_UNAVAILABLE").replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 64); }
function retryable(code: string) { const error: any = unavailable(); error.code = code; error.retryable = true; return error; }
function conflict() { const error: any = unavailable(); error.code = "TEAM_BILLING_REQUEST_CONFLICT"; return error; }
function inactiveContext() { const error: any = unavailable(); error.code = "TEAM_BILLING_ERASURE_CONTEXT_INACTIVE"; return error; }
function unavailable() { const error: any = new Error("Team Billing erasure is unavailable."); error.code = "TEAM_BILLING_ERASURE_UNAVAILABLE"; return error; }
