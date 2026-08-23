// Headless Team Billing control-plane foundation. Provider identifiers and
// replay correlation stay in runtime-owned tables; Capsule code receives only
// declared product keys and closed, provider-free projections.
import { createHash, randomUUID } from "node:crypto";
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
import { lockTeamLifecycle } from "./teams-runtime.js";
export const TEAM_BILLING_PRODUCT_MAX = 32;
export const TEAM_BILLING_CHECKOUT_JOB = "_sporades.team-billing-checkout";
export const TEAM_BILLING_CHECKOUT_EXPIRY_JOB = "_sporades.team-billing-checkout-expiry";
export const TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS = 4;
export const TEAM_BILLING_PORTAL_JOB = "_sporades.team-billing-portal";
export const TEAM_BILLING_PORTAL_EXPIRY_JOB = "_sporades.team-billing-portal-expiry";
export const TEAM_BILLING_PORTAL_MAX_ATTEMPTS = 4;
const CHECKOUT_CONTINUATION_TTL_DEFAULT_SECONDS = 10 * 60;
const CHECKOUT_CONTINUATION_TTL_MAX_SECONDS = 30 * 60;
const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,249}$/;
const PRODUCT_ID_PATTERN = /^prod_[A-Za-z0-9_]{1,240}$/;
const PORTAL_CONFIGURATION_ID_PATTERN = /^bpc_[A-Za-z0-9_]{1,240}$/;
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
        ...(["mode", "quantity", "continuationUrl", "continuationExpiresAt", "attemptedAt", "providerExpiresAt", "terminalObservedAt", "providerCustomerId", "configurationId", "returnPath"]
            .map((name) => () => adapter.dialect.addMissingColumn?.(adapter, "sporades_team_billing_operations", name, name === "quantity" || name === "providerExpiresAt" ? "INTEGER" : "TEXT"))),
    ]);
}
export function normalizeTeamBillingDefinition(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["catalogue", "authorize", "checkout", "portal"].includes(key))
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
    const checkout = value.checkout === undefined ? null : normalizeCheckoutDefinition(value.checkout);
    const portal = value.portal === undefined ? null : normalizePortalDefinition(value.portal, catalogue);
    return Object.freeze({ catalogue: Object.freeze(catalogue), authorize: value.authorize, checkout, portal });
}
function normalizePortalDefinition(value, catalogue) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["returnPath", "continuationTtlSeconds"].includes(key)))
        throw invalidDeclaration();
    const returnPath = canonicalReturnPath(value.returnPath);
    const continuationTtlSeconds = value.continuationTtlSeconds ?? CHECKOUT_CONTINUATION_TTL_DEFAULT_SECONDS;
    if (!returnPath || !Number.isInteger(continuationTtlSeconds)
        || continuationTtlSeconds < 60 || continuationTtlSeconds > CHECKOUT_CONTINUATION_TTL_MAX_SECONDS)
        throw invalidDeclaration();
    const configurationPolicies = new Map();
    const configurationModes = new Map();
    for (const product of Object.values(catalogue)) {
        const policy = quantityPolicyFingerprint(product.quantity);
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
    return Object.freeze({ returnPath, continuationTtlSeconds });
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
    if (value.kind === "team-members" && Object.keys(value).length === 1)
        return Object.freeze({ kind: "team-members" });
    if (value.kind === "fixed" && Object.keys(value).sort().join(",") === "kind,value"
        && Number.isSafeInteger(value.value) && value.value >= 1 && value.value <= FIXED_QUANTITY_MAX) {
        return Object.freeze({ kind: "fixed", value: value.value });
    }
    throw invalidDeclaration();
}
function normalizeModeBinding(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["priceId", "productId", "portalConfigurationId"].includes(key))
        || typeof value.priceId !== "string" || !PRICE_ID_PATTERN.test(value.priceId)
        || (value.productId !== undefined && (typeof value.productId !== "string" || !PRODUCT_ID_PATTERN.test(value.productId)))
        || (value.portalConfigurationId !== undefined && (typeof value.portalConfigurationId !== "string" || !PORTAL_CONFIGURATION_ID_PATTERN.test(value.portalConfigurationId))))
        throw invalidDeclaration();
    return Object.freeze({ priceId: value.priceId, ...(value.productId ? { productId: value.productId } : {}), ...(value.portalConfigurationId ? { portalConfigurationId: value.portalConfigurationId } : {}) });
}
function quantityPolicyFingerprint(value) {
    return value.kind === "team-members" ? "team-members" : `fixed:${value.value}`;
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
export async function startTeamBillingCheckout(database, auth, teamId, requestId, productKey) {
    requireAuth({ auth }, { linked: true });
    const definition = database.teamBillingDefinition;
    if (!definition?.checkout || !database.paymentsConfig?.stripe?.enabled
        || !TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? ""))
        || typeof productKey !== "string" || !definition.catalogue[productKey])
        throw teamBillingDenied();
    let enqueued = false;
    const result = await withTeamBillingAdmissionTransaction(database, async (transaction) => {
        await admitTeamBillingActor(database, transaction, auth, { operation: "checkout", teamId, productKey });
        const sql = transaction.dialect.sql;
        const existing = await transaction.prepare(sql("SELECT [requestId], [productKey], [status], [providerObjectId], [continuationUrl], [continuationExpiresAt], [safeFailureCode], [createdAt] " +
            "FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
        if (existing) {
            if (existing.productKey !== productKey)
                throw checkoutConflict();
            return checkoutOperationResult(database, transaction, teamId, requestId, existing);
        }
        const desired = await checkoutDesiredState(database, transaction, teamId, productKey);
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
            "([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity], [continuationUrl], [continuationExpiresAt], [attemptedAt], [providerExpiresAt]) " +
            "VALUES (?, ?, ?, ?, 'checkout', ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)")).run(operationId, requestId, teamId, auth.userId, productKey, idempotencyKey, now, now, desired.mode, desired.quantity, providerExpiresAt);
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
export async function startTeamBillingPortal(database, auth, teamId, requestId) {
    requireAuth({ auth }, { linked: true });
    const definition = database.teamBillingDefinition;
    if (!definition?.portal || !database.paymentsConfig?.stripe?.enabled
        || !TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? "")))
        throw teamBillingDenied();
    let enqueued = false;
    const result = await withTeamBillingAdmissionTransaction(database, async (transaction) => {
        await admitTeamBillingActor(database, transaction, auth, { operation: "portal", teamId });
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
    try {
        providerInput = await database.adapter.withTransaction(async (transaction) => {
            const sql = transaction.dialect.sql;
            const operation = await transaction.prepare(sql("SELECT [id], [teamId], [actorUserId], [productKey], [status], [mode], [quantity], [idempotencyKey], [providerExpiresAt] " +
                "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'checkout'")).get(operationId);
            if (!operation || !["queued", "running", "retrying"].includes(operation.status))
                return null;
            const actor = await transaction.prepare(sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider] FROM [sporades_auth_users] WHERE [id] = ?")).get(operation.actorUserId);
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
            };
            await admitTeamBillingActor(database, transaction, auth, { operation: "checkout", teamId: operation.teamId, productKey: operation.productKey });
            const desired = await checkoutDesiredState(database, transaction, operation.teamId, operation.productKey);
            if (operation.mode !== desired.mode || operation.quantity !== desired.quantity) {
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
            const attemptedAt = database.clock.now().toISOString();
            await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'running', [attemptedAt] = COALESCE([attemptedAt], ?), [updatedAt] = ? WHERE [id] = ?")).run(attemptedAt, attemptedAt, operationId);
            return {
                operationId,
                teamId: operation.teamId,
                productKey: operation.productKey,
                mode: "subscription",
                priceId: desired.priceId,
                quantity: desired.quantity,
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
            return { configurationId: desired.configurationId, mode: desired.mode, expectedProducts: desired.expectedProducts };
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
    const kind = handler === TEAM_BILLING_CHECKOUT_JOB ? "checkout" : handler === TEAM_BILLING_PORTAL_JOB ? "portal" : null;
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
/** Applies only terminal, verified Checkout observations; Subscription truth is a later convergence concern. */
export async function applyVerifiedTeamBillingCheckoutObservation(database, event) {
    if (!database.teamBillingDefinition || event?.provider !== "stripe"
        || !["checkout.session.completed", "checkout.session.expired"].includes(event?.type))
        return { applied: false };
    const object = event?.raw?.data?.object;
    const operationId = object?.client_reference_id;
    if (!object || typeof object !== "object" || Array.isArray(object)
        || object.object !== "checkout.session" || object.mode !== "subscription"
        || object.livemode !== event.livemode || event.objectId !== object.id
        || event.raw?.id !== event.providerEventId || event.raw?.type !== event.type || event.raw?.livemode !== event.livemode
        || !TEAM_ID_PATTERN.test(String(operationId ?? ""))
        || object?.metadata?.sporades_team_billing_operation !== operationId
        || !validCheckoutContinuation(`https://checkout.stripe.com/c/pay/${object.id}`, object.id)
        || typeof event.providerEventId !== "string" || !/^evt_[A-Za-z0-9_]{1,240}$/.test(event.providerEventId)
        || !canonicalTimestamp(event.occurredAt) || typeof event.livemode !== "boolean"
        || event.livemode !== Boolean(database.paymentsConfig?.stripe?.livemode))
        return { applied: false };
    const status = event.type === "checkout.session.completed" ? "completed" : "expired";
    return database.adapter.withTransaction(async (transaction) => {
        const sql = transaction.dialect.sql;
        const operation = await transaction.prepare(sql("SELECT [id], [teamId], [mode], [providerObjectId], [status], [terminalObservedAt] FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'checkout'")).get(operationId);
        const expectedMode = event.livemode ? "live" : "sandbox";
        if (!operation || operation.mode !== expectedMode
            || (operation.providerObjectId && operation.providerObjectId !== object.id))
            return { applied: false };
        const payloadDigest = createHash("sha256").update(JSON.stringify(event.raw)).digest("hex");
        const inserted = await transaction.prepare(sql("INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt]) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT ([providerEventId]) DO NOTHING")).run(randomUUID(), operation.teamId, expectedMode, event.providerEventId, object.id, payloadDigest, event.occurredAt, database.clock.now().toISOString());
        if (Number(inserted?.changes ?? 0) !== 1)
            return { applied: false };
        if (operation.terminalObservedAt && operation.terminalObservedAt > event.occurredAt)
            return { applied: false };
        await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = ?, [providerObjectId] = ?, [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [terminalObservedAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(status, object.id, event.occurredAt, database.clock.now().toISOString(), operationId);
        return { applied: true };
    });
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
    const row = await transaction.prepare(sql("SELECT [mode], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd] " +
        "FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? ORDER BY [observedAt] DESC, [id] DESC LIMIT 1")).get(teamId);
    if (!row)
        return Object.freeze({ state: "inactive", teamId });
    const product = definition.catalogue[row.productKey];
    const binding = (row.mode === "sandbox" || row.mode === "live") ? product?.stripe?.[row.mode] : null;
    const quantity = typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) && row.quantity >= 1
        ? row.quantity : null;
    if (!product || !binding || row.providerPriceId !== binding.priceId
        || quantity === null || (product.quantity.kind === "fixed" && quantity !== product.quantity.value)) {
        return Object.freeze({ state: "attention-required", teamId, reason: "catalogue-mismatch" });
    }
    if (row.cancelAtPeriodEnd !== 0 && row.cancelAtPeriodEnd !== 1) {
        return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
    }
    const common = { teamId, productKey: row.productKey, quantity };
    if (row.state === "active") {
        const currentPeriodEnd = canonicalTimestamp(row.currentPeriodEnd);
        if (!currentPeriodEnd) {
            return Object.freeze({ state: "attention-required", teamId, reason: "provider-state-ambiguous" });
        }
        return Object.freeze(row.cancelAtPeriodEnd === 1
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
async function checkoutDesiredState(database, transaction, teamId, productKey) {
    const product = database.teamBillingDefinition.catalogue[productKey];
    const mode = database.paymentsConfig.stripe.livemode ? "live" : "sandbox";
    const quantity = product.quantity.kind === "fixed"
        ? product.quantity.value
        : Number((await transaction.prepare(transaction.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(teamId))?.count ?? 0);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > FIXED_QUANTITY_MAX)
        throw checkoutUnavailable();
    return { mode, quantity, priceId: product.stripe[mode].priceId };
}
async function portalDesiredState(database, transaction, teamId) {
    const sql = transaction.dialect.sql;
    const mode = database.paymentsConfig.stripe.livemode ? "live" : "sandbox";
    const customer = await transaction.prepare(sql("SELECT [mode], [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).get(teamId);
    const subscriptions = await transaction.prepare(sql("SELECT [mode], [providerPriceId], [productKey], [quantity], [state] FROM [sporades_team_billing_subscriptions] " +
        "WHERE [teamId] = ? AND [state] IN ('active', 'cancelling', 'past-due') ORDER BY [observedAt] DESC, [id] DESC")).all(teamId);
    const subscription = subscriptions.length === 1 ? subscriptions[0] : null;
    const product = database.teamBillingDefinition.catalogue[subscription?.productKey];
    const binding = product?.stripe?.[mode];
    const expectedQuantity = product?.quantity?.kind === "fixed"
        ? product.quantity.value
        : Number((await transaction.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(teamId))?.count ?? 0);
    if (!customer || customer.mode !== mode || !/^cus_[A-Za-z0-9_]{1,120}$/.test(String(customer.providerCustomerId ?? ""))
        || !subscription || subscription.mode !== mode || !["active", "cancelling", "past-due"].includes(subscription.state)
        || !binding?.productId || !binding?.portalConfigurationId || subscription.providerPriceId !== binding.priceId
        || !Number.isSafeInteger(subscription.quantity) || subscription.quantity !== expectedQuantity)
        throw checkoutUnavailable();
    const grouped = new Map();
    for (const candidate of Object.values(database.teamBillingDefinition.catalogue)) {
        const candidateBinding = candidate.stripe[mode];
        if (candidateBinding.portalConfigurationId !== binding.portalConfigurationId)
            continue;
        const prices = grouped.get(candidateBinding.productId) ?? new Set();
        prices.add(candidateBinding.priceId);
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
    };
}
async function readPortalOperation(transaction, operationId) {
    return transaction.prepare(transaction.dialect.sql("SELECT [id], [teamId], [actorUserId], [productKey], [status], [mode], [quantity], [idempotencyKey], [providerCustomerId], [configurationId], [returnPath] " +
        "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'portal'")).get(operationId);
}
async function reauthorizePortalOperation(database, transaction, operation) {
    const actor = await transaction.prepare(transaction.dialect.sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider] FROM [sporades_auth_users] WHERE [id] = ?")).get(operation.actorUserId);
    if (!actor)
        throw teamBillingDenied();
    const auth = { userId: actor.id, displayName: actor.displayName, email: actor.email, picture: actor.picture,
        isAuthenticated: Boolean(actor.isAuthenticated), isGuest: Boolean(actor.isGuest), provider: actor.provider };
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
        return url.protocol === "https:" && url.hostname === "billing.stripe.com"
            && /^\/p\/session\/[A-Za-z0-9_\-]{8,512}$/.test(url.pathname)
            && !url.username && !url.password && !url.port && !url.search;
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
export function teamBillingDenied() {
    return commandError("Team Billing is unavailable.", "Sign in as the current policy-approved billing administrator for this Team and retry.", "TEAM_BILLING_DENIED");
}
//# sourceMappingURL=team-billing-runtime.js.map