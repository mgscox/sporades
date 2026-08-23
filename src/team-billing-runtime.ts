// Headless Team Billing control-plane foundation. Provider identifiers and
// replay correlation stay in runtime-owned tables; Capsule code receives only
// declared product keys and closed, provider-free projections.
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";

type LooseRecord = Record<string, any>;

export const TEAM_BILLING_PRODUCT_MAX = 32;
const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/;
const FIXED_QUANTITY_MAX = 1_000_000;
const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTeamBillingTables(adapter: LooseRecord) {
  const sql = adapter.dialect.sql;
  return chainMaybePromise([
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_billing_customers] (" +
      "[teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, " +
      "[createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_billing_subscriptions] (" +
      "[id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, " +
      "[providerPriceId] TEXT NOT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, " +
      "[cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_billing_operations] (" +
      "[id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, " +
      "[kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, " +
      "[idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, " +
      "UNIQUE ([teamId], [requestId])" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_billing_observations] (" +
      "[id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, " +
      "[providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_billing_replay] (" +
      "[providerEventId] TEXT PRIMARY KEY, [payloadDigest] TEXT NOT NULL, [settledAt] TEXT NOT NULL, [retainedUntil] TEXT NOT NULL" +
      ")",
    )),
  ]);
}

export function normalizeTeamBillingDefinition(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["catalogue", "authorize"].includes(key))
    || typeof value.authorize !== "function"
    || !value.catalogue || typeof value.catalogue !== "object" || Array.isArray(value.catalogue)) {
    throw invalidDeclaration();
  }
  const entries = Object.entries(value.catalogue);
  if (entries.length === 0 || entries.length > TEAM_BILLING_PRODUCT_MAX) throw invalidDeclaration();
  const sandboxPrices = new Set<string>();
  const livePrices = new Set<string>();
  const catalogue: LooseRecord = {};
  for (const [productKey, product] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!PRODUCT_KEY_PATTERN.test(productKey) || !product || typeof product !== "object" || Array.isArray(product)
      || Object.keys(product as LooseRecord).some((key) => !["quantity", "stripe"].includes(key))) throw invalidDeclaration();
    const quantity = normalizeQuantity((product as LooseRecord).quantity);
    const stripe = (product as LooseRecord).stripe;
    if (!stripe || typeof stripe !== "object" || Array.isArray(stripe)
      || Object.keys(stripe).sort().join(",") !== "live,sandbox") throw invalidDeclaration();
    const sandbox = normalizeModeBinding(stripe.sandbox);
    const live = normalizeModeBinding(stripe.live);
    if (sandbox.priceId === live.priceId || sandboxPrices.has(sandbox.priceId) || livePrices.has(live.priceId)) throw invalidDeclaration();
    sandboxPrices.add(sandbox.priceId);
    livePrices.add(live.priceId);
    catalogue[productKey] = Object.freeze({
      quantity,
      stripe: Object.freeze({ sandbox, live }),
    });
  }
  return Object.freeze({ catalogue: Object.freeze(catalogue), authorize: value.authorize });
}

function normalizeQuantity(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidDeclaration();
  if (value.kind === "team-members" && Object.keys(value).length === 1) return Object.freeze({ kind: "team-members" as const });
  if (value.kind === "fixed" && Object.keys(value).sort().join(",") === "kind,value"
    && Number.isSafeInteger(value.value) && value.value >= 1 && value.value <= FIXED_QUANTITY_MAX) {
    return Object.freeze({ kind: "fixed" as const, value: value.value });
  }
  throw invalidDeclaration();
}

function normalizeModeBinding(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "priceId"
    || typeof value.priceId !== "string" || !PRICE_ID_PATTERN.test(value.priceId)) throw invalidDeclaration();
  return Object.freeze({ priceId: value.priceId });
}

function invalidDeclaration() {
  return commandError(
    "Invalid Team Billing declaration.",
    "Declare 1-32 lowercase products with exact sandbox/live Stripe Price bindings, a fixed or Team-member quantity policy, and an authorize policy.",
    "INVALID_TEAM_BILLING_DECLARATION",
  );
}

export async function readCurrentUserTeamBilling(database: LooseRecord, auth: LooseRecord, teamId: any) {
  requireAuth({ auth }, { linked: true });
  if (!database.teamBillingDefinition || !TEAM_ID_PATTERN.test(String(teamId ?? ""))) throw teamBillingDenied();
  return database.adapter.withTransaction(async (transaction: LooseRecord) => {
    await admitTeamBillingActor(database, transaction, auth, { operation: "read", teamId });
    return safeTeamBillingProjection(transaction, database.teamBillingDefinition, teamId);
  });
}

/**
 * Reusable last-moment admission for provider-facing Team Billing operations.
 * It deliberately returns no capability: callers must invoke it in the same
 * transaction immediately before persisting provider work.
 */
export async function admitTeamBillingActor(database: LooseRecord, transaction: LooseRecord, auth: LooseRecord, input: LooseRecord) {
  requireAuth({ auth }, { linked: true });
  const sql = transaction.dialect.sql;
  const membership = await transaction.prepare(sql(
    "SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
  )).get(input.teamId, auth.userId);
  if (membership?.role !== "admin") throw teamBillingDenied();
  const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
    operation: input.operation,
    teamId: input.teamId,
    teamRole: "admin",
    ...(input.productKey === undefined ? {} : { productKey: input.productKey }),
  }));
  if (!decision || typeof decision !== "object" || Array.isArray(decision)
    || Object.keys(decision).join(",") !== "allow" || decision.allow !== true) throw teamBillingDenied();
  return Object.freeze({ admitted: true as const });
}

async function safeTeamBillingProjection(transaction: LooseRecord, definition: LooseRecord, teamId: string) {
  const sql = transaction.dialect.sql;
  const operation = await transaction.prepare(sql(
    "SELECT [kind], [productKey], [createdAt] FROM [sporades_team_billing_operations] " +
    "WHERE [teamId] = ? AND [status] IN ('queued', 'running', 'retrying') ORDER BY [createdAt] DESC, [id] DESC LIMIT 1",
  )).get(teamId);
  if (operation) {
    const kind = ["checkout", "plan-transition", "erasure"].includes(operation.kind) ? operation.kind : "reconciliation";
    return Object.freeze({
      state: "pending" as const,
      teamId,
      operation: kind,
      ...(typeof operation.productKey === "string" && definition.catalogue[operation.productKey]
        ? { productKey: operation.productKey } : {}),
      requestedAt: operation.createdAt,
    });
  }
  const row = await transaction.prepare(sql(
    "SELECT [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd] " +
    "FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? ORDER BY [observedAt] DESC, [id] DESC LIMIT 1",
  )).get(teamId);
  if (!row) return Object.freeze({ state: "inactive" as const, teamId });
  if (!definition.catalogue[row.productKey] || !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 1) {
    return Object.freeze({ state: "attention-required" as const, teamId, reason: "catalogue-mismatch" as const });
  }
  const common = { teamId, productKey: row.productKey, quantity: Number(row.quantity) };
  if (row.state === "active" && typeof row.currentPeriodEnd === "string") {
    return Object.freeze(Number(row.cancelAtPeriodEnd) === 1
      ? { state: "cancelling" as const, ...common, endsAt: row.currentPeriodEnd }
      : { state: "active" as const, ...common, renewsAt: row.currentPeriodEnd });
  }
  if (row.state === "past-due") return Object.freeze({ state: "past-due" as const, ...common });
  if (row.state === "cancelled") return Object.freeze({ state: "cancelled" as const, ...common });
  return Object.freeze({ state: "attention-required" as const, teamId, reason: "provider-state-ambiguous" as const });
}

export function teamBillingDenied() {
  return commandError(
    "Team Billing is unavailable.",
    "Sign in as the current policy-approved billing administrator for this Team and retry.",
    "TEAM_BILLING_DENIED",
  );
}
