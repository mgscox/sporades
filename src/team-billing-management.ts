// Desired-state controller for managed Team Billing changes. Membership and
// browser mutations only stage durable intent; provider I/O runs later in a
// serialized lane and verified Stripe observations are the only settlement.
import { createHash, randomUUID } from "node:crypto";

import { countAcceptedTeamMembers } from "./teams-runtime.js";
import { assertTeamBillingErasureInactive } from "./team-billing-runtime.js";

type LooseRecord = Record<string, any>;

export const TEAM_BILLING_PLAN_TRANSITION_JOB = "_sporades.team-billing-plan-transition";
export const TEAM_BILLING_SEAT_CONVERGENCE_JOB = "_sporades.team-billing-seat-convergence";
const CLAIM_TTL_MS = 5 * 60 * 1_000;
const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requestTeamBillingPlanTransition(
  database: LooseRecord,
  auth: LooseRecord,
  teamId: any,
  requestId: any,
  productKey: any,
) {
  const definition = database.teamBillingDefinition;
  if (!TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? ""))
    || typeof productKey !== "string" || !definition?.catalogue?.[productKey]) throw denied();
  let enqueued = false;
  const result = await inTransaction(database, async (transaction) => {
    await admitPlanTransition(database, transaction, auth, teamId, productKey);
    await assertTeamBillingErasureInactive(database, transaction, teamId);
    const sql = transaction.dialect.sql;
    const repeated = await transaction.prepare(sql(
      "SELECT [id], [kind], [productKey], [status], [safeFailureCode], [createdAt] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
    )).get(teamId, requestId);
    if (repeated) {
      if (repeated.kind !== "plan-transition" || repeated.productKey !== productKey) throw conflict();
      return planOperationResult(teamId, requestId, productKey, repeated);
    }
    const subscription = await currentSubscription(transaction, teamId);
    const currentProduct = definition.catalogue[subscription.productKey];
    const targetProduct = definition.catalogue[productKey];
    assertCurrentModeAndCatalogue(database, subscription, currentProduct);
    if (!currentProduct || sameQuantityPolicy(currentProduct.quantity, targetProduct.quantity)) throw transitionNotRequired();
    const quantity = await targetQuantity(transaction, teamId, targetProduct);
    const operationId = randomUUID();
    const now = nowIso(database);
    const effectiveAt = nowSeconds(database);
    const staged = await stageDesired(transaction, database, {
      teamId, kind: "plan-transition", operationId, targetProductKey: productKey, targetQuantity: quantity, effectiveAt,
    });
    await transaction.prepare(sql(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? " +
      "WHERE [teamId] = ? AND [kind] = 'plan-transition' AND [status] IN ('queued', 'running', 'awaiting-observation')",
    )).run(now, teamId);
    await transaction.prepare(sql(
      "INSERT INTO [sporades_team_billing_operations] " +
      "([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity]) " +
      "VALUES (?, ?, ?, ?, 'plan-transition', ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?)",
    )).run(operationId, requestId, teamId, auth.userId, productKey, operationIdempotency(database, operationId), now, now, subscription.mode, quantity);
    await enqueueIntent(database, transaction, staged);
    enqueued = true;
    return Object.freeze({ state: "pending" as const, teamId, requestId, productKey, requestedAt: now });
  });
  if (enqueued) scheduleAfterOwnedTransaction(database);
  return result;
}

/** Called after a membership transaction commits. It performs no provider I/O. */
export async function stageTeamBillingMembershipChange(database: LooseRecord, teamId: any, effectiveAt = nowSeconds(database)) {
  if (!TEAM_ID_PATTERN.test(String(teamId ?? "")) || !Number.isSafeInteger(effectiveAt) || effectiveAt < 0) return { staged: false };
  let enqueued = false;
  const result = await inTransaction(database, async (transaction) => {
    try { await assertTeamBillingErasureInactive(database, transaction, teamId); }
    catch { return Object.freeze({ staged: false as const, reason: "erasure-active" as const }); }
    const subscription = await optionalCurrentSubscription(transaction, teamId);
    if (!subscription) return Object.freeze({ staged: false as const });
    const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
    if (product?.quantity?.kind !== "team-members") return Object.freeze({ staged: false as const });
    const quantity = await countAcceptedTeamMembers(transaction, teamId, denied);
    const existing = await desiredForTeam(transaction, teamId);
    if (existing?.kind === "plan-transition") return Object.freeze({ staged: false as const, reason: "plan-transition-active" as const });
    if (!existing && subscription.quantity === quantity) return Object.freeze({ staged: false as const });
    const staged = await stageDesired(transaction, database, {
      teamId, kind: "seat-convergence", operationId: null, targetProductKey: subscription.productKey,
      targetQuantity: quantity, effectiveAt,
    });
    let generationId = staged.activeJobGenerationId ?? null;
    if (staged.enqueue) {
      generationId = await enqueueIntent(database, transaction, staged);
      enqueued = true;
    }
    return Object.freeze({ staged: true as const, intentId: staged.intentId, generationId, quantity });
  });
  if (enqueued) scheduleAfterOwnedTransaction(database);
  return result;
}

export async function performTeamBillingPlanTransition(database: LooseRecord, context: LooseRecord, payload: any) {
  return performDesired(database, context, payload, "plan-transition");
}

export async function performTeamBillingSeatConvergence(database: LooseRecord, context: LooseRecord, payload: any) {
  return performDesired(database, context, payload, "seat-convergence");
}

async function performDesired(database: LooseRecord, _context: LooseRecord, payload: any, kind: string) {
  if (typeof payload?.intentId !== "string" || typeof payload?.generationId !== "string") return { superseded: true };
  const claimToken = randomUUID();
  const snapshot = await inTransaction(database, async (transaction) => {
    const desired = await desiredByIntent(transaction, payload.intentId);
    if (!desired || desired.kind !== kind || desired.activeJobGenerationId !== payload.generationId
      || !["queued", "running", "awaiting-observation"].includes(desired.status)) return { superseded: true };
    const subscription = await currentSubscription(transaction, desired.teamId);
    const product = database.teamBillingDefinition?.catalogue?.[desired.targetProductKey];
    if (!product) return attention(transaction, database, desired, "CATALOGUE_MISMATCH");
    try {
      assertCurrentModeAndCatalogue(database, subscription, database.teamBillingDefinition?.catalogue?.[subscription.productKey]);
    } catch {
      return attention(transaction, database, desired, "PROVIDER_STATE_AMBIGUOUS");
    }
    if (kind === "plan-transition") {
      const auth = await database.readTeamBillingActorAuth?.(transaction, await actorForOperation(transaction, desired.operationId));
      const admission = await tryAdmitPlanTransition(database, transaction, auth, desired.teamId, desired.targetProductKey);
      if (!admission) return attention(transaction, database, desired, "AUTHORITY_CHANGED", true);
      const exact = await targetQuantity(transaction, desired.teamId, product);
      if (exact !== Number(desired.targetQuantity)) {
        const replacement = await stageDesired(transaction, database, {
          teamId: desired.teamId, kind, operationId: desired.operationId, targetProductKey: desired.targetProductKey,
          targetQuantity: exact, effectiveAt: nowSeconds(database),
        });
        await enqueueIntent(database, transaction, replacement);
        return { superseded: true, dispatch: true };
      }
    } else {
      const exact = await countAcceptedTeamMembers(transaction, desired.teamId, denied);
      if (exact !== Number(desired.targetQuantity) || subscription.productKey !== desired.targetProductKey) {
        const targetProductKey = subscription.productKey;
        const currentProduct = database.teamBillingDefinition?.catalogue?.[targetProductKey];
        if (currentProduct?.quantity?.kind !== "team-members") return { superseded: true };
        const replacement = await stageDesired(transaction, database, {
          teamId: desired.teamId, kind, operationId: null, targetProductKey, targetQuantity: exact, effectiveAt: nowSeconds(database),
        });
        await enqueueIntent(database, transaction, replacement);
        return { superseded: true, dispatch: true };
      }
    }
    const customer = await transaction.prepare(transaction.dialect.sql(
      "SELECT [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ? AND [mode] = ?",
    )).get(desired.teamId, subscription.mode);
    if (!customer?.providerCustomerId) return attention(transaction, database, desired, "PROVIDER_STATE_AMBIGUOUS");
    const claimed = await claimLane(transaction, desired.teamId, claimToken, database);
    if (!claimed) throw retryable("TEAM_BILLING_PROVIDER_LANE_BUSY");
    await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [status] = 'running', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [intentId] = ?",
    )).run(nowIso(database), desired.intentId);
    const binding = modeBinding(database, product);
    return {
      desired: { ...desired },
      provider: {
        teamId: desired.teamId,
        mode: subscription.mode,
        providerCustomerId: customer.providerCustomerId,
        providerSubscriptionId: subscription.providerSubscriptionId,
        providerSubscriptionItemId: subscription.providerSubscriptionItemId,
        sourcePriceId: subscription.providerPriceId,
        targetPriceId: binding.priceId,
        ...(binding.productId ? { targetProductId: binding.productId } : {}),
        targetProductKey: desired.targetProductKey,
        targetQuantity: Number(desired.targetQuantity),
        effectiveAt: Number(desired.effectiveAt),
        prorationDate: Number(desired.effectiveAt),
        idempotencyKey: desired.idempotencyKey,
        operationKind: desired.kind,
      },
    };
  });
  if (snapshot.dispatch) database.scheduleTeamBillingJobDispatch?.();
  if (snapshot.superseded) return { superseded: true };
  if (snapshot.denied) throw denied();
  try {
    if (typeof database.updateTeamBillingSubscription !== "function") throw retryable("TEAM_BILLING_PROVIDER_UNAVAILABLE");
    const providerResult = await database.updateTeamBillingSubscription(_context, Object.freeze(snapshot.provider));
    if (!validProviderAcknowledgement(providerResult)) throw coded(
      "Team Billing provider returned an invalid acknowledgement.", "TEAM_BILLING_PROVIDER_REJECTED",
    );
    if (providerResult?.outcome === "payment-action-required") {
      await releaseAfterFailure(database, snapshot.desired, claimToken, { retryable: false, code: "PAYMENT_ACTION_REQUIRED" });
      return { failed: true, safeFailureCode: "PAYMENT_ACTION_REQUIRED" };
    }
  } catch (error: any) {
    const classified = classifyProviderError(database, error);
    await releaseAfterFailure(database, snapshot.desired, claimToken, classified);
    if (classified.retryable) {
      error.retryable = true;
      error.code ??= classified.code;
    }
    throw error;
  }
  const acknowledged = await inTransaction(database, async (transaction) => {
    const current = await desiredByIntent(transaction, snapshot.desired.intentId);
    await releaseLane(transaction, snapshot.desired.teamId, claimToken, database);
    if (!current) return false;
    await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [status] = 'awaiting-observation', [providerAcknowledgedAt] = ?, [safeFailureCode] = NULL, [updatedAt] = ? WHERE [intentId] = ?",
    )).run(nowIso(database), nowIso(database), current.intentId);
    if (current.operationId) await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'awaiting-observation', [updatedAt] = ? WHERE [id] = ?",
    )).run(nowIso(database), current.operationId);
    return true;
  });
  return acknowledged ? { providerAcknowledged: true } : { superseded: true };
}

/** Invoked only after full verified-event validation has accepted this target. */
export async function settleVerifiedTeamBillingTarget(database: LooseRecord, accepted: LooseRecord) {
  if (!accepted || typeof accepted.teamId !== "string" || typeof accepted.productKey !== "string"
    || !Number.isSafeInteger(accepted.quantity) || typeof accepted.subscriptionId !== "string") return { settled: false };
  let enqueued = false;
  const result = await inTransaction(database, async (transaction) => {
    const sql = transaction.dialect.sql;
    const subscription = await transaction.prepare(sql(
      "SELECT [providerSubscriptionId] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [providerSubscriptionId] = ?",
    )).get(accepted.teamId, accepted.subscriptionId);
    if (!subscription) return { settled: false };
    const desired = await desiredForTeam(transaction, accepted.teamId);
    if (!desired) return { settled: false };
    if (desired.targetProductKey === accepted.productKey && Number(desired.targetQuantity) === accepted.quantity) {
      const product = database.teamBillingDefinition?.catalogue?.[accepted.productKey];
      if (product?.quantity?.kind === "team-members") {
        const exact = await countAcceptedTeamMembers(transaction, accepted.teamId, denied);
        if (exact !== accepted.quantity) {
          if (desired.operationId) await transaction.prepare(sql(
            "UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?",
          )).run(accepted.occurredAt ?? nowIso(database), desired.operationId);
          const replacement = await stageDesired(transaction, database, {
            teamId: accepted.teamId, kind: "seat-convergence", operationId: null,
            targetProductKey: accepted.productKey, targetQuantity: exact, effectiveAt: nowSeconds(database),
          });
          await enqueueIntent(database, transaction, replacement);
          enqueued = true;
          return { settled: true, repairRequired: true };
        }
      }
      await transaction.prepare(sql("DELETE FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?")).run(desired.intentId);
      await transaction.prepare(sql(
        "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ?",
      )).run(accepted.occurredAt ?? nowIso(database), accepted.teamId);
      if (desired.operationId) await transaction.prepare(sql(
        "UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?",
      )).run(accepted.occurredAt ?? nowIso(database), desired.operationId);
      return { settled: true };
    }
    if (desired.status === "awaiting-observation") {
      await transaction.prepare(sql(
        "UPDATE [sporades_team_billing_desired_state] SET [status] = 'queued', [safeFailureCode] = 'PROVIDER_DRIFT', [providerAcknowledgedAt] = NULL, [updatedAt] = ? WHERE [intentId] = ?",
      )).run(accepted.occurredAt ?? nowIso(database), desired.intentId);
      await enqueueIntent(database, transaction, { ...desired, enqueue: true });
      enqueued = true;
      return { settled: false, repairRequired: true };
    }
    return { settled: false };
  });
  if (enqueued) scheduleAfterOwnedTransaction(database);
  return result;
}

/** Startup/scheduled repair. Provider acknowledgement never suppresses repair. */
export async function repairTeamBillingDesiredState(database: LooseRecord) {
  let queued = 0;
  await inTransaction(database, async (transaction) => {
    const subscriptions = await transaction.prepare(transaction.dialect.sql(
      "SELECT [teamId], [productKey], [quantity] FROM [sporades_team_billing_subscriptions] WHERE [state] IN ('active', 'past-due') AND [terminalLatch] = 0 ORDER BY [teamId]",
    )).all();
    for (const subscription of subscriptions) {
      const desired = await desiredForTeam(transaction, subscription.teamId);
      if (desired) {
        if (desired.targetProductKey === subscription.productKey && Number(desired.targetQuantity) === Number(subscription.quantity)) {
          const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
          if (product?.quantity?.kind === "team-members") {
            const exact = await countAcceptedTeamMembers(transaction, subscription.teamId, denied);
            if (exact !== Number(subscription.quantity)) {
              const replacement = await stageDesired(transaction, database, {
                teamId: subscription.teamId, kind: "seat-convergence", operationId: null,
                targetProductKey: subscription.productKey, targetQuantity: exact, effectiveAt: nowSeconds(database),
              });
              await enqueueIntent(database, transaction, replacement);
              queued += 1;
              continue;
            }
          }
          if (desired.operationId) await transaction.prepare(transaction.dialect.sql(
            "UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?",
          )).run(nowIso(database), desired.operationId);
          await transaction.prepare(transaction.dialect.sql("DELETE FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?")).run(desired.intentId);
          continue;
        }
        await transaction.prepare(transaction.dialect.sql(
          "UPDATE [sporades_team_billing_desired_state] SET [status] = 'queued', [providerAcknowledgedAt] = NULL, [updatedAt] = ? WHERE [intentId] = ?",
        )).run(nowIso(database), desired.intentId);
        await enqueueIntent(database, transaction, { ...desired, enqueue: true });
        queued += 1;
        continue;
      }
      const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
      if (product?.quantity?.kind !== "team-members") continue;
      const exact = await countAcceptedTeamMembers(transaction, subscription.teamId, denied);
      if (exact === Number(subscription.quantity)) continue;
      const staged = await stageDesired(transaction, database, {
        teamId: subscription.teamId, kind: "seat-convergence", operationId: null,
        targetProductKey: subscription.productKey, targetQuantity: exact, effectiveAt: nowSeconds(database),
      });
      await enqueueIntent(database, transaction, staged);
      queued += 1;
    }
  });
  if (queued) scheduleAfterOwnedTransaction(database);
  return { queued };
}

export const repairTeamBillingDesiredStateAtStartup = repairTeamBillingDesiredState;

export async function settleExhaustedTeamBillingManagementJob(database: LooseRecord, payload: any, safeFailureCode = "RETRY_EXHAUSTED") {
  if (typeof payload?.intentId !== "string" || typeof payload?.generationId !== "string") return { settled: false };
  const failureCode = safeCode(safeFailureCode);
  let replacementScheduled = false;
  const result = await inTransaction(database, async (transaction) => {
    const desired = await desiredByIntent(transaction, payload.intentId);
    if (!desired || desired.activeJobGenerationId !== payload.generationId
      || desired.status === "awaiting-observation") return { settled: false, stale: true };
    const lane = await transaction.prepare(transaction.dialect.sql(
      "SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
    )).get(desired.teamId);
    if (lane?.claimToken && typeof lane.claimExpiresAt === "string" && lane.claimExpiresAt > nowIso(database)) {
      await enqueueIntent(database, transaction, { ...desired, enqueue: true }, lane.claimExpiresAt);
      replacementScheduled = true;
      return { settled: false, busy: true, replacementScheduled: true, availableAt: lane.claimExpiresAt };
    }
    if (failureCode === "TEAM_BILLING_PROVIDER_LANE_BUSY") {
      const availableAt = nowIso(database);
      await enqueueIntent(database, transaction, { ...desired, enqueue: true }, availableAt);
      replacementScheduled = true;
      return { settled: false, busy: true, replacementScheduled: true, availableAt };
    }
    const settled = await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [status] = 'failed', [safeFailureCode] = ?, [providerAcknowledgedAt] = NULL, [updatedAt] = ? " +
      "WHERE [intentId] = ? AND [activeJobGenerationId] = ? AND [status] IN ('queued', 'running')",
    )).run(failureCode, nowIso(database), desired.intentId, payload.generationId);
    if (Number(settled?.changes ?? settled?.changesCount ?? 0) !== 1) return { settled: false, stale: true };
    if (desired.operationId) await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ?",
    )).run(failureCode, nowIso(database), desired.operationId);
    return { settled: true };
  });
  // A caller already inside a transaction (lease recovery) must arrange its
  // wake only after that outer transaction commits. Ordinary final-attempt
  // settlement owns its transaction and can safely publish the delayed Job.
  if (replacementScheduled && !database.__transactionActive) scheduleAfterOwnedTransaction(database);
  return result;
}

async function stageDesired(transaction: LooseRecord, database: LooseRecord, input: LooseRecord) {
  const existing = await desiredForTeam(transaction, input.teamId);
  const unchanged = existing && existing.kind === input.kind && existing.targetProductKey === input.targetProductKey
    && Number(existing.targetQuantity) === input.targetQuantity;
  if (unchanged) {
    const transfersPlanOwnership = input.kind === "plan-transition" && typeof input.operationId === "string"
      && input.operationId !== existing.operationId;
    const enqueue = transfersPlanOwnership || ["failed", "attention-required"].includes(existing.status);
    if (enqueue) await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [operationId] = ?, [status] = 'queued', [safeFailureCode] = NULL, [providerAcknowledgedAt] = NULL, [updatedAt] = ? WHERE [intentId] = ?",
    )).run(transfersPlanOwnership ? input.operationId : existing.operationId, nowIso(database), existing.intentId);
    return { ...existing, operationId: transfersPlanOwnership ? input.operationId : existing.operationId,
      status: enqueue ? "queued" : existing.status, enqueue };
  }
  const intentId = randomUUID();
  const idempotencyKey = intentIdempotency(database, input.teamId, intentId);
  const now = nowIso(database);
  if (existing) {
    await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [intentId] = ?, [kind] = ?, [operationId] = ?, [targetProductKey] = ?, [targetQuantity] = ?, [effectiveAt] = ?, [idempotencyKey] = ?, [status] = 'queued', [safeFailureCode] = NULL, [providerAcknowledgedAt] = NULL, [activeJobGenerationId] = NULL, [createdAt] = ?, [updatedAt] = ? WHERE [teamId] = ?",
    )).run(intentId, input.kind, input.operationId, input.targetProductKey, input.targetQuantity, input.effectiveAt, idempotencyKey, now, now, input.teamId);
  } else {
    await transaction.prepare(transaction.dialect.sql(
      "INSERT INTO [sporades_team_billing_desired_state] ([teamId], [intentId], [kind], [operationId], [targetProductKey], [targetQuantity], [effectiveAt], [idempotencyKey], [status], [safeFailureCode], [providerAcknowledgedAt], [activeJobGenerationId], [createdAt], [updatedAt]) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)",
    )).run(input.teamId, intentId, input.kind, input.operationId, input.targetProductKey, input.targetQuantity, input.effectiveAt, idempotencyKey, now, now);
  }
  await ensureLane(transaction, input.teamId, database);
  return { ...input, intentId, idempotencyKey, status: "queued", enqueue: true };
}

async function enqueueIntent(database: LooseRecord, transaction: LooseRecord, desired: LooseRecord, availableAt?: string) {
  const callback = desired.kind === "plan-transition"
    ? database.enqueueTeamBillingPlanTransitionJob : database.enqueueTeamBillingSeatConvergenceJob;
  if (typeof callback !== "function") throw retryable("TEAM_BILLING_PROVIDER_UNAVAILABLE");
  // Provider idempotency belongs to the durable desired tuple and remains
  // stable. A repair dispatch is a new Job generation: terminal Job rows are
  // intentionally retained, so reusing their queue idempotency would make
  // restart or provider-drift repair collide with the unique Job index.
  const generationId = randomUUID();
  const activated = await transaction.prepare(transaction.dialect.sql(
    "UPDATE [sporades_team_billing_desired_state] SET [activeJobGenerationId] = ?, [updatedAt] = ? WHERE [intentId] = ?",
  )).run(generationId, nowIso(database), desired.intentId);
  if (Number(activated?.changes ?? activated?.changesCount ?? 0) !== 1) throw retryable("TEAM_BILLING_DESIRED_STATE_SUPERSEDED");
  await callback(
    transaction,
    { intentId: desired.intentId, generationId },
    `team-billing-management:${desired.intentId}:${generationId}`,
    availableAt,
  );
  return generationId;
}

async function admitPlanTransition(database: LooseRecord, transaction: LooseRecord, auth: LooseRecord, teamId: string, productKey: string) {
  if (!await tryAdmitPlanTransition(database, transaction, auth, teamId, productKey)) throw denied();
}

async function tryAdmitPlanTransition(database: LooseRecord, transaction: LooseRecord, auth: LooseRecord, teamId: string, productKey: string) {
  if (!auth?.userId || auth.isAuthenticated !== true || auth.isGuest === true) return false;
  const membership = await transaction.prepare(transaction.dialect.sql(
    "SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
  )).get(teamId, auth.userId);
  if (membership?.role !== "admin") return false;
  const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
    operation: "plan-transition", teamId, teamRole: "admin", productKey,
  }));
  return decision?.allow === true;
}

async function actorForOperation(transaction: LooseRecord, operationId: any) {
  if (typeof operationId !== "string") return null;
  return (await transaction.prepare(transaction.dialect.sql(
    "SELECT [actorUserId] FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'plan-transition'",
  )).get(operationId))?.actorUserId ?? null;
}

async function targetQuantity(transaction: LooseRecord, teamId: string, product: LooseRecord) {
  return product.quantity.kind === "team-members"
    ? countAcceptedTeamMembers(transaction, teamId, denied)
    : Number(product.quantity.value);
}

async function currentSubscription(transaction: LooseRecord, teamId: string) {
  const rows = await transaction.prepare(transaction.dialect.sql(
    "SELECT [teamId], [mode], [providerSubscriptionId], [providerSubscriptionItemId], [providerPriceId], [productKey], [quantity] " +
    "FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [state] IN ('active', 'past-due') AND [terminalLatch] = 0 ORDER BY [id]",
  )).all(teamId);
  if (rows.length !== 1 || !rows[0].providerSubscriptionItemId) throw attentionRequired();
  return rows[0];
}

async function optionalCurrentSubscription(transaction: LooseRecord, teamId: string) {
  try { return await currentSubscription(transaction, teamId); }
  catch { return null; }
}

async function desiredForTeam(transaction: LooseRecord, teamId: string) {
  return transaction.prepare(transaction.dialect.sql(
    "SELECT * FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
  )).get(teamId);
}

async function desiredByIntent(transaction: LooseRecord, intentId: string) {
  return transaction.prepare(transaction.dialect.sql(
    "SELECT * FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?",
  )).get(intentId);
}

async function ensureLane(transaction: LooseRecord, teamId: string, database: LooseRecord) {
  const existing = await transaction.prepare(transaction.dialect.sql(
    "SELECT [teamId] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
  )).get(teamId);
  if (!existing) await transaction.prepare(transaction.dialect.sql(
    "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?)",
  )).run(teamId, nowIso(database));
}

async function claimLane(transaction: LooseRecord, teamId: string, token: string, database: LooseRecord) {
  await ensureLane(transaction, teamId, database);
  const now = nowIso(database);
  const expiresAt = new Date(database.clock.now().getTime() + CLAIM_TTL_MS).toISOString();
  const result = await transaction.prepare(transaction.dialect.sql(
    "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? " +
    "WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)",
  )).run(token, expiresAt, now, teamId, now);
  return Number(result?.changes ?? result?.changesCount ?? 0) === 1;
}

async function releaseLane(transaction: LooseRecord, teamId: string, token: string, database: LooseRecord) {
  await transaction.prepare(transaction.dialect.sql(
    "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?",
  )).run(nowIso(database), teamId, token);
}

async function releaseAfterFailure(database: LooseRecord, desired: LooseRecord, token: string, classified: LooseRecord) {
  await inTransaction(database, async (transaction) => {
    await releaseLane(transaction, desired.teamId, token, database);
    const current = await desiredByIntent(transaction, desired.intentId);
    if (!current) return;
    const updated = await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_desired_state] SET [status] = ?, [safeFailureCode] = ?, [updatedAt] = ? " +
      "WHERE [intentId] = ? AND [activeJobGenerationId] = ?",
    )).run(classified.retryable ? "queued" : "failed", classified.code, nowIso(database), desired.intentId, desired.activeJobGenerationId);
    if (!classified.retryable && Number(updated?.changes ?? updated?.changesCount ?? 0) === 1 && current.operationId) await transaction.prepare(transaction.dialect.sql(
      "UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ?",
    )).run(classified.code, nowIso(database), current.operationId);
  });
}

async function attention(transaction: LooseRecord, database: LooseRecord, desired: LooseRecord, code: string, deniedResult = false) {
  const updatedAt = nowIso(database);
  await transaction.prepare(transaction.dialect.sql(
    "UPDATE [sporades_team_billing_desired_state] SET [status] = 'attention-required', [safeFailureCode] = ?, [updatedAt] = ? WHERE [intentId] = ?",
  )).run(code, updatedAt, desired.intentId);
  if (desired.operationId) await transaction.prepare(transaction.dialect.sql(
    "UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ?",
  )).run(code, updatedAt, desired.operationId);
  return deniedResult ? { denied: true } : { superseded: true };
}

function classifyProviderError(database: LooseRecord, error: any) {
  const classified = database.classifyTeamBillingProviderError?.(error);
  return { retryable: classified?.retryable ?? error?.retryable === true, code: safeCode(classified?.code ?? error?.code ?? "PROVIDER_REJECTED") };
}

function modeBinding(database: LooseRecord, product: LooseRecord) {
  return product.stripe[database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox"];
}

function assertCurrentModeAndCatalogue(database: LooseRecord, subscription: LooseRecord, product: LooseRecord) {
  const mode = database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox";
  if (!product || subscription.mode !== mode || product.stripe?.[mode]?.priceId !== subscription.providerPriceId) throw attentionRequired();
}

function sameQuantityPolicy(left: LooseRecord, right: LooseRecord) {
  return left?.kind === right?.kind && (left?.kind !== "fixed" || left.value === right.value);
}

function intentIdempotency(database: LooseRecord, teamId: string, intentId: string) {
  return `sporades-team-billing-${createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0${teamId}\0${intentId}`).digest("hex")}`;
}

function operationIdempotency(database: LooseRecord, operationId: string) {
  return `sporades-team-billing-operation-${createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0${operationId}`).digest("hex")}`;
}

async function inTransaction(database: LooseRecord, callback: (transaction: LooseRecord) => Promise<any>) {
  if (database.__transactionActive || typeof database.adapter?.withTransaction !== "function") return callback(database.adapter);
  return database.adapter.withTransaction(callback);
}

function nowIso(database: LooseRecord) {
  return database.clock.now().toISOString();
}

function nowSeconds(database: LooseRecord) {
  return Math.floor(database.clock.now().getTime() / 1_000);
}

function scheduleAfterOwnedTransaction(database: LooseRecord) {
  if (database.__transactionActive) {
    (database.__rootDatabase ?? database).__teamBillingDispatchPending = true;
    return;
  }
  database.scheduleTeamBillingJobDispatch?.();
}

function safeCode(value: any) {
  const text = String(value ?? "PROVIDER_REJECTED").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return text || "PROVIDER_REJECTED";
}

function validProviderAcknowledgement(value: any) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "ok\0outcome"
    && value.ok === true && ["acknowledged", "payment-action-required"].includes(value.outcome);
}

function planOperationResult(teamId: string, requestId: string, productKey: string, operation: LooseRecord) {
  if (operation.status === "completed" || operation.status === "superseded") {
    return Object.freeze({ state: operation.status, teamId, requestId, productKey });
  }
  if (operation.status === "failed") {
    const reason = operation.safeFailureCode === "AUTHORITY_CHANGED" ? "authority-changed"
      : operation.safeFailureCode === "PAYMENT_ACTION_REQUIRED" ? "payment-action-required"
        : ["PROVIDER_STATE_AMBIGUOUS", "CATALOGUE_MISMATCH", "PROVIDER_DRIFT"].includes(operation.safeFailureCode)
          ? "provider-state-ambiguous" : "unavailable";
    return Object.freeze({ state: "failed" as const, teamId, requestId, productKey, reason });
  }
  return Object.freeze({ state: "pending" as const, teamId, requestId, productKey, requestedAt: operation.createdAt });
}

function coded(message: string, code: string, retry = false) {
  return Object.assign(new Error(message), { code, ...(retry ? { retryable: true } : {}) });
}

function denied() { return coded("Team Billing plan transition denied.", "TEAM_BILLING_DENIED"); }
function conflict() { return coded("The Team Billing request conflicts with an existing request.", "TEAM_BILLING_REQUEST_CONFLICT"); }
function transitionNotRequired() { return coded("This Plan transition does not require managed quantity policy work.", "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED"); }
function attentionRequired() { return coded("Team Billing provider state requires attention.", "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS"); }
function retryable(code: string) { return coded("Team Billing provider work should be retried.", code, true); }
