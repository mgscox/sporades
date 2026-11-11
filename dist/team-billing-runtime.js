import { normalizeTeamBillingPortalPolicy } from "./team-billing-portal-policy.js";
import { assertCurrencyHandoverInactive, readCurrencyHandoverLatch } from "./team-billing-currency-handover.js";
import { normalizeModeBinding, teamBillingPrice, teamBillingPriceById, teamBillingPrices } from "./team-billing-prices.js";
export { validTeamBillingInterval, teamBillingPrice, teamBillingPriceById, teamBillingPrices } from "./team-billing-prices.js";
import { billingCurrencyAmount, matchesBillingCurrency, validBillingCurrency, billingCurrencyMismatch } from "./team-billing-prices.js";
// Headless Team Billing control-plane foundation. Provider identifiers and
// replay correlation stay in runtime-owned tables; Capsule code receives only
// declared product keys and closed, provider-free projections.
import { createHash, randomUUID } from "node:crypto";
import { teamBillingStoredSubscriptionSemantics } from "./team-billing-subscription-semantics.js";
import { readTeamBillingQuantity, teamBillingQuantityPolicyFingerprint } from "./team-billing-quantity.js";
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
import { applyVerifiedTeamBillingObservation } from "./team-billing-convergence.js";
import { lockTeamLifecycle } from "./teams-runtime.js";
export const TEAM_BILLING_PRODUCT_MAX = 32;
// Shared by queries that inspect in-flight billing writes across operation kinds.
export const TEAM_BILLING_READ_ONLY_KINDS_SQL = "'plan-preview'";
export const TEAM_BILLING_CHECKOUT_JOB = "_sporades.team-billing-checkout";
export const TEAM_BILLING_CHECKOUT_EXPIRY_JOB = "_sporades.team-billing-checkout-expiry";
export const TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS = 4;
export const TEAM_BILLING_PORTAL_JOB = "_sporades.team-billing-portal";
export const TEAM_BILLING_PORTAL_EXPIRY_JOB = "_sporades.team-billing-portal-expiry";
export const TEAM_BILLING_PORTAL_MAX_ATTEMPTS = 4;
const CHECKOUT_CONTINUATION_TTL_DEFAULT_SECONDS = 10 * 60;
const CHECKOUT_CONTINUATION_TTL_MAX_SECONDS = 30 * 60;
const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
// Stripe Checkout accepts quantities through 999999; reject larger trusted
// declarations up front so every admitted policy is executable end to end.
const FIXED_QUANTITY_MAX = 999_999;
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
            "[providerPriceId] TEXT NOT NULL, [interval] TEXT NULL, [currency] TEXT NULL, [unitAmount] INTEGER NULL, [providerSubscriptionItemId] TEXT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, " +
            "[cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodStart] TEXT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, " +
            "[lastEventOccurredAt] TEXT NULL, [lastEventKind] TEXT NULL, [lastEventRank] INTEGER NULL, [terminalLatch] INTEGER NOT NULL DEFAULT 0" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_operations] (" +
            "[id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, " +
            "[kind] TEXT NOT NULL, [productKey] TEXT NULL, [currency] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, " +
            "[idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, " +
            "UNIQUE ([teamId], [requestId])" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_observations] (" +
            "[id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, " +
            "[providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL, " +
            "[eventType] TEXT NULL, [eventRank] INTEGER NULL, [outcome] TEXT NULL, [safeReason] TEXT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_replay] (" +
            "[providerEventId] TEXT PRIMARY KEY, [payloadDigest] TEXT NOT NULL, [settledAt] TEXT NOT NULL, [retainedUntil] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_desired_state] (" +
            "[teamId] TEXT PRIMARY KEY, [intentId] TEXT NOT NULL UNIQUE, [kind] TEXT NOT NULL, [operationId] TEXT NULL, " +
            "[targetProductKey] TEXT NOT NULL, [targetQuantity] INTEGER NOT NULL, [effectiveAt] INTEGER NOT NULL, " +
            "[idempotencyKey] TEXT NOT NULL UNIQUE, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, " +
            "[providerAcknowledgedAt] TEXT NULL, [activeJobGenerationId] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_handovers] (" +
            "[operationId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [sourceSubscriptionId] TEXT NOT NULL, [sourceSnapshot] TEXT NOT NULL, " +
            "[anchor] TEXT NOT NULL, [phase] TEXT NOT NULL, [setupSessionId] TEXT NULL, [latchUntil] TEXT NULL, [cancelDispatched] INTEGER NOT NULL DEFAULT 0, [attemptToken] TEXT NULL)")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_quotes] (" +
            "[operationId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [snapshot] TEXT NOT NULL, " +
            "[result] TEXT NULL, [expiresAt] TEXT NOT NULL, [consumedBy] TEXT NULL)")),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_operations", "quoteId", "TEXT"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_subscriptions", "replacedBy", "TEXT"),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_provider_lanes] (" +
            "[teamId] TEXT PRIMARY KEY, [claimToken] TEXT NULL, [claimExpiresAt] TEXT NULL, [updatedAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_erasure_state] (" +
            "[teamId] TEXT PRIMARY KEY, [erasureKey] TEXT NOT NULL UNIQUE, [operationId] TEXT NOT NULL UNIQUE, " +
            "[activeJobGenerationId] TEXT NOT NULL, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_erasure_tombstones] (" +
            "[erasureKey] TEXT PRIMARY KEY, [evidenceDigest] TEXT NOT NULL, [providerQuiescedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_billing_erasure_object_tombstones] (" +
            "[objectKey] TEXT PRIMARY KEY, [kind] TEXT NOT NULL, [terminalState] TEXT NOT NULL, [providerQuiescedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
        ...(["currency", "mode", "quantity", "continuationUrl", "continuationExpiresAt", "attemptedAt", "providerExpiresAt", "terminalObservedAt", "providerCustomerId", "providerSubscriptionId", "providerPriceId", "configurationId", "returnPath", "paymentActionUrl", "paymentActionExpiresAt"]
            .map((name) => () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_operations", name, name === "quantity" || name === "providerExpiresAt" ? "INTEGER" : "TEXT"))),
        ...(["billingMode", "currency", "interval", "trialEndsAt", "providerSubscriptionItemId", "currentPeriodStart", "lastEventOccurredAt", "lastEventKind"]
            .map((name) => () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_subscriptions", name, "TEXT"))),
        ...(["unitAmount", "lastEventRank", "terminalLatch", "hasSchedule"]
            .map((name) => () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_subscriptions", name, "INTEGER"))),
        ...(["eventType", "outcome", "safeReason"]
            .map((name) => () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_observations", name, "TEXT"))),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_operations", "trialDays", "INTEGER"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_observations", "eventRank", "INTEGER"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "activeJobGenerationId", "TEXT"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "targetPriceId", "TEXT"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "resetBillingCycle", "INTEGER"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "providerAttemptedAt", "TEXT"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "resume", "INTEGER"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "endTrial", "INTEGER"),
        () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_desired_state", "preserveTrial", "INTEGER"),
    ]);
}
export function normalizeTeamBillingDefinition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["catalogue", "authorize", "usage", "checkout", "portal", "transitions"].includes(key))
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
            || Object.keys(product).some((key) => !["quantity", "stripe", "trialDays"].includes(key)))
            throw invalidDeclaration();
        const trialDays = product.trialDays;
        if (trialDays !== undefined && (!Number.isSafeInteger(trialDays) || trialDays < 1 || trialDays > 90))
            throw invalidDeclaration();
        const quantity = normalizeQuantity(product.quantity);
        const stripe = product.stripe;
        if (!stripe || typeof stripe !== "object" || Array.isArray(stripe)
            || Object.keys(stripe).sort().join(",") !== "live,sandbox")
            throw invalidDeclaration();
        const sandbox = normalizeModeBinding(stripe.sandbox, invalidDeclaration);
        const live = normalizeModeBinding(stripe.live, invalidDeclaration);
        for (const binding of [sandbox, live])
            for (const { priceId } of teamBillingPrices(binding)) {
                if (prices.has(priceId))
                    throw invalidDeclaration();
                prices.add(priceId);
            }
        catalogue[productKey] = Object.freeze({
            quantity,
            ...(trialDays === undefined ? {} : { trialDays }),
            stripe: Object.freeze({ sandbox, live }),
        });
    }
    if (value.transitions !== undefined && (!isRecord(value.transitions)
        || Object.keys(value.transitions).some((key) => !["allowSamePolicy", "endTrial"].includes(key))
        || ["allowSamePolicy", "endTrial"].some((key) => value.transitions[key] !== undefined && typeof value.transitions[key] !== "boolean")))
        throw invalidDeclaration();
    const transitions = value.transitions === undefined ? null : Object.freeze({ allowSamePolicy: value.transitions.allowSamePolicy ?? false, endTrial: value.transitions.endTrial ?? false });
    if ((value.usage !== undefined && typeof value.usage !== "function")
        || Object.values(catalogue).some((product) => product.quantity.kind === "usage") && typeof value.usage !== "function")
        throw invalidDeclaration();
    const checkout = value.checkout === undefined ? null : normalizeCheckoutDefinition(value.checkout);
    const portal = value.portal === undefined ? null : normalizePortalDefinition(value.portal, catalogue);
    return Object.freeze({ catalogue: Object.freeze(catalogue), authorize: value.authorize, ...(value.usage === undefined ? {} : { usage: value.usage }), checkout, portal, transitions });
}
function normalizePortalDefinition(value, catalogue) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["returnPath", "continuationTtlSeconds", "prorationBehavior", "billingCycleAnchor", "scheduleAtPeriodEnd"].includes(key)))
        throw invalidDeclaration();
    const returnPath = canonicalReturnPath(value.returnPath);
    const continuationTtlSeconds = value.continuationTtlSeconds ?? CHECKOUT_CONTINUATION_TTL_DEFAULT_SECONDS;
    if (!returnPath || !Number.isInteger(continuationTtlSeconds)
        || continuationTtlSeconds < 60 || continuationTtlSeconds > CHECKOUT_CONTINUATION_TTL_MAX_SECONDS)
        throw invalidDeclaration();
    const configurationPolicies = new Map();
    const configurationModes = new Map();
    for (const product of Object.values(catalogue)) {
        const policy = teamBillingQuantityPolicyFingerprint(product.quantity);
        for (const mode of ["sandbox", "live"]) {
            const binding = product.stripe[mode];
            if (!binding.productId || !binding.portalConfigurationId)
                throw invalidDeclaration();
            const existingPolicy = configurationPolicies.get(`${mode}:${binding.portalConfigurationId}`);
            if (existingPolicy && existingPolicy !== policy)
                throw invalidDeclaration();
            configurationPolicies.set(`${mode}:${binding.portalConfigurationId}`, policy);
            const existingMode = configurationModes.get(binding.portalConfigurationId);
            if (existingMode && existingMode !== mode)
                throw invalidDeclaration();
            configurationModes.set(binding.portalConfigurationId, mode);
        }
    }
    let policy;
    try {
        policy = normalizeTeamBillingPortalPolicy(value);
    }
    catch {
        throw invalidDeclaration();
    }
    return Object.freeze({ returnPath, continuationTtlSeconds, ...policy });
}
function normalizeCheckoutDefinition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["successPath", "cancelPath", "continuationTtlSeconds"].includes(key)))
        throw invalidDeclaration();
    const successPath = canonicalReturnPath(value.successPath);
    const cancelPath = canonicalReturnPath(value.cancelPath);
    const continuationTtlSeconds = value.continuationTtlSeconds ?? CHECKOUT_CONTINUATION_TTL_DEFAULT_SECONDS;
    if (!successPath || !cancelPath || !Number.isInteger(continuationTtlSeconds)
        || continuationTtlSeconds < 60 || continuationTtlSeconds > CHECKOUT_CONTINUATION_TTL_MAX_SECONDS)
        throw invalidDeclaration();
    return Object.freeze({ successPath, cancelPath, continuationTtlSeconds });
}
function normalizeQuantity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalidDeclaration();
    if (value.kind === "team-members" && Object.keys(value).every((key) => key === "kind" || key === "minimum")
        && (value.minimum === undefined || Number.isSafeInteger(value.minimum)
            && value.minimum >= 1 && value.minimum <= FIXED_QUANTITY_MAX)) {
        return Object.freeze({ kind: "team-members", ...(value.minimum === undefined ? {} : { minimum: value.minimum }) });
    }
    if (value.kind === "usage" && Object.keys(value).every((key) => ["kind", "meter", "minimum", "maximum"].includes(key))
        && typeof value.meter === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value.meter)
        && [value.minimum, value.maximum].every((bound) => bound === undefined
            || Number.isSafeInteger(bound) && bound >= 1 && bound <= FIXED_QUANTITY_MAX)
        && (value.maximum === undefined || value.maximum >= (value.minimum ?? 1))) {
        return Object.freeze({ kind: "usage", meter: value.meter,
            ...(value.minimum === undefined ? {} : { minimum: value.minimum }),
            ...(value.maximum === undefined ? {} : { maximum: value.maximum }) });
    }
    if (value.kind === "fixed" && Object.keys(value).sort().join(",") === "kind,value"
        && Number.isSafeInteger(value.value) && value.value >= 1 && value.value <= FIXED_QUANTITY_MAX) {
        return Object.freeze({ kind: "fixed", value: value.value });
    }
    throw invalidDeclaration();
}
function invalidDeclaration() {
    return commandError("Invalid Team Billing declaration.", "Declare 1-32 lowercase products with exact sandbox/live Stripe Price bindings, a fixed, Team-member or usage quantity policy (with an exact usage hook), and an authorize policy.", "INVALID_TEAM_BILLING_DECLARATION");
}
export async function readCurrentUserTeamBilling(database, auth, teamId) {
    requireAuth({ auth }, { linked: true });
    if (!database.teamBillingDefinition || !TEAM_ID_PATTERN.test(String(teamId ?? "")))
        throw teamBillingDenied();
    return database.adapter.withTransaction(async (transaction) => {
        await admitTeamBillingReader(database, transaction, auth, teamId);
        return safeTeamBillingProjection(transaction, database.teamBillingDefinition, teamId, database.clock.now());
    });
}
async function admitTeamBillingReader(database, transaction, auth, teamId) {
    await lockTeamLifecycle(transaction, teamId, teamBillingDenied);
    const membership = await transaction.prepare(transaction.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
    if (!membership || !["admin", "member"].includes(membership.role))
        throw teamBillingDenied();
    const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
        operation: "read", teamId, teamRole: membership.role,
    }));
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
        || Object.keys(decision).join(",") !== "allow" || decision.allow !== true)
        throw teamBillingDenied();
}
/**
 * Provider-free Team Billing truth for Capsule server policy. Unlike a
 * customer-directed billing command, this admits any current linked Team
 * member and never invokes the app's Billing Holder authorization callback.
 * The surrounding Capsule context owns and revokes the transaction.
 */
export async function readCapsuleTeamBillingProjection(database, transaction, auth, teamId) {
    requireAuth({ auth }, { linked: true });
    if (!database.teamBillingDefinition || !TEAM_ID_PATTERN.test(String(teamId ?? "")))
        throw teamBillingDenied();
    const membership = await transaction.prepare(transaction.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
    if (!membership || !["admin", "member"].includes(membership.role))
        throw teamBillingDenied();
    return safeTeamBillingProjection(transaction, database.teamBillingDefinition, teamId, database.clock.now());
}
export async function startTeamBillingCheckout(database, auth, teamId, requestId, productKey, interval, currency) {
    requireAuth({ auth }, { linked: true });
    const definition = database.teamBillingDefinition;
    if (!definition?.checkout || !database.paymentsConfig?.stripe?.enabled
        || !TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? ""))
        || typeof productKey !== "string" || !definition.catalogue[productKey])
        throw teamBillingDenied();
    const mode = database.paymentsConfig.stripe.livemode ? "live" : "sandbox";
    const price = teamBillingPrice(definition.catalogue[productKey].stripe[mode], interval);
    if (!price)
        throw teamBillingDenied();
    if (currency !== undefined && (!validBillingCurrency(currency) || billingCurrencyAmount(price, currency) === undefined))
        throw teamBillingDenied();
    currency = currency ?? price.currency;
    let enqueued = false;
    const result = await withTeamBillingAdmissionTransaction(database, async (transaction) => {
        await admitTeamBillingActor(database, transaction, auth, { operation: "checkout", teamId, productKey, interval: price.interval, ...(currency ? { currency } : {}) });
        await assertTeamBillingErasureInactive(database, transaction, teamId);
        await assertCurrencyHandoverInactive(transaction, teamId);
        const sql = transaction.dialect.sql;
        const existing = await transaction.prepare(sql("SELECT [requestId], [productKey], [providerPriceId], [currency], [status], [providerObjectId], [continuationUrl], [continuationExpiresAt], [safeFailureCode], [createdAt] " +
            "FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
        if (existing) {
            if (existing.productKey !== productKey || existing.providerPriceId !== price.priceId || (existing.currency ?? null) !== (currency ?? null))
                throw checkoutConflict();
            if (existing.status !== "completed")
                await assertNoTeamBillingSubscription(transaction, teamId);
            return checkoutOperationResult(database, transaction, teamId, requestId, existing);
        }
        await assertCheckoutCurrency(transaction, teamId, currency);
        const desired = await checkoutDesiredState(database, transaction, teamId, productKey, interval);
        if (desired.trialDays !== undefined)
            await assertTeamTrialAvailable(transaction, teamId);
        const now = database.clock.now().toISOString();
        const active = await transaction.prepare(sql("SELECT [id], [status], [continuationExpiresAt] FROM [sporades_team_billing_operations] " +
            "WHERE [teamId] = ? AND [kind] = 'checkout' AND [status] IN ('running', 'retrying', 'ready') ORDER BY [createdAt] LIMIT 1")).get(teamId);
        if (active?.status === "ready" && (!canonicalTimestamp(active.continuationExpiresAt) || active.continuationExpiresAt <= now)) {
            await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [id] = ? AND [status] = 'ready'")).run(now, active.id);
        }
        else if (active) {
            throw checkoutActive();
        }
        const operationId = randomUUID();
        const idempotencyKey = checkoutIdempotencyKey(database.capsuleIdentity, teamId, requestId);
        const providerExpiresAt = Math.floor((database.clock.now().getTime() + 23 * 60 * 60 * 1_000) / 1_000);
        await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? " +
            "WHERE [teamId] = ? AND [kind] = 'checkout' AND [status] = 'queued' AND [providerObjectId] IS NULL")).run(now, teamId);
        await transaction.prepare(sql("INSERT INTO [sporades_team_billing_operations] " +
            "([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity], [providerPriceId], [continuationUrl], [continuationExpiresAt], [attemptedAt], [providerExpiresAt], [currency], [trialDays]) " +
            "VALUES (?, ?, ?, ?, 'checkout', ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)")).run(operationId, requestId, teamId, auth.userId, productKey, idempotencyKey, now, now, desired.mode, desired.quantity, desired.priceId, providerExpiresAt, currency ?? null, desired.trialDays ?? null);
        if (typeof database.enqueueTeamBillingCheckoutJob !== "function")
            throw checkoutUnavailable();
        await database.enqueueTeamBillingCheckoutJob(transaction, { operationId }, `team-billing-checkout:${operationId}`);
        enqueued = true;
        return Object.freeze({ state: "pending", teamId, requestId, productKey, requestedAt: now });
    });
    if (enqueued)
        database.scheduleTeamBillingJobDispatch?.();
    return result;
}
async function assertCheckoutCurrency(transaction, teamId, currency) {
    if (!currency)
        return;
    const previous = await transaction.prepare(transaction.dialect.sql("SELECT [currency] FROM [sporades_team_billing_subscriptions] [s] WHERE [teamId] = ? AND [currency] IS NOT NULL AND [replacedBy] IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM [sporades_team_billing_handovers] [h] WHERE [h].[sourceSubscriptionId] = [s].[providerSubscriptionId] AND [h].[latchUntil] IS NOT NULL)")).all(teamId);
    if (previous.some((row) => row.currency !== currency))
        throw billingCurrencyMismatch();
}
export async function startTeamBillingPortal(database, auth, teamId, requestId) {
    requireAuth({ auth }, { linked: true });
    const definition = database.teamBillingDefinition;
    if (!definition?.portal || !database.paymentsConfig?.stripe?.enabled
        || !TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? "")))
        throw teamBillingDenied();
    let enqueued = false;
    const result = await withTeamBillingAdmissionTransaction(database, async (transaction) => {
        await admitTeamBillingActor(database, transaction, auth, { operation: "portal", teamId });
        await assertTeamBillingErasureInactive(database, transaction, teamId);
        await assertCurrencyHandoverInactive(transaction, teamId);
        const sql = transaction.dialect.sql;
        const existing = await transaction.prepare(sql("SELECT [requestId], [kind], [productKey], [status], [mode], [quantity], [providerObjectId], [providerCustomerId], [configurationId], [returnPath], [continuationUrl], [continuationExpiresAt], [safeFailureCode], [createdAt] " +
            "FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
        if (existing) {
            if (existing.kind !== "portal")
                throw checkoutConflict();
            return portalOperationResult(database, transaction, teamId, requestId, existing);
        }
        const desired = await portalDesiredState(database, transaction, teamId);
        const now = database.clock.now().toISOString();
        const active = await transaction.prepare(sql("SELECT [id], [status], [continuationExpiresAt] FROM [sporades_team_billing_operations] " +
            "WHERE [teamId] = ? AND [kind] = 'portal' AND [status] IN ('running', 'retrying', 'ready') ORDER BY [createdAt] LIMIT 1")).get(teamId);
        if (active?.status === "ready" && (!canonicalTimestamp(active.continuationExpiresAt) || active.continuationExpiresAt <= now)) {
            await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [id] = ? AND [status] = 'ready'")).run(now, active.id);
        }
        else if (active)
            throw checkoutActive();
        const operationId = randomUUID();
        const idempotencyKey = teamBillingOperationIdempotencyKey(database.capsuleIdentity, "portal", teamId, requestId);
        await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? " +
            "WHERE [teamId] = ? AND [kind] = 'portal' AND [status] = 'queued' AND [providerObjectId] IS NULL")).run(now, teamId);
        await transaction.prepare(sql("INSERT INTO [sporades_team_billing_operations] " +
            "([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity], [continuationUrl], [continuationExpiresAt], [attemptedAt], [providerExpiresAt], [providerCustomerId], [configurationId], [returnPath]) " +
            "VALUES (?, ?, ?, ?, 'portal', ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)")).run(operationId, requestId, teamId, auth.userId, desired.productKey, idempotencyKey, now, now, desired.mode, desired.quantity, desired.customerId, desired.configurationId, desired.returnPath);
        if (typeof database.enqueueTeamBillingPortalJob !== "function")
            throw checkoutUnavailable();
        await database.enqueueTeamBillingPortalJob(transaction, { operationId }, `team-billing-portal:${operationId}`);
        enqueued = true;
        return Object.freeze({ state: "pending", teamId, requestId, requestedAt: now });
    });
    if (enqueued)
        database.scheduleTeamBillingJobDispatch?.();
    return result;
}
async function withTeamBillingAdmissionTransaction(database, callback) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await database.adapter.withTransaction(callback);
        }
        catch (error) {
            if (!transientSqliteLock(error) || attempt >= 5)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 5 * (2 ** attempt)));
        }
    }
}
function transientSqliteLock(error) {
    return error?.code === "ERR_SQLITE_ERROR" && /(?:locked|busy)/i.test(String(error?.message ?? ""));
}
export async function performTeamBillingCheckout(database, context, payload, attempt = 1) {
    const operationId = payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).join(",") === "operationId" && TEAM_ID_PATTERN.test(String(payload.operationId ?? ""))
        ? payload.operationId : null;
    if (!operationId)
        throw checkoutUnavailable();
    let providerInput = null;
    let providerLane = null;
    try {
        providerInput = await database.adapter.withTransaction(async (transaction) => {
            const sql = transaction.dialect.sql;
            const operation = await transaction.prepare(sql("SELECT [id], [teamId], [actorUserId], [productKey], [providerPriceId], [currency], [status], [mode], [quantity], [idempotencyKey], [providerExpiresAt], [trialDays], [providerSubscriptionId] " +
                "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'checkout'")).get(operationId);
            if (!operation || !["queued", "running", "retrying"].includes(operation.status))
                return null;
            await assertTeamBillingErasureInactive(database, transaction, operation.teamId);
            await assertCurrencyHandoverInactive(transaction, operation.teamId);
            const actor = await transaction.prepare(sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], [userKind] FROM [sporades_auth_users] WHERE [id] = ?")).get(operation.actorUserId);
            if (!actor)
                throw teamBillingDenied();
            const auth = {
                userId: actor.id,
                displayName: actor.displayName,
                email: actor.email,
                picture: actor.picture,
                isAuthenticated: Boolean(actor.isAuthenticated),
                isGuest: Boolean(actor.isGuest),
                provider: actor.provider,
                ...(actor.userKind === "service" ? { userKind: "service" } : {}),
            };
            const binding = database.teamBillingDefinition.catalogue[operation.productKey]?.stripe?.[operation.mode];
            const price = teamBillingPriceById(binding, operation.providerPriceId);
            if (!price || (price.currency && !operation.currency) || (operation.currency && billingCurrencyAmount(price, operation.currency) === undefined))
                throw checkoutUnavailable();
            await admitTeamBillingActor(database, transaction, auth, { operation: "checkout", teamId: operation.teamId, productKey: operation.productKey, interval: price.interval, ...(operation.currency ? { currency: operation.currency } : {}) });
            const desired = await checkoutDesiredState(database, transaction, operation.teamId, operation.productKey, price.interval);
            if (operation.mode !== desired.mode || operation.quantity !== desired.quantity || operation.providerPriceId !== desired.priceId) {
                await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [safeFailureCode] = 'DESIRED_STATE_CHANGED', [updatedAt] = ? WHERE [id] = ?")).run(database.clock.now().toISOString(), operationId);
                return null;
            }
            if (!Number.isSafeInteger(operation.providerExpiresAt)
                || operation.providerExpiresAt <= Math.floor(database.clock.now().getTime() / 1_000)) {
                await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [updatedAt] = ? WHERE [id] = ?")).run(database.clock.now().toISOString(), operationId);
                return null;
            }
            const customer = await transaction.prepare(sql("SELECT [mode], [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).get(operation.teamId);
            if (customer && customer.mode !== desired.mode)
                throw checkoutUnavailable();
            await assertCheckoutCurrency(transaction, operation.teamId, operation.currency);
            if (operation.trialDays != null)
                await assertTeamTrialAvailable(transaction, operation.teamId, operation.id, operation.providerSubscriptionId ?? "");
            const attemptedAt = database.clock.now().toISOString();
            const claimToken = randomUUID();
            const claimExpiresAt = new Date(database.clock.now().getTime() + 5 * 60_000).toISOString();
            await transaction.prepare(sql("INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?) ON CONFLICT DO NOTHING")).run(operation.teamId, attemptedAt);
            const claimed = await transaction.prepare(sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? " +
                "WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(claimToken, claimExpiresAt, attemptedAt, operation.teamId, attemptedAt);
            if (Number(claimed?.changes ?? claimed?.changesCount ?? 0) !== 1)
                throw providerLaneBusy();
            providerLane = { teamId: operation.teamId, claimToken };
            await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'running', [attemptedAt] = COALESCE([attemptedAt], ?), [updatedAt] = ? WHERE [id] = ?")).run(attemptedAt, attemptedAt, operationId);
            return {
                operationId,
                teamId: operation.teamId,
                productKey: operation.productKey,
                mode: "subscription",
                priceId: desired.priceId,
                ...(operation.currency ? { currency: operation.currency } : {}),
                quantity: desired.quantity,
                ...(operation.trialDays == null ? {} : { trialDays: operation.trialDays }),
                successPath: database.teamBillingDefinition.checkout.successPath,
                cancelPath: database.teamBillingDefinition.checkout.cancelPath,
                idempotencyKey: operation.idempotencyKey,
                businessReference: operationId,
                providerExpiresAt: operation.providerExpiresAt,
                ...(customer ? { customerId: customer.providerCustomerId } : {}),
            };
        });
    }
    catch (error) {
        if (error?.code === "ERR_SQLITE_ERROR" && /(?:locked|busy)/i.test(String(error?.message ?? ""))) {
            error.retryable = true;
            throw error;
        }
        if (error?.code === "TEAM_BILLING_PROVIDER_LANE_BUSY")
            throw error;
        if (error?.code === "TEAM_BILLING_SUBSCRIPTION_EXISTS") {
            await settleCheckoutFailure(database, operationId, error.code);
            error.retryable = false;
            throw error;
        }
        await settleCheckoutFailure(database, operationId, error?.code === "TEAM_BILLING_DENIED" ? "AUTHORITY_CHANGED" : "CONFIGURATION_INVALID");
        const failure = checkoutUnavailable();
        failure.retryable = false;
        throw failure;
    }
    if (!providerInput)
        return null;
    try {
        if (typeof database.createStripeTeamBillingProvider !== "function")
            throw checkoutUnavailable();
        const provider = database.createStripeTeamBillingProvider({
            enabled: true,
            config: database.paymentsConfig.stripe,
            env: database.serverEnv,
            signal: context?.signal,
            ...(database.stripeApiBaseUrl ? { apiBaseUrl: database.stripeApiBaseUrl } : {}),
        });
        const result = await provider.create(providerInput);
        if (!result?.ok || !validCheckoutContinuation(result.url, result.sessionId))
            throw checkoutUnavailable();
        const now = database.clock.now();
        const expiresAt = new Date(now.getTime() + database.teamBillingDefinition.checkout.continuationTtlSeconds * 1_000).toISOString();
        let expiryEnqueued = false;
        const settled = await database.adapter.withTransaction(async (transaction) => {
            const outcome = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'ready', [providerObjectId] = ?, [continuationUrl] = ?, [continuationExpiresAt] = ?, [safeFailureCode] = NULL, [updatedAt] = ? " +
                "WHERE [id] = ? AND [status] IN ('running', 'retrying')")).run(result.sessionId, result.url, expiresAt, now.toISOString(), operationId);
            if (Number(outcome?.changes ?? 0) === 1) {
                if (typeof database.enqueueTeamBillingCheckoutExpiryJob !== "function")
                    throw checkoutUnavailable();
                await database.enqueueTeamBillingCheckoutExpiryJob(transaction, { operationId }, `team-billing-checkout-expiry:${operationId}`, expiresAt);
                expiryEnqueued = true;
            }
            return outcome;
        });
        if (expiryEnqueued)
            database.scheduleTeamBillingJobDispatch?.();
        if (Number(settled?.changes ?? 0) !== 1) {
            const terminal = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [status], [providerObjectId] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(operationId);
            if (!["completed", "expired"].includes(terminal?.status) || terminal.providerObjectId !== result.sessionId)
                throw checkoutUnavailable();
            return { observed: true };
        }
        return { ready: true };
    }
    catch (error) {
        const retryable = error?.retryable !== false;
        const willRetry = retryable && attempt < TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS;
        await settleCheckoutFailure(database, operationId, willRetry ? "PROVIDER_RETRY" : "PROVIDER_REJECTED", willRetry ? "retrying" : "failed");
        if (!willRetry)
            error.retryable = false;
        throw error;
    }
    finally {
        if (providerLane) {
            await database.adapter.prepare(database.adapter.dialect.sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?")).run(database.clock.now().toISOString(), providerLane.teamId, providerLane.claimToken);
        }
    }
}
export async function performTeamBillingPortal(database, context, payload, attempt = 1) {
    const operationId = exactOperationId(payload);
    if (!operationId)
        throw checkoutUnavailable();
    let providerInput = null;
    try {
        providerInput = await database.adapter.withTransaction(async (transaction) => {
            const operation = await readPortalOperation(transaction, operationId);
            if (!operation || !["queued", "running", "retrying"].includes(operation.status))
                return null;
            const desired = await reauthorizePortalOperation(database, transaction, operation);
            if (!portalOperationMatches(operation, desired)) {
                await supersedeBillingOperation(database, transaction, operationId);
                return null;
            }
            const now = database.clock.now().toISOString();
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'running', [attemptedAt] = COALESCE([attemptedAt], ?), [updatedAt] = ? WHERE [id] = ?")).run(now, now, operationId);
            return { configurationId: desired.configurationId, mode: desired.mode, expectedProducts: desired.expectedProducts, expectedPolicy: desired.expectedPolicy,
                endTrial: database.teamBillingDefinition.transitions?.endTrial === true };
        });
    }
    catch (error) {
        if (transientSqliteLock(error)) {
            error.retryable = true;
            throw error;
        }
        await settleCheckoutFailure(database, operationId, error?.code === "TEAM_BILLING_DENIED" ? "AUTHORITY_CHANGED" : "CONFIGURATION_INVALID");
        const failure = checkoutUnavailable();
        failure.retryable = false;
        throw failure;
    }
    if (!providerInput)
        return null;
    try {
        if (typeof database.createStripeTeamBillingProvider !== "function")
            throw checkoutUnavailable();
        const provider = database.createStripeTeamBillingProvider({
            enabled: true, config: database.paymentsConfig.stripe, env: database.serverEnv, signal: context?.signal,
            ...(database.stripeApiBaseUrl ? { apiBaseUrl: database.stripeApiBaseUrl } : {}),
        });
        const attestation = await provider.retrievePortalConfiguration(providerInput);
        if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)
            || Object.keys(attestation).join(",") !== "ok" || attestation.ok !== true)
            throw checkoutUnavailable();
        let createInput = null;
        try {
            createInput = await database.adapter.withTransaction(async (transaction) => {
                const operation = await readPortalOperation(transaction, operationId);
                if (!operation || !["running", "retrying"].includes(operation.status))
                    return null;
                const desired = await reauthorizePortalOperation(database, transaction, operation);
                if (!portalOperationMatches(operation, desired)) {
                    await supersedeBillingOperation(database, transaction, operationId);
                    return null;
                }
                return {
                    customerId: desired.customerId,
                    configurationId: desired.configurationId,
                    returnPath: desired.returnPath,
                    idempotencyKey: operation.idempotencyKey,
                };
            });
        }
        catch (error) {
            if (transientSqliteLock(error)) {
                error.retryable = true;
                throw error;
            }
            await settleCheckoutFailure(database, operationId, error?.code === "TEAM_BILLING_DENIED" ? "AUTHORITY_CHANGED" : "CONFIGURATION_INVALID");
            const failure = checkoutUnavailable();
            failure.retryable = false;
            throw failure;
        }
        if (!createInput)
            return null;
        const response = await provider.createPortal(createInput);
        if (!response?.ok || !validPortalContinuation(response.url, response.sessionId))
            throw checkoutUnavailable();
        const now = database.clock.now();
        const expiresAt = new Date(now.getTime() + database.teamBillingDefinition.portal.continuationTtlSeconds * 1_000).toISOString();
        let expiryEnqueued = false;
        const settled = await database.adapter.withTransaction(async (transaction) => {
            const outcome = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'ready', [providerObjectId] = ?, [continuationUrl] = ?, [continuationExpiresAt] = ?, [safeFailureCode] = NULL, [updatedAt] = ? " +
                "WHERE [id] = ? AND [status] IN ('running', 'retrying')")).run(response.sessionId, response.url, expiresAt, now.toISOString(), operationId);
            if (Number(outcome?.changes ?? 0) === 1) {
                if (typeof database.enqueueTeamBillingPortalExpiryJob !== "function")
                    throw checkoutUnavailable();
                await database.enqueueTeamBillingPortalExpiryJob(transaction, { operationId }, `team-billing-portal-expiry:${operationId}`, expiresAt);
                expiryEnqueued = true;
            }
            return outcome;
        });
        if (expiryEnqueued)
            database.scheduleTeamBillingJobDispatch?.();
        if (Number(settled?.changes ?? 0) !== 1)
            throw checkoutUnavailable();
        return { ready: true };
    }
    catch (error) {
        const retryable = error?.retryable !== false;
        const willRetry = retryable && attempt < TEAM_BILLING_PORTAL_MAX_ATTEMPTS;
        await settleCheckoutFailure(database, operationId, willRetry ? "PROVIDER_RETRY" : "PROVIDER_REJECTED", willRetry ? "retrying" : "failed");
        if (!willRetry)
            error.retryable = false;
        throw error;
    }
}
/** Durably erases an abandoned Checkout continuation when its local exposure window closes. */
export async function expireTeamBillingCheckout(database, _context, payload) {
    const operationId = payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).join(",") === "operationId" && TEAM_ID_PATTERN.test(String(payload.operationId ?? ""))
        ? payload.operationId : null;
    if (!operationId)
        throw checkoutUnavailable();
    const now = database.clock.now().toISOString();
    await database.adapter.prepare(database.adapter.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? " +
        "WHERE [id] = ? AND [status] = 'ready' AND [continuationExpiresAt] <= ?")).run(now, operationId, now);
    return null;
}
export async function expireTeamBillingPortal(database, _context, payload) {
    const operationId = exactOperationId(payload);
    if (!operationId)
        throw checkoutUnavailable();
    const now = database.clock.now().toISOString();
    await database.adapter.prepare(database.adapter.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? " +
        "WHERE [id] = ? AND [kind] = 'portal' AND [status] = 'ready' AND [continuationExpiresAt] <= ?")).run(now, operationId, now);
    return null;
}
/** Reconciles a runtime-owned Checkout operation when its final claimed Job lease expires after a process crash. */
export async function settleExhaustedTeamBillingCheckoutJob(transaction, handler, payloadJson, now) {
    const kind = handler === TEAM_BILLING_CHECKOUT_JOB ? "checkout" : handler === TEAM_BILLING_PORTAL_JOB ? "portal"
        : handler === "_sporades.team-billing-plan-preview" ? "plan-preview" : null;
    if (!kind || typeof payloadJson !== "string")
        return;
    let payload;
    try {
        payload = JSON.parse(payloadJson);
    }
    catch {
        return;
    }
    const operationId = payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).join(",") === "operationId" && TEAM_ID_PATTERN.test(String(payload.operationId ?? ""))
        ? payload.operationId : null;
    if (!operationId)
        return;
    await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = 'PROVIDER_REJECTED', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? " +
        "WHERE [id] = ? AND [kind] = ? AND [status] IN ('queued', 'running', 'retrying')")).run(now, operationId, kind);
}
/** Compatibility wrapper for callers that have not moved into the atomic Stripe consequence transaction. */
export async function applyVerifiedTeamBillingCheckoutObservation(database, event) {
    if (!database.teamBillingDefinition || event?.provider !== "stripe"
        || !["checkout.session.completed", "checkout.session.expired"].includes(event?.type))
        return { applied: false };
    const result = await database.adapter.withTransaction((transaction) => applyVerifiedTeamBillingObservation({ ...database, adapter: transaction }, event));
    return { applied: result.applied === true };
}
/**
 * Reusable last-moment admission for provider-facing Team Billing operations.
 * It deliberately returns no capability: callers must invoke it in the same
 * transaction immediately before persisting provider work.
 */
export async function admitTeamBillingActor(database, transaction, auth, input) {
    requireAuth({ auth }, { linked: true });
    await lockTeamLifecycle(transaction, input.teamId, teamBillingDenied);
    const sql = transaction.dialect.sql;
    const membership = await transaction.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(input.teamId, auth.userId);
    if (membership?.role !== "admin")
        throw teamBillingDenied();
    const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
        operation: input.operation,
        teamId: input.teamId,
        teamRole: "admin",
        ...(input.productKey === undefined ? {} : { productKey: input.productKey }),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.fromCurrency === undefined ? {} : { fromCurrency: input.fromCurrency }),
        ...(input.fromProductKey === undefined ? {} : { fromProductKey: input.fromProductKey }),
        ...(input.fromInterval == null ? {} : { fromInterval: input.fromInterval }),
    }));
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
        || Object.keys(decision).join(",") !== "allow" || decision.allow !== true)
        throw teamBillingDenied();
    return Object.freeze({ admitted: true });
}
export function teamBillingErasureKey(database, teamId) {
    return createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0team-billing-erasure\0${teamId}`).digest("hex");
}
export function teamBillingErasureObjectKey(database, providerObjectId) {
    return createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0team-billing-erasure-object\0${providerObjectId}`).digest("hex");
}
export async function assertTeamBillingErasureInactive(database, transaction, teamId) {
    const active = await transaction.prepare(transaction.dialect.sql("SELECT [teamId] FROM [sporades_team_billing_erasure_state] WHERE [teamId] = ?")).get(teamId);
    const erased = await transaction.prepare(transaction.dialect.sql("SELECT [erasureKey] FROM [sporades_team_billing_erasure_tombstones] WHERE [erasureKey] = ?")).get(teamBillingErasureKey(database, teamId));
    if (active || erased)
        throw teamBillingDenied();
}
export async function safeTeamBillingProjection(transaction, definition, teamId, clock = new Date()) {
    const latch = await readCurrencyHandoverLatch(transaction, definition, teamId, clock);
    if (latch)
        return latch;
    const sql = transaction.dialect.sql;
    const desired = await transaction.prepare(sql("SELECT [kind], [targetProductKey], [status], [safeFailureCode], [createdAt] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
    if (desired && ["queued", "running", "awaiting-observation"].includes(desired.status)) {
        const requestedAt = canonicalTimestamp(desired.createdAt);
        if (!requestedAt)
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        return Object.freeze({
            state: "pending",
            teamId,
            operation: desired.kind === "plan-transition" ? "plan-transition" : "reconciliation",
            ...(typeof desired.targetProductKey === "string" && definition.catalogue[desired.targetProductKey]
                ? { productKey: desired.targetProductKey } : {}),
            requestedAt,
        });
    }
    if (desired?.kind === "seat-convergence" && ["failed", "attention-required"].includes(desired.status)) {
        return Object.freeze({ state: "attention-required", teamId,
            reason: desired.safeFailureCode === "CATALOGUE_MISMATCH" ? "catalogue-mismatch" : "provider-state-ambiguous" });
    }
    const operation = await transaction.prepare(sql("SELECT [kind], [productKey], [createdAt] FROM [sporades_team_billing_operations] " +
        `WHERE [teamId] = ? AND [kind] NOT IN ('currency-handover', ${TEAM_BILLING_READ_ONLY_KINDS_SQL}) AND [status] IN ('queued', 'running', 'retrying', 'awaiting-observation') ORDER BY [createdAt] DESC, [id] DESC LIMIT 1`)).get(teamId);
    if (operation) {
        const requestedAt = canonicalTimestamp(operation.createdAt);
        if (!requestedAt) {
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        }
        const kind = ["checkout", "portal", "plan-transition", "erasure"].includes(operation.kind) ? operation.kind : "reconciliation";
        return Object.freeze({
            state: "pending",
            teamId,
            operation: kind,
            ...(typeof operation.productKey === "string" && definition.catalogue[operation.productKey]
                ? { productKey: operation.productKey } : {}),
            requestedAt,
        });
    }
    const currentRows = await transaction.prepare(sql("SELECT [mode], [providerPriceId], [interval], [currency], [unitAmount], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [trialEndsAt], [lastEventOccurredAt], [lastEventKind], [lastEventRank], [terminalLatch] " +
        "FROM [sporades_team_billing_subscriptions] [s] WHERE [teamId] = ? AND [replacedBy] IS NULL AND [state] <> 'cancelled' " +
        "AND NOT EXISTS (SELECT 1 FROM [sporades_team_billing_handovers] [h] WHERE [h].[sourceSubscriptionId] = [s].[providerSubscriptionId] AND [h].[cancelDispatched] = 1 AND [h].[anchor] <= ?) " +
        "ORDER BY [lastEventOccurredAt] DESC, [id] DESC")).all(teamId, clock.toISOString());
    if (currentRows.length > 1) {
        return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    const row = currentRows[0] ?? await transaction.prepare(sql("SELECT [mode], [providerPriceId], [interval], [currency], [unitAmount], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [trialEndsAt], [lastEventOccurredAt], [lastEventKind], [lastEventRank], [terminalLatch] " +
        "FROM [sporades_team_billing_subscriptions] [s] WHERE [teamId] = ? AND [replacedBy] IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM [sporades_team_billing_handovers] [h] WHERE [h].[sourceSubscriptionId] = [s].[providerSubscriptionId] AND [h].[cancelDispatched] = 1 AND [h].[anchor] <= ?) " +
        "ORDER BY [lastEventOccurredAt] DESC, [observedAt] DESC, [id] DESC LIMIT 1")).get(teamId, clock.toISOString());
    const quarantine = await transaction.prepare(sql("SELECT [observedAt], [eventRank], [safeReason] FROM [sporades_team_billing_observations] " +
        "WHERE [teamId] = ? AND [outcome] = 'quarantined' ORDER BY [observedAt] DESC, [eventRank] DESC, [id] DESC LIMIT 1")).get(teamId);
    if (quarantine && (!row || !canonicalTimestamp(row.lastEventOccurredAt) || quarantine.observedAt > row.lastEventOccurredAt
        || (quarantine.observedAt === row.lastEventOccurredAt && Number(quarantine.eventRank ?? 0) >= Number(row.lastEventRank ?? 0)))) {
        return Object.freeze({ state: "attention-required", teamId,
            reason: quarantine.safeReason === "catalogue-mismatch" ? "catalogue-mismatch" : "provider-state-ambiguous" });
    }
    if (!row)
        return Object.freeze({ state: "inactive", teamId });
    const product = definition.catalogue[row.productKey];
    const binding = (row.mode === "sandbox" || row.mode === "live") ? product?.stripe?.[row.mode] : null;
    const quantity = typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) && row.quantity >= 1
        ? row.quantity : null;
    const price = teamBillingPriceById(binding, row.providerPriceId);
    if (!product || !price || !matchesBillingCurrency(price, row.currency, row.unitAmount) || (price.interval && price.interval !== row.interval)
        || quantity === null || (product.quantity.kind === "fixed" && quantity !== product.quantity.value)
        || (product.quantity.kind !== "fixed" && quantity < (product.quantity.minimum ?? 1))) {
        return Object.freeze({ state: "attention-required", teamId, reason: "catalogue-mismatch" });
    }
    if (row.cancelAtPeriodEnd !== 0 && row.cancelAtPeriodEnd !== 1) {
        return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    const occurredAt = canonicalTimestamp(row.lastEventOccurredAt);
    const semantics = teamBillingStoredSubscriptionSemantics(row.state, row.cancelAtPeriodEnd === 1);
    if (!occurredAt || !semantics || row.lastEventKind !== semantics.kind
        || Number(row.lastEventRank) !== semantics.rank || Number(row.terminalLatch) !== semantics.terminalLatch) {
        return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    const common = { teamId, productKey: row.productKey, quantity, ...(row.currency ? { currency: row.currency } : {}), ...(price.interval ? { interval: price.interval } : {}) };
    if (row.state === "trialing") {
        const trialEndsAt = canonicalTimestamp(row.trialEndsAt);
        return Object.freeze(trialEndsAt
            ? { state: "trialing", ...common, trialEndsAt }
            : { state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    if (row.state === "active") {
        const currentPeriodEnd = canonicalTimestamp(row.currentPeriodEnd);
        if (!currentPeriodEnd) {
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        }
        return Object.freeze(row.cancelAtPeriodEnd === 1
            ? { state: "cancelling", ...common, endsAt: currentPeriodEnd }
            : { state: "active", ...common, renewsAt: currentPeriodEnd });
    }
    if (row.state === "past-due") {
        const currentPeriodEnd = canonicalTimestamp(row.currentPeriodEnd);
        return Object.freeze(currentPeriodEnd
            ? { state: "past-due", ...common, currentPeriodEnd }
            : { state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    if (row.state === "cancelled")
        return Object.freeze({ state: "cancelled", ...common });
    return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
}
/** Bounded provider-free quarantine inspection for an active Privileged callback. */
export function createPrivilegedTeamBillingApi(database, contextGetter) {
    return Object.freeze({
        async listQuarantines(options = {}) {
            const assertActive = () => assertActivePrivilegedTeamBillingAccess(contextGetter);
            assertActive();
            if (!isRecord(options) || Object.keys(options).some((key) => key !== "limit"))
                throw invalidTeamBillingInspection();
            const limit = options.limit ?? 50;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
                throw invalidTeamBillingInspection();
            if (!database.teamBillingDefinition)
                return Object.freeze({ quarantines: Object.freeze([]) });
            let rows;
            try {
                rows = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [teamId], [mode], [eventType], [observedAt], [safeReason] FROM [sporades_team_billing_observations] " +
                    "WHERE [outcome] = 'quarantined' ORDER BY [observedAt] DESC, [id] DESC LIMIT ?")).all(limit);
            }
            catch (error) {
                assertActive();
                throw error;
            }
            assertActive();
            return Object.freeze({ quarantines: Object.freeze(rows.map((row) => Object.freeze({
                    teamId: typeof row.teamId === "string" ? row.teamId : null,
                    associatedTeam: typeof row.teamId === "string",
                    mode: row.mode === "live" ? "live" : "sandbox",
                    eventType: typeof row.eventType === "string" ? row.eventType : "unknown",
                    occurredAt: canonicalTimestamp(row.observedAt),
                    reason: row.safeReason === "catalogue-mismatch" ? "catalogue-mismatch" : "provider-state-ambiguous",
                }))) });
        },
    });
}
function assertActivePrivilegedTeamBillingAccess(contextGetter) {
    const context = contextGetter?.();
    if (context?.__privilegedRunActive && !context.signal?.aborted)
        return;
    throw commandError("Privileged Team Billing access is no longer active.", "Start a new ctx.privileged.run callback before inspecting Team Billing quarantine.", "PRIVILEGED_TEAM_BILLING_ACCESS_INACTIVE");
}
function invalidTeamBillingInspection() {
    return commandError("Invalid Team Billing inspection options.", "Pass only an integer limit from 1 through 100.", "INVALID_TEAM_BILLING_INSPECTION");
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function canonicalTimestamp(value) {
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value))
        return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}
function canonicalReturnPath(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
        || value.includes("\\") || value.includes("?") || value.includes("#") || /\s/.test(value))
        return null;
    try {
        const pathname = new URL(value, "https://sporades.invalid").pathname;
        return pathname === value ? value : null;
    }
    catch {
        return null;
    }
}
async function assertNoTeamBillingSubscription(transaction, teamId) {
    const subscription = await transaction.prepare(transaction.dialect.sql("SELECT [id] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [replacedBy] IS NULL AND ([state] <> 'cancelled' OR [terminalLatch] IS NULL OR [terminalLatch] <> 1) LIMIT 1")).get(teamId);
    const unresolved = subscription ? null : await transaction.prepare(transaction.dialect.sql("SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [kind] = 'checkout' AND [providerSubscriptionId] IS NOT NULL " +
        "AND [providerSubscriptionId] NOT IN (SELECT [providerSubscriptionId] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [state] = 'cancelled' AND [terminalLatch] = 1) LIMIT 1")).get(teamId, teamId);
    if (subscription || unresolved)
        throw commandError("The Team already has a subscription.", "Manage the existing subscription from Team billing settings.", "TEAM_BILLING_SUBSCRIPTION_EXISTS");
}
// A dispatched trial reserves the Team allowance even when the provider reply is lost.
// Keep the reservation with its durable operation so retries can recover the same Session.
async function assertTeamTrialAvailable(transaction, teamId, operationId = "", subscriptionId = "") {
    const sql = transaction.dialect.sql;
    const attempted = await transaction.prepare(sql("SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [kind] = 'checkout' " +
        "AND [trialDays] IS NOT NULL AND [attemptedAt] IS NOT NULL AND [id] <> ? " +
        "AND NOT ([status] = 'expired' AND [terminalObservedAt] IS NOT NULL) LIMIT 1")).get(teamId, operationId);
    const observed = await transaction.prepare(sql("SELECT [id] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [trialEndsAt] IS NOT NULL " +
        "AND [providerSubscriptionId] <> ? LIMIT 1")).get(teamId, subscriptionId);
    if (attempted || observed)
        throw teamBillingDenied();
}
async function checkoutDesiredState(database, transaction, teamId, productKey, interval) {
    await assertNoTeamBillingSubscription(transaction, teamId);
    const product = database.teamBillingDefinition.catalogue[productKey];
    const mode = database.paymentsConfig.stripe.livemode ? "live" : "sandbox";
    const quantity = await readTeamBillingQuantity(database, transaction, teamId, product.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > FIXED_QUANTITY_MAX
        || product.quantity.kind === "usage" && quantity > (product.quantity.maximum ?? FIXED_QUANTITY_MAX))
        throw checkoutUnavailable();
    const price = teamBillingPrice(product.stripe[mode], interval);
    if (!price)
        throw checkoutUnavailable();
    return { mode, quantity, priceId: price.priceId, trialDays: product.trialDays };
}
async function portalDesiredState(database, transaction, teamId) {
    const sql = transaction.dialect.sql;
    const mode = database.paymentsConfig.stripe.livemode ? "live" : "sandbox";
    const customer = await transaction.prepare(sql("SELECT [mode], [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).get(teamId);
    const subscriptions = await transaction.prepare(sql("SELECT [mode], [providerPriceId], [interval], [productKey], [quantity], [state] FROM [sporades_team_billing_subscriptions] " +
        "WHERE [teamId] = ? AND [replacedBy] IS NULL AND [state] IN ('trialing', 'active', 'cancelling', 'past-due') ORDER BY [observedAt] DESC, [id] DESC")).all(teamId);
    const subscription = subscriptions.length === 1 ? subscriptions[0] : null;
    const product = database.teamBillingDefinition.catalogue[subscription?.productKey];
    const binding = product?.stripe?.[mode];
    const expectedQuantity = product ? await readTeamBillingQuantity(database, transaction, teamId, product.quantity) : null;
    if (!customer || customer.mode !== mode || !/^cus_[A-Za-z0-9_]{1,120}$/.test(String(customer.providerCustomerId ?? ""))
        || !subscription || subscription.mode !== mode || !["trialing", "active", "cancelling", "past-due"].includes(subscription.state)
        || !binding?.productId || !binding?.portalConfigurationId || !teamBillingPriceById(binding, subscription.providerPriceId)
        || (binding.prices && teamBillingPriceById(binding, subscription.providerPriceId)?.interval !== subscription.interval)
        || !Number.isSafeInteger(subscription.quantity) || subscription.quantity !== expectedQuantity)
        throw checkoutUnavailable();
    const grouped = new Map();
    for (const candidate of Object.values(database.teamBillingDefinition.catalogue)) {
        const candidateBinding = candidate.stripe[mode];
        if (candidateBinding.portalConfigurationId !== binding.portalConfigurationId)
            continue;
        const prices = grouped.get(candidateBinding.productId) ?? new Set();
        for (const price of teamBillingPrices(candidateBinding))
            prices.add(price.priceId);
        grouped.set(candidateBinding.productId, prices);
    }
    const expectedProducts = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([productId, prices]) => ({ productId, priceIds: [...prices].sort() }));
    return {
        mode,
        productKey: subscription.productKey,
        quantity: subscription.quantity,
        customerId: customer.providerCustomerId,
        configurationId: binding.portalConfigurationId,
        returnPath: database.teamBillingDefinition.portal.returnPath,
        expectedProducts,
        expectedPolicy: normalizeTeamBillingPortalPolicy(database.teamBillingDefinition.portal),
    };
}
async function readPortalOperation(transaction, operationId) {
    return transaction.prepare(transaction.dialect.sql("SELECT [id], [teamId], [actorUserId], [productKey], [status], [mode], [quantity], [idempotencyKey], [providerCustomerId], [configurationId], [returnPath] " +
        "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'portal'")).get(operationId);
}
async function reauthorizePortalOperation(database, transaction, operation) {
    const actor = await transaction.prepare(transaction.dialect.sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], [userKind] FROM [sporades_auth_users] WHERE [id] = ?")).get(operation.actorUserId);
    if (!actor)
        throw teamBillingDenied();
    const auth = { userId: actor.id, displayName: actor.displayName, email: actor.email, picture: actor.picture,
        isAuthenticated: Boolean(actor.isAuthenticated), isGuest: Boolean(actor.isGuest), provider: actor.provider,
        ...(actor.userKind === "service" ? { userKind: "service" } : {}) };
    await admitTeamBillingActor(database, transaction, auth, { operation: "portal", teamId: operation.teamId });
    return portalDesiredState(database, transaction, operation.teamId);
}
function portalOperationMatches(operation, desired) {
    return operation.mode === desired.mode && operation.productKey === desired.productKey && operation.quantity === desired.quantity
        && operation.providerCustomerId === desired.customerId && operation.configurationId === desired.configurationId
        && operation.returnPath === desired.returnPath;
}
async function supersedeBillingOperation(database, transaction, operationId) {
    await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [safeFailureCode] = 'DESIRED_STATE_CHANGED', [updatedAt] = ? WHERE [id] = ?")).run(database.clock.now().toISOString(), operationId);
}
async function checkoutOperationResult(database, transaction, teamId, requestId, operation) {
    const common = { teamId, requestId, productKey: operation.productKey };
    if (["queued", "running", "retrying"].includes(operation.status)) {
        const requestedAt = canonicalTimestamp(operation.createdAt);
        return requestedAt
            ? Object.freeze({ state: "pending", ...common, requestedAt })
            : Object.freeze({ state: "failed", ...common, reason: "unavailable" });
    }
    if (operation.status === "ready") {
        const expiresAt = canonicalTimestamp(operation.continuationExpiresAt);
        if (expiresAt && expiresAt > database.clock.now().toISOString()
            && validCheckoutContinuation(operation.continuationUrl, operation.providerObjectId)) {
            return Object.freeze({ state: "ready", ...common, url: operation.continuationUrl, expiresAt });
        }
        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [requestId] = ? AND [status] = 'ready'")).run(database.clock.now().toISOString(), teamId, requestId);
        return Object.freeze({ state: "expired", ...common });
    }
    if (operation.status === "expired")
        return Object.freeze({ state: "expired", ...common });
    if (operation.status === "superseded")
        return Object.freeze({ state: "superseded", ...common });
    if (operation.status === "completed")
        return Object.freeze({ state: "completed", ...common });
    return Object.freeze({ state: "failed", ...common, reason: operation.safeFailureCode === "AUTHORITY_CHANGED" ? "authority-changed" : "unavailable" });
}
function checkoutIdempotencyKey(capsuleIdentity, teamId, requestId) {
    return teamBillingOperationIdempotencyKey(capsuleIdentity, "checkout", teamId, requestId);
}
function teamBillingOperationIdempotencyKey(capsuleIdentity, kind, teamId, requestId) {
    const digest = createHash("sha256").update(`${String(capsuleIdentity)}\0${kind}\0${teamId}\0${requestId}`).digest("base64url");
    return `sporades:team-${kind}:${digest}`;
}
function exactOperationId(payload) {
    return payload && typeof payload === "object" && !Array.isArray(payload)
        && Object.keys(payload).join(",") === "operationId" && TEAM_ID_PATTERN.test(String(payload.operationId ?? ""))
        ? payload.operationId : null;
}
function validCheckoutContinuation(urlValue, sessionIdValue) {
    if (typeof sessionIdValue !== "string" || !/^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(sessionIdValue)
        || typeof urlValue !== "string")
        return false;
    try {
        const url = new URL(urlValue);
        return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
            && (url.pathname === `/c/pay/${sessionIdValue}` || url.pathname === `/pay/${sessionIdValue}`)
            && !url.username && !url.password && !url.port;
    }
    catch {
        return false;
    }
}
function validPortalContinuation(urlValue, sessionIdValue) {
    if (typeof sessionIdValue !== "string" || !/^bps_[A-Za-z0-9_]{1,240}$/.test(sessionIdValue) || typeof urlValue !== "string")
        return false;
    try {
        const url = new URL(urlValue);
        if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com"
            || url.username || url.password || url.port)
            return false;
        if (/^\/p\/session\/[A-Za-z0-9_-]{8,1024}$/.test(url.pathname)) {
            return !url.search && (!url.hash || /^#[A-Za-z0-9_-]{1,1024}$/.test(url.hash));
        }
        const query = [...url.searchParams];
        return url.pathname === "/p/session" && !url.hash && query.length === 1
            && query[0][0] === "secret" && /^[A-Za-z0-9_-]{32,1024}$/.test(query[0][1]);
    }
    catch {
        return false;
    }
}
async function portalOperationResult(database, transaction, teamId, requestId, operation) {
    const common = { teamId, requestId };
    if (["queued", "running", "retrying"].includes(operation.status)) {
        const requestedAt = canonicalTimestamp(operation.createdAt);
        return requestedAt ? Object.freeze({ state: "pending", ...common, requestedAt })
            : Object.freeze({ state: "failed", ...common, reason: "unavailable" });
    }
    if (operation.status === "ready") {
        let desired = null;
        try {
            desired = await portalDesiredState(database, transaction, teamId);
        }
        catch (error) {
            if (error?.code !== "TEAM_BILLING_CHECKOUT_UNAVAILABLE")
                throw error;
        }
        if (!desired || !portalOperationMatches(operation, desired)) {
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [safeFailureCode] = 'DESIRED_STATE_CHANGED', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [requestId] = ? AND [kind] = 'portal' AND [status] = 'ready'")).run(database.clock.now().toISOString(), teamId, requestId);
            return Object.freeze({ state: "superseded", ...common });
        }
        const expiresAt = canonicalTimestamp(operation.continuationExpiresAt);
        if (expiresAt && expiresAt > database.clock.now().toISOString() && validPortalContinuation(operation.continuationUrl, operation.providerObjectId)) {
            return Object.freeze({ state: "ready", ...common, url: operation.continuationUrl, expiresAt });
        }
        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [requestId] = ? AND [kind] = 'portal' AND [status] = 'ready'")).run(database.clock.now().toISOString(), teamId, requestId);
        return Object.freeze({ state: "expired", ...common });
    }
    if (operation.status === "expired")
        return Object.freeze({ state: "expired", ...common });
    if (operation.status === "superseded")
        return Object.freeze({ state: "superseded", ...common });
    return Object.freeze({ state: "failed", ...common, reason: operation.safeFailureCode === "AUTHORITY_CHANGED" ? "authority-changed" : "unavailable" });
}
async function settleCheckoutFailure(database, operationId, safeFailureCode, status = "failed") {
    await database.adapter.prepare(database.adapter.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = ?, [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ? AND [status] IN ('queued', 'running', 'retrying')")).run(status, safeFailureCode, database.clock.now().toISOString(), operationId);
}
function checkoutConflict() {
    return commandError("Team Checkout request conflicts with existing work.", "Use a new request identifier for a different product.", "TEAM_BILLING_REQUEST_CONFLICT");
}
function checkoutActive() {
    return commandError("A Team Checkout is already active.", "Finish, abandon, or allow the current Team Checkout to expire before starting another.", "TEAM_BILLING_CHECKOUT_ACTIVE");
}
function checkoutUnavailable() {
    const error = commandError("Team Checkout is unavailable.", "Retry from the Team billing settings later.", "TEAM_BILLING_CHECKOUT_UNAVAILABLE");
    error.retryable = false;
    return error;
}
function providerLaneBusy() {
    const error = checkoutUnavailable();
    error.code = "TEAM_BILLING_PROVIDER_LANE_BUSY";
    error.retryable = true;
    return error;
}
export function teamBillingDenied() {
    return commandError("Team Billing is unavailable.", "Sign in as the current policy-approved billing administrator for this Team and retry.", "TEAM_BILLING_DENIED");
}
//# sourceMappingURL=team-billing-runtime.js.map