// Headless Team Billing control-plane foundation. Provider identifiers and
// replay correlation stay in runtime-owned tables; Capsule code receives only
// declared product keys and closed, provider-free projections.
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
export const TEAM_BILLING_PRODUCT_MAX = 32;
const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,249}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const FIXED_QUANTITY_MAX = 1_000_000;
const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createTeamBillingTables(adapter) {
    const sql = adapter.dialect.sql;
    return chainMaybePromise([
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_customers] (" +
            "[teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, " +
            "[createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_subscriptions] (" +
            "[id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, " +
            "[providerPriceId] TEXT NOT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, " +
            "[cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_operations] (" +
            "[id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, " +
            "[kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, " +
            "[idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, " +
            "UNIQUE ([teamId], [requestId])" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_observations] (" +
            "[id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, " +
            "[providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_replay] (" +
            "[providerEventId] TEXT PRIMARY KEY, [payloadDigest] TEXT NOT NULL, [settledAt] TEXT NOT NULL, [retainedUntil] TEXT NOT NULL" +
            ")")),
    ]);
}
export function normalizeTeamBillingDefinition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["catalogue", "authorize"].includes(key))
        || typeof value.authorize !== "function"
        || !value.catalogue || typeof value.catalogue !== "object" || Array.isArray(value.catalogue)) {
        throw invalidDeclaration();
    }
    const entries = Object.entries(value.catalogue);
    if (entries.length === 0 || entries.length > TEAM_BILLING_PRODUCT_MAX)
        throw invalidDeclaration();
    const prices = new Set();
    const catalogue = {};
    for (const [productKey, product] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        if (!PRODUCT_KEY_PATTERN.test(productKey) || !product || typeof product !== "object" || Array.isArray(product)
            || Object.keys(product).some((key) => !["quantity", "stripe"].includes(key)))
            throw invalidDeclaration();
        const quantity = normalizeQuantity(product.quantity);
        const stripe = product.stripe;
        if (!stripe || typeof stripe !== "object" || Array.isArray(stripe)
            || Object.keys(stripe).sort().join(",") !== "live,sandbox")
            throw invalidDeclaration();
        const sandbox = normalizeModeBinding(stripe.sandbox);
        const live = normalizeModeBinding(stripe.live);
        if (prices.has(sandbox.priceId) || prices.has(live.priceId) || sandbox.priceId === live.priceId)
            throw invalidDeclaration();
        prices.add(sandbox.priceId);
        prices.add(live.priceId);
        catalogue[productKey] = Object.freeze({
            quantity,
            stripe: Object.freeze({ sandbox, live }),
        });
    }
    return Object.freeze({ catalogue: Object.freeze(catalogue), authorize: value.authorize });
}
function normalizeQuantity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalidDeclaration();
    if (value.kind === "team-members" && Object.keys(value).length === 1)
        return Object.freeze({ kind: "team-members" });
    if (value.kind === "fixed" && Object.keys(value).sort().join(",") === "kind,value"
        && Number.isSafeInteger(value.value) && value.value >= 1 && value.value <= FIXED_QUANTITY_MAX) {
        return Object.freeze({ kind: "fixed", value: value.value });
    }
    throw invalidDeclaration();
}
function normalizeModeBinding(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "priceId"
        || typeof value.priceId !== "string" || !PRICE_ID_PATTERN.test(value.priceId))
        throw invalidDeclaration();
    return Object.freeze({ priceId: value.priceId });
}
function invalidDeclaration() {
    return commandError("Invalid Team Billing declaration.", "Declare 1-32 lowercase products with exact sandbox/live Stripe Price bindings, a fixed or Team-member quantity policy, and an authorize policy.", "INVALID_TEAM_BILLING_DECLARATION");
}
export async function readCurrentUserTeamBilling(database, auth, teamId) {
    requireAuth({ auth }, { linked: true });
    if (!database.teamBillingDefinition || !TEAM_ID_PATTERN.test(String(teamId ?? "")))
        throw teamBillingDenied();
    return database.adapter.withTransaction(async (transaction) => {
        await admitTeamBillingActor(database, transaction, auth, { operation: "read", teamId });
        return safeTeamBillingProjection(transaction, database.teamBillingDefinition, teamId);
    });
}
/**
 * Reusable last-moment admission for provider-facing Team Billing operations.
 * It deliberately returns no capability: callers must invoke it in the same
 * transaction immediately before persisting provider work.
 */
export async function admitTeamBillingActor(database, transaction, auth, input) {
    requireAuth({ auth }, { linked: true });
    const sql = transaction.dialect.sql;
    const membership = await transaction.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(input.teamId, auth.userId);
    if (membership?.role !== "admin")
        throw teamBillingDenied();
    const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
        operation: input.operation,
        teamId: input.teamId,
        teamRole: "admin",
        ...(input.productKey === undefined ? {} : { productKey: input.productKey }),
    }));
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
        || Object.keys(decision).join(",") !== "allow" || decision.allow !== true)
        throw teamBillingDenied();
    return Object.freeze({ admitted: true });
}
async function safeTeamBillingProjection(transaction, definition, teamId) {
    const sql = transaction.dialect.sql;
    const operation = await transaction.prepare(sql("SELECT [kind], [productKey], [createdAt] FROM [sporades_team_billing_operations] " +
        "WHERE [teamId] = ? AND [status] IN ('queued', 'running', 'retrying') ORDER BY [createdAt] DESC, [id] DESC LIMIT 1")).get(teamId);
    if (operation) {
        const requestedAt = canonicalTimestamp(operation.createdAt);
        if (!requestedAt) {
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        }
        const kind = ["checkout", "plan-transition", "erasure"].includes(operation.kind) ? operation.kind : "reconciliation";
        return Object.freeze({
            state: "pending",
            teamId,
            operation: kind,
            ...(typeof operation.productKey === "string" && definition.catalogue[operation.productKey]
                ? { productKey: operation.productKey } : {}),
            requestedAt,
        });
    }
    const row = await transaction.prepare(sql("SELECT [mode], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd] " +
        "FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? ORDER BY [observedAt] DESC, [id] DESC LIMIT 1")).get(teamId);
    if (!row)
        return Object.freeze({ state: "inactive", teamId });
    const product = definition.catalogue[row.productKey];
    const binding = (row.mode === "sandbox" || row.mode === "live") ? product?.stripe?.[row.mode] : null;
    if (!product || !binding || row.providerPriceId !== binding.priceId
        || !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 1) {
        return Object.freeze({ state: "attention-required", teamId, reason: "catalogue-mismatch" });
    }
    const common = { teamId, productKey: row.productKey, quantity: Number(row.quantity) };
    if (row.state === "active") {
        const currentPeriodEnd = canonicalTimestamp(row.currentPeriodEnd);
        if (!currentPeriodEnd) {
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        }
        return Object.freeze(Number(row.cancelAtPeriodEnd) === 1
            ? { state: "cancelling", ...common, endsAt: currentPeriodEnd }
            : { state: "active", ...common, renewsAt: currentPeriodEnd });
    }
    if (row.state === "past-due")
        return Object.freeze({ state: "past-due", ...common });
    if (row.state === "cancelled")
        return Object.freeze({ state: "cancelled", ...common });
    return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
}
function canonicalTimestamp(value) {
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value))
        return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}
export function teamBillingDenied() {
    return commandError("Team Billing is unavailable.", "Sign in as the current policy-approved billing administrator for this Team and retry.", "TEAM_BILLING_DENIED");
}
//# sourceMappingURL=team-billing-runtime.js.map