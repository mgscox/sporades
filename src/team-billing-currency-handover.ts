// A currency replacement owns its paid-through entitlement independently of
// either Subscription, so an uncertain cancel/create can recover after restart.
import { randomUUID } from "node:crypto";
import { admitTeamBillingActor, assertTeamBillingErasureInactive, safeTeamBillingProjection, teamBillingPrice, teamBillingPriceById } from "./team-billing-runtime.js";
import { billingCurrencyAmount, validBillingCurrency, matchesBillingCurrency } from "./team-billing-prices.js";
import { readTeamBillingQuantity } from "./team-billing-quantity.js";
import { lockTeamLifecycle } from "./teams-runtime.js";

type Obj = Record<string, any>;
export const TEAM_BILLING_CURRENCY_HANDOVER_JOB = "_sporades.team-billing-currency-handover";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const active = ["queued", "running", "retrying", "ready", "awaiting-observation"];
const now = (db: Obj) => db.clock.now().toISOString();
function failure(code = "TEAM_BILLING_DENIED", retryable = false) {
  return Object.assign(new Error("Team currency handover is unavailable."), { code, retryable });
}

export async function assertCurrencyHandoverInactive(tx: Obj, teamId: string) {
  const row = await tx.prepare(tx.dialect.sql(
    "SELECT [o].[id] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [h].[operationId] = [o].[id] WHERE [o].[teamId] = ? AND [o].[kind] = 'currency-handover' " +
    "AND ([o].[status] IN ('queued', 'running', 'retrying', 'ready', 'awaiting-observation') OR ([h].[cancelDispatched] = 1 AND [h].[phase] NOT IN ('completed', 'closed')))",
  )).get(teamId);
  if (row) throw failure("TEAM_BILLING_CURRENCY_HANDOVER_ACTIVE");
}

export async function startTeamBillingCurrencyHandover(db: Obj, auth: Obj, input: Obj) {
  const { teamId, requestId, productKey, interval, currency } = input ?? {};
  const mode = db.paymentsConfig?.stripe?.livemode ? "live" : "sandbox";
  const product = db.teamBillingDefinition?.catalogue?.[productKey];
  const price = teamBillingPrice(product?.stripe?.[mode], interval);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["teamId", "requestId", "productKey", "interval", "currency"].includes(key))
    || !db.paymentsConfig?.stripe?.enabled || !db.teamBillingDefinition?.checkout
    || !UUID.test(String(teamId)) || !UUID.test(String(requestId)) || !price
    || !validBillingCurrency(currency) || billingCurrencyAmount(price, currency) === undefined) throw failure();
  const result = await db.adapter.withTransaction(async (tx: Obj) => {
    await admit(db, tx, auth, { teamId, requestId, productKey, interval: price.interval, currency });
    await assertTeamBillingErasureInactive(db, tx, teamId);
    const repeated = await operation(tx, teamId, requestId);
    if (repeated) {
      if (repeated.kind !== "currency-handover" || repeated.productKey !== productKey
        || repeated.providerPriceId !== price.priceId || repeated.currency !== currency) throw failure("TEAM_BILLING_REQUEST_CONFLICT");
      return resultFor(db, repeated);
    }
    await assertCurrencyHandoverInactive(tx, teamId);
    const projection = await safeTeamBillingProjection(tx, db.teamBillingDefinition, teamId, db.clock.now());
    if (projection.state !== "active" || !projection.currency || projection.currency === currency) throw failure("TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS");
    const source = await tx.prepare(tx.dialect.sql(
      "SELECT * FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [state] = 'active' AND [terminalLatch] = 0 AND [replacedBy] IS NULL",
    )).get(teamId);
    if (!source || source.hasSchedule === 1 || source.cancelAtPeriodEnd !== 0 || source.mode !== mode
      || !Number.isFinite(Date.parse(source.currentPeriodEnd)) || source.currentPeriodEnd <= now(db)) throw failure("TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS");
    const busy = await tx.prepare(tx.dialect.sql(
      "SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [status] IN ('queued', 'running', 'retrying', 'ready', 'awaiting-observation')",
    )).get(teamId);
    if (busy) throw failure("TEAM_BILLING_CURRENCY_HANDOVER_ACTIVE");
    const quantity = await readTeamBillingQuantity(db, tx, teamId, product.quantity);
    if (product.quantity.maximum !== undefined && quantity > product.quantity.maximum) throw failure();
    const customer = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).get(teamId);
    if (!customer || customer.mode !== mode) throw failure();
    const id = randomUUID(); const createdAt = now(db);
    await tx.prepare(tx.dialect.sql(
      "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [currency], [status], [idempotencyKey], [createdAt], [updatedAt], [mode], [quantity], [providerPriceId], [providerCustomerId], [providerExpiresAt]) " +
      "VALUES (?, ?, ?, ?, 'currency-handover', ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
    )).run(id, requestId, teamId, auth.userId, productKey, currency, `sporades-currency-${id}`, createdAt, createdAt, mode, quantity, price.priceId, customer.providerCustomerId, Math.floor(db.clock.now().getTime() / 1000) + 23 * 3600);
    await tx.prepare(tx.dialect.sql(
      "INSERT INTO [sporades_team_billing_handovers] ([operationId], [teamId], [sourceSubscriptionId], [sourceSnapshot], [anchor], [phase]) VALUES (?, ?, ?, ?, ?, 'setup')",
    )).run(id, teamId, source.providerSubscriptionId, JSON.stringify(source), source.currentPeriodEnd);
    await enqueue(db, tx, id, "setup");
    return resultFor(db, await operation(tx, teamId, requestId));
  });
  db.scheduleTeamBillingJobDispatch?.();
  return result;
}

async function admit(db: Obj, tx: Obj, auth: Obj, input: Obj) {
  await lockTeamLifecycle(tx, input.teamId, failure);
  const handover = await tx.prepare(tx.dialect.sql("SELECT [h].[sourceSnapshot] FROM [sporades_team_billing_handovers] [h] JOIN [sporades_team_billing_operations] [o] ON [o].[id] = [h].[operationId] WHERE [h].[teamId] = ? AND [o].[requestId] = ?")).get(input.teamId, input.requestId ?? "");
  const source = handover ? JSON.parse(handover.sourceSnapshot) : await tx.prepare(tx.dialect.sql("SELECT [productKey], [interval], [currency] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [replacedBy] IS NULL AND [state] = 'active'")).get(input.teamId);
  await admitTeamBillingActor(db, tx, auth, { ...input, operation: "currency-handover", fromCurrency: input.fromCurrency ?? source?.currency, fromProductKey: input.fromProductKey ?? source?.productKey, fromInterval: input.fromInterval ?? source?.interval });
}

export async function performTeamBillingCurrencyHandover(db: Obj, context: Obj, payload: Obj, attempt = 1) {
  if (!payload || !UUID.test(String(payload.operationId)) || !["setup", "replace", "expire", "deadline"].includes(payload.phase)) throw failure();
  if (payload.phase === "deadline") return reconcileExpiredHandover(db, context, payload.operationId);
  if (payload.phase === "expire") {
    await db.adapter.withTransaction(async (tx: Obj) => {
      const row = await tx.prepare(tx.dialect.sql("SELECT [o].*, [h].[anchor] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [h].[operationId] = [o].[id] WHERE [o].[id] = ?")).get(payload.operationId);
      if (!row) return;
      await lockTeamLifecycle(tx, row.teamId, failure);
      if (row.status !== "ready" || row.continuationExpiresAt > now(db)) return;
      await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = ?, [safeFailureCode] = ?, [continuationUrl] = NULL, [continuationExpiresAt] = NULL WHERE [id] = ? AND [status] = 'ready' AND [continuationExpiresAt] <= ?")).run("expired", null, row.id, now(db));
    });
    return null;
  }
  let snapshot: Obj | null = null;
  let claimed = false;
  const token = randomUUID();
  try {
    snapshot = await db.adapter.withTransaction(async (tx: Obj) => {
      const row = await tx.prepare(tx.dialect.sql(
        "SELECT [o].*, [h].[sourceSnapshot], [h].[sourceSubscriptionId], [h].[anchor], [h].[phase], [h].[latchUntil], [h].[cancelDispatched], [h].[setupSessionId] " +
        "FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [o].[id] = [h].[operationId] WHERE [o].[id] = ?",
      )).get(payload.operationId);
      if (!row || !active.includes(row.status) || (payload.phase === "setup" ? row.phase !== "setup" || row.status === "ready" : row.phase !== "replace")) return null;
      snapshot = row;
      await lockTeamLifecycle(tx, row.teamId, failure);
      const current = await tx.prepare(tx.dialect.sql("SELECT [o].[status], [h].[phase], [h].[cancelDispatched] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [h].[operationId] = [o].[id] WHERE [o].[id] = ?")).get(row.id);
      if (!current || !active.includes(current.status) || (payload.phase === "setup" ? current.phase !== "setup" || current.status === "ready" : current.phase !== "replace")) return null;
      Object.assign(row, current);
      const source = JSON.parse(row.sourceSnapshot);
      const price = teamBillingPriceById(db.teamBillingDefinition?.catalogue?.[row.productKey]?.stripe?.[row.mode], row.providerPriceId);
      if (!price || billingCurrencyAmount(price, row.currency) === undefined
        || (row.mode === "live") !== Boolean(db.paymentsConfig?.stripe?.livemode)) throw failure("TEAM_BILLING_CONFIGURATION_INVALID");
      const auth = await db.readTeamBillingActorAuth(tx, row.actorUserId);
      await admit(db, tx, auth, { teamId: row.teamId, productKey: row.productKey, interval: price.interval, currency: row.currency,
        fromCurrency: source.currency, fromProductKey: source.productKey, fromInterval: source.interval });
      await assertTeamBillingErasureInactive(db, tx, row.teamId);
      if (row.anchor <= now(db)) throw failure("TEAM_BILLING_HANDOVER_EXPIRED");
      const quantity = await readTeamBillingQuantity(db, tx, row.teamId, db.teamBillingDefinition.catalogue[row.productKey].quantity);
      const maximum = db.teamBillingDefinition.catalogue[row.productKey].quantity.maximum;
      if (quantity !== row.quantity || maximum !== undefined && quantity > maximum) throw failure("TEAM_BILLING_CONFIGURATION_INVALID");
      await tx.prepare(tx.dialect.sql(
        "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?) ON CONFLICT DO NOTHING",
      )).run(row.teamId, now(db));
      const claimed = await tx.prepare(tx.dialect.sql(
        "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)",
      )).run(token, new Date(db.clock.now().getTime() + 300_000).toISOString(), now(db), row.teamId, now(db));
      if (Number(claimed.changes ?? claimed.changesCount) !== 1) throw failure("TEAM_BILLING_PROVIDER_LANE_BUSY", true);
      await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'running', [attemptedAt] = COALESCE([attemptedAt], ?) WHERE [id] = ?")).run(now(db), row.id);
      await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [attemptToken] = ? WHERE [operationId] = ?")).run(token, row.id);
      if (payload.phase === "replace") await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [cancelDispatched] = 1 WHERE [operationId] = ?")).run(row.id);
      return { ...row, source, price };
    });
    if (!snapshot) return null;
    claimed = true;
    const provider = db.createStripeTeamBillingProvider({ config: db.paymentsConfig.stripe, env: db.serverEnv, signal: context?.signal,
      ...(db.stripeApiBaseUrl ? { apiBaseUrl: db.stripeApiBaseUrl } : {}) });
    const common = { operationId: snapshot.id, customerId: snapshot.providerCustomerId, sourceSubscriptionId: snapshot.sourceSubscriptionId,
      sourcePriceId: snapshot.source.providerPriceId, sourceItemId: snapshot.source.providerSubscriptionItemId, sourceCurrency: snapshot.source.currency,
      sourceQuantity: snapshot.source.quantity, anchor: Date.parse(snapshot.anchor) / 1000, currency: snapshot.currency,
      priceId: snapshot.providerPriceId, quantity: snapshot.quantity, idempotencyKey: snapshot.idempotencyKey };
    const result = payload.phase === "setup"
      ? await provider.createCurrencySetup({ ...common, successPath: db.teamBillingDefinition.checkout.successPath,
        cancelPath: db.teamBillingDefinition.checkout.cancelPath, providerExpiresAt: snapshot.providerExpiresAt })
      : await provider.replaceCurrencySubscription({ ...common, setupSessionId: snapshot.setupSessionId });
    await db.adapter.withTransaction(async (tx: Obj) => {
      const owned = await release(db, tx, snapshot!.teamId, token);
      if (!owned) throw failure("TEAM_BILLING_PROVIDER_LANE_BUSY", true);
      if (payload.phase === "setup") {
        const expiresAt = new Date(Math.min(snapshot!.providerExpiresAt * 1000, db.clock.now().getTime() + db.teamBillingDefinition.checkout.continuationTtlSeconds * 1000)).toISOString();
        await tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_billing_operations] SET [status] = 'ready', [providerObjectId] = ?, [continuationUrl] = ?, [continuationExpiresAt] = ?, [updatedAt] = ? WHERE [id] = ? AND [status] = 'running'",
        )).run(result.sessionId, result.url, expiresAt, now(db), snapshot!.id);
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [setupSessionId] = ? WHERE [operationId] = ? AND [phase] = 'setup'")).run(result.sessionId, snapshot!.id);
        await enqueue(db, tx, snapshot!.id, "expire", "expire", expiresAt);
      } else {
        await tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_billing_operations] SET [status] = 'awaiting-observation', [providerSubscriptionId] = ?, [updatedAt] = ? WHERE [id] = ? AND [status] = 'running'",
        )).run(result.subscriptionId, now(db), snapshot!.id);
      }
    });
    return { acknowledged: true };
  } catch (error: any) {
    await db.adapter.withTransaction(async (tx: Obj) => {
      if (snapshot) {
        await lockTeamLifecycle(tx, snapshot.teamId, failure);
        const handover = await tx.prepare(tx.dialect.sql("SELECT [attemptToken] FROM [sporades_team_billing_handovers] WHERE [operationId] = ?")).get(snapshot.id);
        if (claimed && handover?.attemptToken !== token) return;
        const released = await release(db, tx, snapshot.teamId, token);
        if (!released && error?.code !== "TEAM_BILLING_PROVIDER_LANE_BUSY") {
          const owner = await tx.prepare(tx.dialect.sql("SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?")).get(snapshot.teamId);
          if (owner?.claimToken && owner.claimExpiresAt > now(db)) return;
        }
      }
      // A competing worker owns the durable operation; it must retain its state.
      if (error?.code === "TEAM_BILLING_PROVIDER_LANE_BUSY" && snapshot) {
        const lane = await tx.prepare(tx.dialect.sql("SELECT [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?")).get(snapshot.teamId);
        await enqueue(db, tx, payload.operationId, payload.phase, randomUUID(), lane?.claimExpiresAt > now(db) ? lane.claimExpiresAt : now(db));
        return;
      }
      if (error?.handoverUntouched === true && snapshot?.cancelDispatched === 0) await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [latchUntil] = NULL, [cancelDispatched] = 0 WHERE [operationId] = ?")).run(payload.operationId);
      const retry = error?.retryable === true && attempt < 4;
      const code = error?.code === "TEAM_BILLING_DENIED" ? "AUTHORITY_CHANGED"
        : error?.code === "TEAM_BILLING_CUSTOMER_BALANCE_NONZERO" ? "CUSTOMER_BALANCE_NONZERO" : "UNAVAILABLE";
      await tx.prepare(tx.dialect.sql(
        "UPDATE [sporades_team_billing_operations] SET [status] = ?, [safeFailureCode] = ?, [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [id] = ? AND [status] IN ('queued', 'running', 'retrying')",
      )).run(retry ? "retrying" : "failed", code, now(db), payload.operationId);
    });
    if (error?.code === "TEAM_BILLING_PROVIDER_LANE_BUSY") return { deferred: true };
    throw error;
  }
}

/** Called only inside the verified-event atomic fence, after envelope validation. */
export async function applyCurrencySetup(db: Obj, event: Obj, mode: string) {
  const tx = db.adapter; const object = event.raw.data.object;
  const row = await tx.prepare(tx.dialect.sql(
    "SELECT [o].*, [h].[anchor], [h].[phase], [h].[sourceSnapshot], [h].[setupSessionId] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [o].[id] = [h].[operationId] WHERE [o].[id] = ? AND [o].[kind] = 'currency-handover'",
  )).get(object.client_reference_id);
  if (!row || row.mode !== mode || object.object !== "checkout.session" || object.mode !== "setup" || object.livemode !== event.livemode
    || object.metadata?.sporades_team_billing_operation !== row.id || object.customer !== row.providerCustomerId
    || !/^cs_(test|live)_[A-Za-z0-9_]{1,240}$/.test(String(object.id))
    || row.providerObjectId && object.id !== row.providerObjectId || row.setupSessionId && object.id !== row.setupSessionId) return null;
  await lockTeamLifecycle(tx, row.teamId, failure);
  // Local expiry, erasure and fresh requests use this same lifecycle lock.
  // Re-read after acquiring it so a waiting observation cannot revive old work.
  const current = await tx.prepare(tx.dialect.sql("SELECT [status] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(row.id);
  if (row.phase !== "setup" || !active.includes(current?.status)) return { teamId: row.teamId, objectId: object.id, rank: 10, outcome: "ignored" };
  const completed = event.type === "checkout.session.completed";
  if (completed ? object.status !== "complete" || !/^seti_[A-Za-z0-9_]{1,240}$/.test(String(object.setup_intent)) : object.status !== "expired") return null;
  const source = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = (SELECT [sourceSubscriptionId] FROM [sporades_team_billing_handovers] WHERE [operationId] = ?)")).get(row.id);
  const admitted = JSON.parse(row.sourceSnapshot);
  const sameSource = source && ["providerPriceId", "productKey", "currency", "unitAmount", "quantity", "providerSubscriptionItemId", "interval"].every(key => source[key] === admitted[key]);
  if (completed && sameSource && row.anchor > now(db) && source?.state === "active" && source.terminalLatch === 0
    && source.cancelAtPeriodEnd === 0 && source.hasSchedule !== 1 && source.currentPeriodEnd === row.anchor) {
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [phase] = 'replace', [setupSessionId] = ?, [latchUntil] = [anchor] WHERE [operationId] = ?")).run(object.id, row.id);
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'queued', [providerObjectId] = ?, [continuationUrl] = NULL, [continuationExpiresAt] = NULL WHERE [id] = ?")).run(object.id, row.id);
    await enqueue(db, tx, row.id, "replace");
    await enqueue(db, tx, row.id, "deadline", "deadline", row.anchor);
  } else {
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL WHERE [id] = ?")).run(row.id);
  }
  return { teamId: row.teamId, objectId: object.id, rank: 10, outcome: "applied" };
}

export async function readCurrencyHandoverLatch(tx: Obj, definition: Obj, teamId: string, clock: Date) {
  const rows = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_team_billing_handovers] WHERE [teamId] = ? AND [latchUntil] IS NOT NULL AND [phase] <> 'completed' ORDER BY [anchor] DESC")).all(teamId);
  const latch = rows.find((r: Obj) => r.latchUntil > clock.toISOString());
  if (!latch) return null;
  let source: Obj; try { source = JSON.parse(latch.sourceSnapshot); } catch { return null; }
  const product = definition.catalogue[source.productKey];
  const price = teamBillingPriceById(product?.stripe?.[source.mode], source.providerPriceId);
  if (!price || !matchesBillingCurrency(price, source.currency, source.unitAmount)
    || !Number.isSafeInteger(source.quantity) || source.quantity < 1
    || product.quantity.kind === "fixed" && source.quantity !== product.quantity.value
    || price.interval && price.interval !== source.interval) return null;
  return Object.freeze({ state: "active" as const, teamId, productKey: source.productKey, quantity: source.quantity,
    currency: source.currency, ...(source.interval ? { interval: source.interval } : {}), renewsAt: latch.latchUntil });
}

export async function repairTeamBillingCurrencyHandovers(db: Obj) {
  await db.adapter.withTransaction(async (tx: Obj) => {
    const rows = await tx.prepare(tx.dialect.sql(
      "SELECT [o].*, [h].[phase], [h].[anchor] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [h].[operationId] = [o].[id] WHERE [o].[kind] = 'currency-handover' AND ([o].[status] IN ('queued', 'running', 'retrying', 'awaiting-observation') OR ([o].[status] = 'failed' AND [h].[cancelDispatched] = 1 AND [h].[phase] NOT IN ('closed', 'completed')))",
    )).all();
    for (const row of rows) {
      await lockTeamLifecycle(tx, row.teamId, failure);
      if (row.anchor <= now(db)) {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = 'UNAVAILABLE' WHERE [id] = ?")).run(row.id);
        await enqueue(db, tx, row.id, "deadline", randomUUID());
      } else {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'queued' WHERE [id] = ?")).run(row.id);
        await enqueue(db, tx, row.id, row.phase === "setup" ? "setup" : "replace", randomUUID());
      }
    }
  });
}

async function enqueue(db: Obj, tx: Obj, operationId: string, phase: string, generation = phase, availableAt?: string) {
  await db.enqueueTeamBillingCurrencyHandoverJob(tx, { operationId, phase }, `currency-handover:${operationId}:${generation}`, availableAt);
}
async function operation(tx: Obj, teamId: string, requestId: string) {
  return tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
}
async function release(db: Obj, tx: Obj, teamId: string, token: string) {
  const result = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?")).run(now(db), teamId, token);
  return Number(result.changes ?? result.changesCount) === 1;
}
function resultFor(db: Obj, row: Obj) {
  const common = { teamId: row.teamId, requestId: row.requestId, productKey: row.productKey };
  if (row.status === "completed") return Object.freeze({ state: "completed" as const, ...common });
  if (row.status === "expired" || row.status === "superseded" || row.status === "ready" && row.continuationExpiresAt <= now(db)) return Object.freeze({ state: "expired" as const, ...common });
  if (row.status === "ready") return Object.freeze({ state: "ready" as const, ...common, url: row.continuationUrl, expiresAt: row.continuationExpiresAt });
  if (row.status === "failed") return Object.freeze({ state: "failed" as const, ...common, reason: row.safeFailureCode === "CUSTOMER_BALANCE_NONZERO" ? "customer-balance-nonzero" : row.safeFailureCode === "AUTHORITY_CHANGED" ? "authority-changed" : "unavailable" });
  return Object.freeze({ state: "pending" as const, ...common, requestedAt: row.createdAt });
}


async function reconcileExpiredHandover(db: Obj, context: Obj, operationId: string) {
  const token = randomUUID();
  const snapshot = await db.adapter.withTransaction(async (tx: Obj) => {
    const row = await tx.prepare(tx.dialect.sql("SELECT [o].*, [h].[anchor], [h].[phase], [h].[sourceSubscriptionId], [h].[cancelDispatched] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_handovers] [h] ON [h].[operationId] = [o].[id] WHERE [o].[id] = ?")).get(operationId);
    if (!row || row.anchor > now(db) || ["completed", "closed"].includes(row.phase)) return null;
    await lockTeamLifecycle(tx, row.teamId, failure);
    await assertTeamBillingErasureInactive(db, tx, row.teamId);
    const claimed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(token, new Date(db.clock.now().getTime() + 300_000).toISOString(), now(db), row.teamId, now(db));
    if (Number(claimed.changes ?? claimed.changesCount) !== 1) {
      const lane = await tx.prepare(tx.dialect.sql("SELECT [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?")).get(row.teamId);
      await enqueue(db, tx, row.id, "deadline", randomUUID(), lane.claimExpiresAt);
      return null;
    }
    return row;
  });
  if (!snapshot) return null;
  try {
    const provider = db.createStripeTeamBillingProvider({ config: db.paymentsConfig.stripe, env: db.serverEnv, signal: context?.signal,
      ...(db.stripeApiBaseUrl ? { apiBaseUrl: db.stripeApiBaseUrl } : {}) });
    const evidence = await provider.reconcileCurrencyHandover({ customerId: snapshot.providerCustomerId, operationId, sourceSubscriptionId: snapshot.sourceSubscriptionId });
    await db.adapter.withTransaction(async (tx: Obj) => {
      if (!await release(db, tx, snapshot.teamId, token)) return;
      await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = 'UNAVAILABLE', [providerSubscriptionId] = COALESCE(?, [providerSubscriptionId]), [continuationUrl] = NULL, [continuationExpiresAt] = NULL WHERE [id] = ? AND [status] <> 'completed'")).run(evidence.subscriptionId ?? null, operationId);
      if (evidence.closed === true) await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_handovers] SET [phase] = 'closed', [cancelDispatched] = CASE WHEN ? = 1 THEN 0 ELSE [cancelDispatched] END, [latchUntil] = CASE WHEN ? = 1 THEN NULL ELSE [latchUntil] END WHERE [operationId] = ? AND [phase] <> 'completed'")).run(evidence.sourceUncancelled ? 1 : 0, evidence.sourceUncancelled ? 1 : 0, operationId);
    });
  } catch (error) {
    await db.adapter.withTransaction((tx: Obj) => release(db, tx, snapshot.teamId, token));
    throw error;
  }
  return null;
}
