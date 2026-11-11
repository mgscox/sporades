import { assertCurrencyHandoverInactive } from "./team-billing-currency-handover.js";
import { PRIVILEGED_AUTH_USER_ID } from "./auth-runtime.js";
import { billingCurrencyAmount, billingCurrencyMismatch } from "./team-billing-prices.js";
// Desired-state controller for managed Team Billing changes. Membership and
// browser mutations only stage durable intent; provider I/O runs later in a
// serialized lane and verified Stripe observations are the only settlement.
import { createHash, randomUUID } from "node:crypto";
import { teamBillingIntervalEnd, teamBillingTransitionRefusal } from "./team-billing-subscription-semantics.js";
import { validTeamBillingHostedInvoiceUrl } from "./team-billing-payment-action.js";
import { lockTeamLifecycle } from "./teams-runtime.js";
import { assertTeamBillingErasureInactive, teamBillingPrice, teamBillingPriceById } from "./team-billing-runtime.js";
import { readTeamBillingQuantity, readTeamBillingUsageCount, teamBillingQuantityPolicyFingerprint } from "./team-billing-quantity.js";
export const TEAM_BILLING_PLAN_PREVIEW_JOB = "_sporades.team-billing-plan-preview";
export const TEAM_BILLING_PLAN_PREVIEW_EXPIRY_JOB = "_sporades.team-billing-plan-preview-expiry";
const QUOTE_TTL_MS = 5 * 60 * 1_000;
const PREVIEW_EXPIRY_KEY_PREFIX = "team-billing-preview-expiry:";
const LIVE_PREVIEW_QUOTE = "EXISTS (SELECT 1 FROM [sporades_team_billing_quotes] WHERE [operationId] = [sporades_team_billing_operations].[id] AND [expiresAt] > ? AND [consumedBy] IS NULL)";
export const TEAM_BILLING_PLAN_TRANSITION_JOB = "_sporades.team-billing-plan-transition";
export const TEAM_BILLING_SEAT_CONVERGENCE_JOB = "_sporades.team-billing-seat-convergence";
const CLAIM_TTL_MS = 5 * 60 * 1_000;
const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Preview is an ordinary durable short Job; polling never performs provider I/O. */
export async function previewTeamBillingPlanTransition(database, auth, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["teamId", "requestId", "productKey", "interval"].includes(key))
        || !TEAM_ID_PATTERN.test(input.teamId) || !TEAM_ID_PATTERN.test(input.requestId)
        || typeof input.productKey !== "string")
        throw denied();
    const { teamId, requestId, productKey, interval } = input;
    const product = database.teamBillingDefinition?.catalogue?.[productKey];
    const price = product && teamBillingPrice(modeBinding(database, product), interval);
    if (!price)
        throw denied();
    let enqueued = false;
    const result = await inTransaction(database, async (transaction) => {
        await admitPlanTransition(database, transaction, auth, teamId, productKey, price.interval);
        await assertTeamBillingErasureInactive(database, transaction, teamId);
        await assertCurrencyHandoverInactive(transaction, teamId);
        const repeated = await transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
        if (repeated) {
            if (repeated.kind !== "plan-preview" || repeated.actorUserId !== auth.userId || repeated.productKey !== productKey
                || repeated.providerPriceId !== price.priceId)
                throw conflict();
            const quote = await readQuote(transaction, repeated.id);
            const now = nowIso(database);
            if (repeated.status === "expired" || !quote || quote.expiresAt <= now) {
                await expirePlanPreview(transaction, repeated.id, now);
                return Object.freeze({ state: "expired", teamId, requestId, productKey });
            }
            if (repeated.status === "superseded")
                throw invalidQuote();
            if (repeated.status === "ready") {
                const resolved = await resolvePlanTarget(database, transaction, teamId, productKey, price, false, undefined, JSON.parse(quote.snapshot).effectiveAt);
                if (quote.consumedBy || quote.snapshot !== JSON.stringify(resolved))
                    throw invalidQuote();
                return Object.freeze({ state: "ready", teamId, requestId, productKey, quoteId: repeated.id,
                    timing: "now", ...publicQuote(JSON.parse(quote.result)), expiresAt: quote.expiresAt });
            }
            return Object.freeze({ state: repeated.status === "failed" ? "failed" : "pending", teamId, requestId, productKey });
        }
        const resolved = await resolvePlanTarget(database, transaction, teamId, productKey, price, false);
        const operationId = randomUUID();
        const now = nowIso(database);
        const expiresAt = new Date(database.clock.now().getTime() + QUOTE_TTL_MS).toISOString();
        await transaction.prepare(transaction.dialect.sql("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [idempotencyKey], [createdAt], [updatedAt], [providerPriceId]) " +
            "VALUES (?, ?, ?, ?, 'plan-preview', ?, 'queued', ?, ?, ?, ?)")).run(operationId, requestId, teamId, auth.userId, productKey, operationIdempotency(database, operationId), now, now, price.priceId);
        await transaction.prepare(transaction.dialect.sql("INSERT INTO [sporades_team_billing_quotes] ([operationId], [teamId], [snapshot], [expiresAt]) VALUES (?, ?, ?, ?)")).run(operationId, teamId, JSON.stringify(resolved), expiresAt);
        await database.enqueueTeamBillingPlanPreviewJob(transaction, { operationId }, `team-billing-preview:${operationId}`);
        await database.enqueueTeamBillingPlanPreviewExpiryJob(transaction, { operationId }, PREVIEW_EXPIRY_KEY_PREFIX + operationId, expiresAt);
        enqueued = true;
        return Object.freeze({ state: "pending", teamId, requestId, productKey });
    });
    if (enqueued)
        scheduleAfterOwnedTransaction(database);
    return result;
}
export async function expireTeamBillingPlanPreview(database, _context, payload) {
    if (!payload || Object.keys(payload).join() !== "operationId" || !TEAM_ID_PATTERN.test(payload.operationId))
        throw denied();
    await inTransaction(database, transaction => expirePlanPreview(transaction, payload.operationId, nowIso(database)));
    return null;
}
async function expirePlanPreview(transaction, operationId, now) {
    await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired', [updatedAt] = ? " +
        "WHERE [id] = ? AND [kind] = 'plan-preview' AND [status] IN ('queued', 'running', 'retrying', 'ready') " +
        "AND EXISTS (SELECT 1 FROM [sporades_team_billing_quotes] WHERE [operationId] = ? AND [expiresAt] <= ?)")).run(now, operationId, operationId, now);
    // A confirmed transition still needs its quote for dispatch and recovery.
    await transaction.prepare(transaction.dialect.sql("DELETE FROM [sporades_team_billing_quotes] WHERE [operationId] = ? AND [expiresAt] <= ? AND [consumedBy] IS NULL")).run(operationId, now);
}
/** Recover previews written before expiry Jobs were scheduled, or left overdue at shutdown. */
export async function repairTeamBillingPlanPreviewExpiries(database) {
    const { adapter } = database;
    const candidates = await adapter.prepare(adapter.dialect.sql("SELECT [o].[id] FROM [sporades_team_billing_operations] [o] JOIN [sporades_team_billing_quotes] [q] ON [q].[operationId] = [o].[id] " +
        "WHERE [o].[kind] = 'plan-preview' AND (([q].[consumedBy] IS NOT NULL AND [o].[status] = 'ready') " +
        "OR ([q].[consumedBy] IS NULL AND ([q].[expiresAt] <= ? OR NOT EXISTS (SELECT 1 FROM [sporades_jobs] " +
        "WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ? || [o].[id]))))")).all(nowIso(database), TEAM_BILLING_PLAN_PREVIEW_EXPIRY_JOB, PRIVILEGED_AUTH_USER_ID, PREVIEW_EXPIRY_KEY_PREFIX);
    for (const { id } of candidates)
        await inTransaction(database, async (transaction) => {
            const sql = transaction.dialect.sql;
            // Serialize repair for this operation across runtimes before checking for its Job again.
            const locked = await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [updatedAt] = [updatedAt] WHERE [id] = ? AND [kind] = 'plan-preview'")).run(id);
            if (Number(locked.changes ?? locked.changesCount) !== 1)
                return;
            const quote = await readQuote(transaction, id);
            if (!quote)
                return;
            const now = nowIso(database);
            if (quote.consumedBy) {
                await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? WHERE [id] = ? AND [status] = 'ready'")).run(now, id);
                return;
            }
            if (quote.expiresAt <= now)
                return expirePlanPreview(transaction, id, now);
            const key = PREVIEW_EXPIRY_KEY_PREFIX + id;
            const job = await transaction.prepare(sql("SELECT [id] FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?"))
                .get(TEAM_BILLING_PLAN_PREVIEW_EXPIRY_JOB, PRIVILEGED_AUTH_USER_ID, key);
            if (!job)
                await database.enqueueTeamBillingPlanPreviewExpiryJob(transaction, { operationId: id }, key, quote.expiresAt);
        });
}
export async function performTeamBillingPlanPreview(database, context, payload, attempt = 1) {
    if (!payload || Object.keys(payload).join() !== "operationId" || !TEAM_ID_PATTERN.test(payload.operationId))
        throw denied();
    const token = randomUUID();
    let teamId;
    let laneClaimed = false;
    try {
        const input = await inTransaction(database, async (transaction) => {
            const operation = await transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'plan-preview'")).get(payload.operationId);
            if (!operation || !["queued", "running", "retrying"].includes(operation.status))
                return null;
            teamId = operation.teamId;
            const auth = await database.readTeamBillingActorAuth(transaction, operation.actorUserId);
            const quote = await readQuote(transaction, operation.id);
            const now = nowIso(database);
            if (quote && quote.expiresAt <= now) {
                await expirePlanPreview(transaction, operation.id, now);
                return null;
            }
            const snapshot = quote && JSON.parse(quote.snapshot);
            const product = database.teamBillingDefinition?.catalogue?.[operation.productKey];
            const price = product && teamBillingPriceById(modeBinding(database, product), operation.providerPriceId);
            if (!snapshot || !price)
                throw invalidQuote();
            await admitPlanTransition(database, transaction, auth, operation.teamId, operation.productKey, price.interval);
            const resolved = await resolvePlanTarget(database, transaction, operation.teamId, operation.productKey, price, false, undefined, snapshot.effectiveAt);
            if (quote.snapshot !== JSON.stringify(resolved))
                throw invalidQuote();
            const customer = await transaction.prepare(transaction.dialect.sql("SELECT [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ? AND [mode] = ?")).get(teamId, snapshot.subscription.mode);
            if (!customer)
                throw attentionRequired();
            if (!await claimLane(transaction, operation.teamId, token, database))
                throw retryable("TEAM_BILLING_PROVIDER_LANE_BUSY");
            const dispatchAt = nowIso(database);
            const dispatched = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'running', [updatedAt] = ? " +
                "WHERE [id] = ? AND [status] IN ('queued', 'running', 'retrying') AND " + LIVE_PREVIEW_QUOTE)).run(dispatchAt, operation.id, dispatchAt);
            if (Number(dispatched.changes ?? dispatched.changesCount) !== 1) {
                await releaseLane(transaction, operation.teamId, token, database);
                await expirePlanPreview(transaction, operation.id, dispatchAt);
                return null;
            }
            return {
                mode: snapshot.subscription.mode, customerId: customer.providerCustomerId,
                subscriptionId: snapshot.subscription.providerSubscriptionId, subscriptionItemId: snapshot.subscription.providerSubscriptionItemId,
                sourcePriceId: snapshot.subscription.providerPriceId, targetPriceId: price.priceId,
                targetProductId: modeBinding(database, product).productId, targetQuantity: snapshot.quantity,
                ...(snapshot.subscription.currency ? { currency: snapshot.subscription.currency } : {}),
                prorationDate: snapshot.effectiveAt, resetBillingCycle: snapshot.resetBillingCycle === 1,
                endTrial: snapshot.endTrial, preserveTrial: snapshot.preserveTrial,
                operationKind: "plan-transition", idempotencyKey: operation.idempotencyKey,
            };
        });
        if (!input)
            return { superseded: true };
        laneClaimed = true;
        const provider = database.createStripeTeamBillingProvider({
            enabled: true, config: database.paymentsConfig.stripe, env: database.serverEnv, signal: context?.signal,
            ...(database.stripeApiBaseUrl ? { apiBaseUrl: database.stripeApiBaseUrl } : {}),
        });
        const result = await provider.previewManagedSubscription(input);
        // Only the bounded normalized quote is retained, never an Invoice object.
        if (!validQuote(result))
            throw coded("Team Billing quote unavailable.", "TEAM_BILLING_PROVIDER_REJECTED");
        const ready = await inTransaction(database, async (transaction) => {
            if (!await releaseLane(transaction, teamId, token, database))
                throw invalidQuote();
            const now = nowIso(database);
            const published = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'ready', [updatedAt] = ? " +
                "WHERE [id] = ? AND [status] = 'running' AND " + LIVE_PREVIEW_QUOTE)).run(now, payload.operationId, now);
            if (Number(published.changes ?? published.changesCount) !== 1) {
                await expirePlanPreview(transaction, payload.operationId, now);
                return false;
            }
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_quotes] SET [result] = ? WHERE [operationId] = ?")).run(JSON.stringify(result), payload.operationId);
            return true;
        });
        return ready ? { ready: true } : { superseded: true };
    }
    catch (error) {
        const retry = (error?.retryable === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") && attempt < 3;
        await inTransaction(database, async (transaction) => {
            if (teamId && laneClaimed && !await releaseLane(transaction, teamId, token, database))
                return;
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = ?, [safeFailureCode] = 'PREVIEW_UNAVAILABLE', [updatedAt] = ? WHERE [id] = ? AND [status] IN ('queued', 'running', 'retrying')")).run(retry ? "retrying" : "failed", nowIso(database), payload.operationId);
        });
        error.retryable = retry;
        throw error;
    }
}
async function resolvePlanTarget(database, transaction, teamId, productKey, price, resume = false, currency, effectiveAt = nowSeconds(database)) {
    await assertTeamBillingErasureInactive(database, transaction, teamId);
    await assertCurrencyHandoverInactive(transaction, teamId);
    const subscription = await currentSubscription(transaction, teamId);
    const refusal = transitionRefusal(subscription, resume);
    if (refusal)
        throw coded("Team Billing plan transition is unavailable in the current subscription state.", refusal);
    const definition = database.teamBillingDefinition;
    const currentProduct = definition.catalogue[subscription.productKey];
    const targetProduct = definition.catalogue[productKey];
    assertCurrentModeAndCatalogue(database, subscription, currentProduct);
    if ((currency !== undefined && currency !== subscription.currency)
        || ((price.currency || teamBillingPriceById(modeBinding(database, currentProduct), subscription.providerPriceId)?.currency)
            && billingCurrencyAmount(price, subscription.currency) === undefined))
        throw billingCurrencyMismatch();
    if (!managedTransitionAllowed(database, subscription, targetProduct, price))
        throw transitionNotRequired();
    const quantity = await targetQuantity(database, transaction, teamId, targetProduct);
    assertUsageMaximum(targetProduct, quantity);
    const currentInterval = teamBillingPriceById(modeBinding(database, currentProduct), subscription.providerPriceId)?.interval;
    return { subscription, quantity, effectiveAt, currentProduct, targetProduct,
        endTrial: subscription.state === "trialing" && definition.transitions?.endTrial === true,
        preserveTrial: subscription.state === "trialing" && definition.transitions?.endTrial !== true,
        resetBillingCycle: subscription.state !== "trialing" && longerInterval(currentInterval, price.interval, effectiveAt) ? 1 : 0 };
}
async function readQuote(transaction, quoteId) {
    return transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_quotes] WHERE [operationId] = ?")).get(quoteId);
}
async function quoteForConfirmation(database, transaction, auth, teamId, productKey, price, resume, quoteId) {
    if (typeof quoteId !== "string" || !TEAM_ID_PATTERN.test(quoteId) || resume === true)
        throw invalidQuote();
    const operation = await transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'plan-preview'")).get(quoteId);
    const quote = operation && await readQuote(transaction, quoteId);
    if (!quote || operation.teamId !== teamId || operation.actorUserId !== auth.userId || operation.productKey !== productKey
        || operation.providerPriceId !== price.priceId || operation.status !== "ready" || quote.consumedBy
        || quote.expiresAt <= nowIso(database) || !validQuote(JSON.parse(quote.result)))
        throw invalidQuote();
    const desired = await desiredForTeam(transaction, teamId);
    if (desired && ["queued", "running", "awaiting-observation"].includes(desired.status))
        throw invalidQuote();
    return quote;
}
function publicQuote(quote) {
    return { currency: quote.currency, amountDueNow: quote.amountDueNow, nextInvoiceAmount: quote.nextInvoiceAmount,
        nextInvoiceAt: quote.nextInvoiceAt, creditCarriedForward: quote.creditCarriedForward };
}
function validQuote(quote) {
    return quote && typeof quote === "object" && !Array.isArray(quote)
        && Object.keys(quote).sort().join() === "amountDueNow,creditCarriedForward,currency,nextInvoiceAmount,nextInvoiceAt,sourceFingerprint"
        && /^[a-z]{3}$/.test(quote.currency) && /^[a-f0-9]{64}$/.test(quote.sourceFingerprint)
        && [quote.amountDueNow, quote.nextInvoiceAmount, quote.creditCarriedForward].every(amount => Number.isSafeInteger(amount) && amount >= 0)
        && typeof quote.nextInvoiceAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(quote.nextInvoiceAt)
        && Number.isFinite(Date.parse(quote.nextInvoiceAt));
}
function invalidQuote() { return coded("Team Billing quote is unavailable. Request a fresh preview.", "TEAM_BILLING_QUOTE_INVALID"); }
export async function requestTeamBillingPlanTransition(database, auth, teamId, requestId, productKey, interval, resume, currency, quoteId) {
    // Callers that predate the `resume` parameter pass the selected currency positionally.
    if (typeof resume === "string") {
        currency = resume;
        resume = undefined;
    }
    const definition = database.teamBillingDefinition;
    if (!TEAM_ID_PATTERN.test(String(teamId ?? "")) || !TEAM_ID_PATTERN.test(String(requestId ?? ""))
        || typeof productKey !== "string" || !definition?.catalogue?.[productKey]
        || (resume !== undefined && typeof resume !== "boolean"))
        throw denied();
    const price = teamBillingPrice(modeBinding(database, definition.catalogue[productKey]), interval);
    if (!price)
        throw denied();
    let enqueued = false;
    const result = await inTransaction(database, async (transaction) => {
        await admitPlanTransition(database, transaction, auth, teamId, productKey, price.interval);
        await assertTeamBillingErasureInactive(database, transaction, teamId);
        await assertCurrencyHandoverInactive(transaction, teamId);
        const sql = transaction.dialect.sql;
        const repeated = await transaction.prepare(sql("SELECT [id], [kind], [productKey], [providerPriceId], [currency], [status], [safeFailureCode], [createdAt], [paymentActionUrl], [paymentActionExpiresAt], [quoteId], [actorUserId] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId);
        if (repeated) {
            if ((repeated.quoteId ?? undefined) !== quoteId || (quoteId !== undefined && repeated.actorUserId !== auth.userId))
                throw invalidQuote();
            if (currency !== undefined && currency !== repeated.currency)
                throw billingCurrencyMismatch();
            if (repeated.kind !== "plan-transition" || repeated.productKey !== productKey || (repeated.providerPriceId ?? null) !== (price.interval ? price.priceId : null))
                throw conflict();
            return planOperationResult(database, teamId, requestId, productKey, repeated);
        }
        const quote = quoteId === undefined ? null : await quoteForConfirmation(database, transaction, auth, teamId, productKey, price, resume, quoteId);
        const effectiveAt = quote ? JSON.parse(quote.snapshot).effectiveAt : nowSeconds(database);
        const resolved = await resolvePlanTarget(database, transaction, teamId, productKey, price, resume === true, currency, effectiveAt);
        const { subscription, quantity, endTrial, preserveTrial, resetBillingCycle } = resolved;
        if (quote && quote.snapshot !== JSON.stringify(resolved))
            throw invalidQuote();
        const operationId = randomUUID();
        const now = nowIso(database);
        const staged = await stageDesired(transaction, database, {
            teamId, kind: "plan-transition", operationId, endTrial, preserveTrial, resetBillingCycle,
            targetProductKey: productKey, targetPriceId: price.interval ? price.priceId : null,
            targetQuantity: quantity, effectiveAt, resume: resume === true ? 1 : 0,
        }, quote !== null);
        if (quote) {
            const consumedAt = nowIso(database);
            const retired = await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? " +
                "WHERE [id] = ? AND [kind] = 'plan-preview' AND [status] = 'ready' AND " + LIVE_PREVIEW_QUOTE)).run(consumedAt, quoteId, consumedAt);
            if (Number(retired.changes ?? retired.changesCount) !== 1)
                throw invalidQuote();
            await transaction.prepare(sql("UPDATE [sporades_team_billing_quotes] SET [consumedBy] = ? WHERE [operationId] = ? AND [consumedBy] IS NULL")).run(operationId, quoteId);
        }
        await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'superseded', [updatedAt] = ? " +
            "WHERE [teamId] = ? AND [kind] = 'plan-transition' AND [status] IN ('queued', 'running', 'awaiting-observation')")).run(now, teamId);
        await transaction.prepare(sql("INSERT INTO [sporades_team_billing_operations] " +
            "([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity], [providerPriceId], [currency], [quoteId]) " +
            "VALUES (?, ?, ?, ?, 'plan-transition', ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)")).run(operationId, requestId, teamId, auth.userId, productKey, operationIdempotency(database, operationId), now, now, subscription.mode, quantity, price.interval ? price.priceId : null, subscription.currency ?? null, quoteId ?? null);
        await enqueueIntent(database, transaction, staged);
        enqueued = true;
        return Object.freeze({ state: "pending", teamId, requestId, productKey, requestedAt: now });
    });
    if (enqueued)
        scheduleAfterOwnedTransaction(database);
    return result;
}
/** Called after a membership transaction commits. It performs no provider I/O. */
export async function stageTeamBillingMembershipChange(database, teamId, effectiveAt = nowSeconds(database)) {
    return stageTeamBillingCountChange(database, teamId, effectiveAt, "team-members");
}
async function stageTeamBillingCountChange(database, teamId, effectiveAt, quantityKind, force = false) {
    if (!TEAM_ID_PATTERN.test(String(teamId ?? "")) || !Number.isSafeInteger(effectiveAt) || effectiveAt < 0)
        return { staged: false };
    let enqueued = false;
    const result = await inTransaction(database, async (transaction) => {
        if (quantityKind === "usage")
            await lockTeamLifecycle(transaction, teamId, denied);
        try {
            await assertTeamBillingErasureInactive(database, transaction, teamId);
            await assertCurrencyHandoverInactive(transaction, teamId);
        }
        catch {
            return Object.freeze({ staged: false, reason: "erasure-active" });
        }
        const subscription = await optionalCurrentSubscription(transaction, teamId);
        if (!subscription || !["trialing", "active", "past-due"].includes(subscription.state))
            return Object.freeze({ staged: false });
        const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
        if (product?.quantity?.kind !== quantityKind)
            return Object.freeze({ staged: false });
        const quantity = await targetQuantity(database, transaction, teamId, product);
        const existing = await desiredForTeam(transaction, teamId);
        if (existing?.kind === "plan-transition" && (!force || existing.status !== "awaiting-observation"))
            return Object.freeze({ staged: false, reason: "plan-transition-active" });
        if (!force && !existing && subscription.quantity === quantity)
            return Object.freeze({ staged: false });
        const staged = await stageDesired(transaction, database, existing?.kind === "plan-transition" ? {
            teamId, kind: existing.kind, operationId: existing.operationId, targetProductKey: existing.targetProductKey,
            endTrial: existing.endTrial, preserveTrial: existing.preserveTrial, targetPriceId: existing.targetPriceId, targetQuantity: Number(existing.targetQuantity), effectiveAt, resume: existing.resume,
        } : {
            teamId, kind: "seat-convergence", operationId: null, targetProductKey: subscription.productKey,
            targetQuantity: quantity, effectiveAt,
        }, force);
        let generationId = staged.activeJobGenerationId ?? null;
        if (staged.enqueue) {
            generationId = await enqueueIntent(database, transaction, staged);
            enqueued = true;
        }
        return Object.freeze({ staged: true, intentId: staged.intentId, generationId, quantity });
    });
    if (enqueued)
        scheduleAfterOwnedTransaction(database);
    return result;
}
/** Repair only an already-associated usage Subscription; quarantined evidence grants no entitlement. */
export async function stageTeamBillingUsageRepair(database, teamId) {
    return stageTeamBillingCountChange(database, teamId, nowSeconds(database), "usage", true);
}
/** Only an acknowledged durable Plan target authorizes repair at a different usage Price. */
export async function stageAcknowledgedTeamBillingUsageTransitionRepair(database, teamId, productKey) {
    let enqueued = false;
    const result = await inTransaction(database, async (transaction) => {
        await lockTeamLifecycle(transaction, teamId, denied);
        const desired = await desiredForTeam(transaction, teamId);
        if (desired?.kind !== "plan-transition" || desired.status !== "awaiting-observation"
            || desired.targetProductKey !== productKey
            || database.teamBillingDefinition?.catalogue?.[productKey]?.quantity?.kind !== "usage")
            return { staged: false };
        await assertTeamBillingErasureInactive(database, transaction, teamId);
        await assertCurrencyHandoverInactive(transaction, teamId);
        const replacement = await stageDesired(transaction, database, {
            teamId, kind: desired.kind, operationId: desired.operationId, targetProductKey: productKey,
            endTrial: desired.endTrial, preserveTrial: desired.preserveTrial, targetPriceId: desired.targetPriceId, targetQuantity: Number(desired.targetQuantity), effectiveAt: nowSeconds(database), resume: desired.resume,
        }, true);
        await enqueueIntent(database, transaction, replacement);
        enqueued = true;
        return { staged: true };
    });
    if (enqueued)
        scheduleAfterOwnedTransaction(database);
    return result;
}
/** Called only after lifecycle admission, before the Capsule's resource reads/writes. */
export async function prepareTeamBillingUsageChange(database, teamId) {
    const transaction = database.adapter;
    const subscription = await optionalCurrentSubscription(transaction, teamId);
    const product = database.teamBillingDefinition?.catalogue?.[subscription?.productKey];
    if (product?.quantity?.kind !== "usage")
        return undefined;
    const before = await readTeamBillingUsageCount(database, transaction, teamId, product.quantity);
    return async () => {
        const after = await readTeamBillingUsageCount(database, transaction, teamId, product.quantity);
        if (after > before)
            assertUsageMaximum(product, after);
        await stageTeamBillingCountChange(database, teamId, nowSeconds(database), "usage");
    };
}
function assertUsageMaximum(product, quantity) {
    if (product.quantity.kind === "usage" && quantity > (product.quantity.maximum ?? 999_999))
        throw denied();
}
function isCountedProduct(product) {
    return product?.quantity?.kind === "team-members" || product?.quantity?.kind === "usage";
}
export async function performTeamBillingPlanTransition(database, context, payload) {
    return performDesired(database, context, payload, "plan-transition");
}
export async function performTeamBillingSeatConvergence(database, context, payload) {
    return performDesired(database, context, payload, "seat-convergence");
}
async function performDesired(database, _context, payload, kind) {
    if (typeof payload?.intentId !== "string" || typeof payload?.generationId !== "string")
        return { superseded: true };
    const claimToken = randomUUID();
    const snapshot = await inTransaction(database, async (transaction) => {
        const desired = await desiredByIntent(transaction, payload.intentId);
        if (!desired || desired.kind !== kind || desired.activeJobGenerationId !== payload.generationId
            || !["queued", "running", "awaiting-observation"].includes(desired.status))
            return { superseded: true };
        await lockTeamLifecycle(transaction, desired.teamId, denied);
        await assertCurrencyHandoverInactive(transaction, desired.teamId);
        const subscription = await currentSubscription(transaction, desired.teamId);
        const quoteId = desired.operationId && (await transaction.prepare(transaction.dialect.sql("SELECT [quoteId] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(desired.operationId))?.quoteId;
        const quote = quoteId ? await readQuote(transaction, quoteId) : null;
        const product = database.teamBillingDefinition?.catalogue?.[desired.targetProductKey];
        if (!product)
            return attention(transaction, database, desired, "CATALOGUE_MISMATCH");
        try {
            assertCurrentModeAndCatalogue(database, subscription, database.teamBillingDefinition?.catalogue?.[subscription.productKey]);
        }
        catch {
            return attention(transaction, database, desired, "PROVIDER_STATE_AMBIGUOUS");
        }
        const binding = modeBinding(database, product);
        const price = desired.targetPriceId ? teamBillingPriceById(binding, desired.targetPriceId) : teamBillingPrice(binding, undefined);
        if (!price)
            return attention(transaction, database, desired, "CATALOGUE_MISMATCH");
        if ((price.currency || teamBillingPriceById(modeBinding(database, database.teamBillingDefinition.catalogue[subscription.productKey]), subscription.providerPriceId)?.currency)
            && billingCurrencyAmount(price, subscription.currency) === undefined)
            return attention(transaction, database, desired, "CURRENCY_MISMATCH");
        if (kind === "plan-transition") {
            const refusal = transitionRefusal(subscription, desired.resume === 1);
            if (refusal) {
                return attention(transaction, database, desired, refusal);
            }
            // Verified target usage can still drift after a cross-policy or interval switch.
            const repairsUsageQuantity = product.quantity.kind === "usage"
                && subscription.productKey === desired.targetProductKey && subscription.providerPriceId === price.priceId;
            if (!repairsUsageQuantity && !managedTransitionAllowed(database, subscription, product, price)) {
                return attention(transaction, database, desired, "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED");
            }
            const auth = await database.readTeamBillingActorAuth?.(transaction, await actorForOperation(transaction, desired.operationId));
            const admission = await tryAdmitPlanTransition(database, transaction, auth, desired.teamId, desired.targetProductKey, price.interval);
            if (!admission)
                return attention(transaction, database, desired, "AUTHORITY_CHANGED", true);
            const billableQuantity = await targetQuantity(database, transaction, desired.teamId, product);
            assertUsageMaximum(product, billableQuantity);
            if (quoteId && (!quote || quote.consumedBy !== desired.operationId
                || (!desired.providerAttemptedAt && (quote.expiresAt <= nowIso(database)
                    || quote.snapshot !== JSON.stringify(await resolvePlanTarget(database, transaction, desired.teamId, desired.targetProductKey, price, false, undefined, Number(desired.effectiveAt))))))) {
                return attention(transaction, database, desired, "TEAM_BILLING_QUOTE_INVALID");
            }
            // Resolve an attempted interval or trial change with its original tuple first.
            // Verified evidence then stages seats against the applied period.
            if (!quote && billableQuantity !== Number(desired.targetQuantity)
                && !((desired.resetBillingCycle === 1 || desired.endTrial === 1 || desired.preserveTrial === 1) && desired.providerAttemptedAt)) {
                const replacement = await stageDesired(transaction, database, {
                    teamId: desired.teamId, kind, operationId: desired.operationId, targetProductKey: desired.targetProductKey,
                    endTrial: desired.endTrial, preserveTrial: desired.preserveTrial, targetPriceId: desired.targetPriceId, targetQuantity: billableQuantity, effectiveAt: nowSeconds(database), resume: desired.resume,
                    resetBillingCycle: subscription.state !== "trialing" && longerInterval(teamBillingPriceById(modeBinding(database, database.teamBillingDefinition.catalogue[subscription.productKey]), subscription.providerPriceId)?.interval, price.interval, nowSeconds(database)) ? 1 : 0,
                });
                await enqueueIntent(database, transaction, replacement);
                return { superseded: true, dispatch: true };
            }
        }
        else {
            if (!["trialing", "active", "past-due"].includes(subscription.state))
                return attention(transaction, database, desired, "PROVIDER_STATE_AMBIGUOUS");
            const targetProductKey = subscription.productKey;
            const currentProduct = database.teamBillingDefinition?.catalogue?.[targetProductKey];
            if (!isCountedProduct(currentProduct))
                return { superseded: true };
            const billableQuantity = await targetQuantity(database, transaction, desired.teamId, currentProduct);
            if (billableQuantity !== Number(desired.targetQuantity) || subscription.productKey !== desired.targetProductKey
                || (binding.prices && subscription.providerPriceId !== desired.targetPriceId)) {
                const replacement = await stageDesired(transaction, database, {
                    teamId: desired.teamId, kind, operationId: null, targetProductKey, targetQuantity: billableQuantity, effectiveAt: nowSeconds(database),
                });
                await enqueueIntent(database, transaction, replacement);
                return { superseded: true, dispatch: true };
            }
        }
        const customer = await transaction.prepare(transaction.dialect.sql("SELECT [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ? AND [mode] = ?")).get(desired.teamId, subscription.mode);
        if (!customer?.providerCustomerId)
            return attention(transaction, database, desired, "PROVIDER_STATE_AMBIGUOUS");
        const claimed = await claimLane(transaction, desired.teamId, claimToken, database);
        if (!claimed)
            throw retryable("TEAM_BILLING_PROVIDER_LANE_BUSY");
        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'running', [providerAttemptedAt] = COALESCE([providerAttemptedAt], ?), [safeFailureCode] = NULL, [updatedAt] = ? WHERE [intentId] = ?")).run(nowIso(database), nowIso(database), desired.intentId);
        return {
            desired: { ...desired },
            provider: {
                teamId: desired.teamId,
                mode: subscription.mode,
                providerCustomerId: customer.providerCustomerId,
                providerSubscriptionId: subscription.providerSubscriptionId,
                providerSubscriptionItemId: subscription.providerSubscriptionItemId,
                sourcePriceId: subscription.providerPriceId,
                ...(subscription.currency ? { currency: subscription.currency } : {}),
                targetPriceId: price.priceId,
                ...(binding.productId ? { targetProductId: binding.productId } : {}),
                targetProductKey: desired.targetProductKey,
                targetQuantity: Number(desired.targetQuantity),
                effectiveAt: Number(desired.effectiveAt),
                prorationDate: Number(desired.effectiveAt),
                idempotencyKey: desired.idempotencyKey,
                operationKind: desired.kind,
                ...(quote ? { quote: JSON.parse(quote.result) } : {}),
                ...(desired.resetBillingCycle === 1 ? { resetBillingCycle: true } : {}),
                resume: desired.resume === 1,
                ...(desired.endTrial === 1 ? { endTrial: true } : {}),
                ...(desired.preserveTrial === 1 ? { preserveTrial: true } : {}),
            },
        };
    });
    if (snapshot.dispatch)
        database.scheduleTeamBillingJobDispatch?.();
    if (snapshot.superseded)
        return { superseded: true };
    if (snapshot.denied)
        throw denied();
    try {
        if (typeof database.updateTeamBillingSubscription !== "function")
            throw retryable("TEAM_BILLING_PROVIDER_UNAVAILABLE");
        const providerResult = await database.updateTeamBillingSubscription(_context, Object.freeze(snapshot.provider));
        if (!validProviderAcknowledgement(providerResult))
            throw coded("Team Billing provider returned an invalid acknowledgement.", "TEAM_BILLING_PROVIDER_REJECTED");
        if (providerResult?.outcome === "payment-action-required") {
            const paymentAction = validPaymentAction(providerResult.paymentAction) ? providerResult.paymentAction : null;
            await releaseAfterFailure(database, snapshot.desired, claimToken, { retryable: false, code: "PAYMENT_ACTION_REQUIRED" }, paymentAction);
            return { failed: true, safeFailureCode: "PAYMENT_ACTION_REQUIRED" };
        }
    }
    catch (error) {
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
        const ownedLane = await releaseLane(transaction, snapshot.desired.teamId, claimToken, database);
        if (!ownedLane || !current || current.activeJobGenerationId !== snapshot.desired.activeJobGenerationId
            || current.operationId !== snapshot.desired.operationId || current.status !== "running")
            return false;
        const updated = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'awaiting-observation', [providerAcknowledgedAt] = ?, [safeFailureCode] = NULL, [updatedAt] = ? " +
            "WHERE [intentId] = ? AND [activeJobGenerationId] = ? AND [status] = 'running' " +
            "AND ([operationId] = ? OR ([operationId] IS NULL AND CAST(? AS TEXT) IS NULL))")).run(nowIso(database), nowIso(database), current.intentId, snapshot.desired.activeJobGenerationId, snapshot.desired.operationId, snapshot.desired.operationId);
        if (Number(updated?.changes ?? updated?.changesCount ?? 0) !== 1)
            return false;
        if (current.operationId)
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'awaiting-observation', [updatedAt] = ? WHERE [id] = ?")).run(nowIso(database), current.operationId);
        return true;
    });
    return acknowledged ? { providerAcknowledged: true } : { superseded: true };
}
/** Invoked only after full verified-event validation has accepted this target. */
export async function settleVerifiedTeamBillingTarget(database, accepted) {
    if (!accepted || typeof accepted.teamId !== "string" || typeof accepted.productKey !== "string"
        || !Number.isSafeInteger(accepted.quantity) || typeof accepted.subscriptionId !== "string")
        return { settled: false };
    let enqueued = false;
    const result = await inTransaction(database, async (transaction) => {
        const sql = transaction.dialect.sql;
        const subscription = await transaction.prepare(sql("SELECT [providerSubscriptionId], [providerPriceId], [state] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [providerSubscriptionId] = ?")).get(accepted.teamId, accepted.subscriptionId);
        if (!subscription)
            return { settled: false };
        const desired = await desiredForTeam(transaction, accepted.teamId);
        if (!desired) {
            const product = database.teamBillingDefinition?.catalogue?.[accepted.productKey];
            const current = product?.quantity?.kind === "usage" ? await optionalCurrentSubscription(transaction, accepted.teamId) : null;
            if (current?.providerSubscriptionId === accepted.subscriptionId
                && await targetQuantity(database, transaction, accepted.teamId, product) !== accepted.quantity) {
                const staged = await stageTeamBillingCountChange({ ...database, adapter: transaction, __transactionActive: true, scheduleTeamBillingJobDispatch: undefined }, accepted.teamId, nowSeconds(database), "usage");
                enqueued = staged.staged === true;
                return { settled: false, repairRequired: enqueued };
            }
            return { settled: false };
        }
        if (desired.targetProductKey === accepted.productKey && Number(desired.targetQuantity) === accepted.quantity
            && (!desired.targetPriceId || desired.targetPriceId === subscription.providerPriceId)
            && (!desired.endTrial || subscription.state !== "trialing")) {
            const product = database.teamBillingDefinition?.catalogue?.[accepted.productKey];
            if (isCountedProduct(product)) {
                const billableQuantity = await targetQuantity(database, transaction, accepted.teamId, product);
                if (billableQuantity !== accepted.quantity) {
                    if (desired.operationId)
                        await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?")).run(accepted.occurredAt ?? nowIso(database), desired.operationId);
                    const replacement = await stageDesired(transaction, database, {
                        teamId: accepted.teamId, kind: "seat-convergence", operationId: null,
                        targetProductKey: accepted.productKey, targetQuantity: billableQuantity, effectiveAt: nowSeconds(database),
                    });
                    await enqueueIntent(database, transaction, replacement);
                    enqueued = true;
                    return { settled: true, repairRequired: true };
                }
            }
            await transaction.prepare(sql("DELETE FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?")).run(desired.intentId);
            await transaction.prepare(sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ?")).run(accepted.occurredAt ?? nowIso(database), accepted.teamId);
            if (desired.operationId)
                await transaction.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?")).run(accepted.occurredAt ?? nowIso(database), desired.operationId);
            return { settled: true };
        }
        if (desired.status === "awaiting-observation") {
            const targetProduct = database.teamBillingDefinition?.catalogue?.[desired.targetProductKey];
            if (targetProduct?.quantity?.kind === "usage") {
                // A new drift must make a new provider write, rather than replay an acknowledged Stripe key.
                const replacement = await stageDesired(transaction, database, {
                    teamId: desired.teamId, kind: desired.kind, operationId: desired.operationId,
                    targetProductKey: desired.targetProductKey, endTrial: desired.endTrial, preserveTrial: desired.preserveTrial, targetPriceId: desired.targetPriceId, targetQuantity: Number(desired.targetQuantity), effectiveAt: nowSeconds(database), resume: desired.resume,
                }, true);
                await enqueueIntent(database, transaction, replacement);
                enqueued = true;
                return { settled: false, repairRequired: true };
            }
            await transaction.prepare(sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'queued', [safeFailureCode] = 'PROVIDER_DRIFT', [providerAcknowledgedAt] = NULL, [updatedAt] = ? WHERE [intentId] = ?")).run(accepted.occurredAt ?? nowIso(database), desired.intentId);
            await enqueueIntent(database, transaction, { ...desired, enqueue: true });
            enqueued = true;
            return { settled: false, repairRequired: true };
        }
        return { settled: false };
    });
    if (enqueued)
        scheduleAfterOwnedTransaction(database);
    return result;
}
/** Startup/scheduled repair. Provider acknowledgement never suppresses repair. */
export async function repairTeamBillingDesiredState(database) {
    let queued = 0;
    await inTransaction(database, async (transaction) => {
        const subscriptions = await transaction.prepare(transaction.dialect.sql("SELECT [teamId], [productKey], [quantity], [providerPriceId], [state] FROM [sporades_team_billing_subscriptions] WHERE [replacedBy] IS NULL AND [state] IN ('trialing', 'active', 'past-due') AND [terminalLatch] = 0 ORDER BY [teamId]")).all();
        for (const candidate of subscriptions) {
            try {
                await assertCurrencyHandoverInactive(transaction, candidate.teamId);
            }
            catch {
                continue;
            }
            const candidateProduct = database.teamBillingDefinition?.catalogue?.[candidate.productKey];
            if (candidateProduct?.quantity?.kind === "usage")
                await lockTeamLifecycle(transaction, candidate.teamId, denied);
            const subscription = candidateProduct?.quantity?.kind === "usage"
                ? await optionalCurrentSubscription(transaction, candidate.teamId) : candidate;
            if (!subscription)
                continue;
            const desired = await desiredForTeam(transaction, subscription.teamId);
            if (desired) {
                if (desired.targetProductKey === subscription.productKey && Number(desired.targetQuantity) === Number(subscription.quantity)
                    && (!desired.targetPriceId || desired.targetPriceId === subscription.providerPriceId)
                    && (!desired.endTrial || subscription.state !== "trialing")) {
                    const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
                    if (isCountedProduct(product)) {
                        const billableQuantity = await targetQuantity(database, transaction, subscription.teamId, product);
                        if (billableQuantity !== Number(subscription.quantity)) {
                            const replacement = await stageDesired(transaction, database, {
                                teamId: subscription.teamId, kind: "seat-convergence", operationId: null,
                                targetProductKey: subscription.productKey, targetQuantity: billableQuantity, effectiveAt: nowSeconds(database),
                            });
                            await enqueueIntent(database, transaction, replacement);
                            queued += 1;
                            continue;
                        }
                    }
                    if (desired.operationId)
                        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'completed', [safeFailureCode] = NULL, [updatedAt] = ? WHERE [id] = ?")).run(nowIso(database), desired.operationId);
                    await transaction.prepare(transaction.dialect.sql("DELETE FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?")).run(desired.intentId);
                    continue;
                }
                await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'queued', [providerAcknowledgedAt] = NULL, [updatedAt] = ? WHERE [intentId] = ?")).run(nowIso(database), desired.intentId);
                await enqueueIntent(database, transaction, { ...desired, enqueue: true });
                queued += 1;
                continue;
            }
            const product = database.teamBillingDefinition?.catalogue?.[subscription.productKey];
            if (!isCountedProduct(product))
                continue;
            const billableQuantity = await targetQuantity(database, transaction, subscription.teamId, product);
            if (billableQuantity === Number(subscription.quantity))
                continue;
            const staged = await stageDesired(transaction, database, {
                teamId: subscription.teamId, kind: "seat-convergence", operationId: null,
                targetProductKey: subscription.productKey, targetQuantity: billableQuantity, effectiveAt: nowSeconds(database),
            });
            await enqueueIntent(database, transaction, staged);
            queued += 1;
        }
    });
    if (queued)
        scheduleAfterOwnedTransaction(database);
    return { queued };
}
export const repairTeamBillingDesiredStateAtStartup = repairTeamBillingDesiredState;
export async function settleExhaustedTeamBillingManagementJob(database, payload, safeFailureCode = "RETRY_EXHAUSTED") {
    if (typeof payload?.intentId !== "string" || typeof payload?.generationId !== "string")
        return { settled: false };
    const failureCode = safeCode(safeFailureCode);
    let replacementScheduled = false;
    const result = await inTransaction(database, async (transaction) => {
        const desired = await desiredByIntent(transaction, payload.intentId);
        if (!desired || desired.activeJobGenerationId !== payload.generationId
            || desired.status === "awaiting-observation")
            return { settled: false, stale: true };
        const lane = await transaction.prepare(transaction.dialect.sql("SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?")).get(desired.teamId);
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
        const settled = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'failed', [safeFailureCode] = ?, [providerAcknowledgedAt] = NULL, [updatedAt] = ? " +
            "WHERE [intentId] = ? AND [activeJobGenerationId] = ? AND [status] IN ('queued', 'running')")).run(failureCode, nowIso(database), desired.intentId, payload.generationId);
        if (Number(settled?.changes ?? settled?.changesCount ?? 0) !== 1)
            return { settled: false, stale: true };
        if (desired.operationId)
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ?")).run(failureCode, nowIso(database), desired.operationId);
        return { settled: true };
    });
    // A caller already inside a transaction (lease recovery) must arrange its
    // wake only after that outer transaction commits. Ordinary final-attempt
    // settlement owns its transaction and can safely publish the delayed Job.
    if (replacementScheduled && !database.__transactionActive)
        scheduleAfterOwnedTransaction(database);
    return result;
}
async function stageDesired(transaction, database, input, replaceIntent = false) {
    // Seat convergence preserves the observed interval, including after Portal switches.
    const binding = modeBinding(database, database.teamBillingDefinition.catalogue[input.targetProductKey]);
    const targetPriceId = input.targetPriceId ?? (input.kind === "seat-convergence" && binding.prices
        ? (await currentSubscription(transaction, input.teamId)).providerPriceId : null);
    input = { ...input, targetPriceId, resetBillingCycle: input.resetBillingCycle ?? 0, endTrial: input.endTrial === true || input.endTrial === 1 ? 1 : 0, preserveTrial: input.preserveTrial === true || input.preserveTrial === 1 ? 1 : 0 };
    const existing = await desiredForTeam(transaction, input.teamId);
    const unchanged = !replaceIntent && existing && existing.kind === input.kind && existing.targetProductKey === input.targetProductKey
        && (existing.preserveTrial ?? 0) === input.preserveTrial && (existing.endTrial ?? 0) === input.endTrial && (existing.targetPriceId ?? null) === input.targetPriceId
        && (Number(existing.targetQuantity) === input.targetQuantity || ((existing.resetBillingCycle === 1 || existing.endTrial === 1 || existing.preserveTrial === 1) && existing.providerAttemptedAt))
        && Number(existing.resume ?? 0) === Number(input.resume ?? 0);
    if (unchanged) {
        const transfersPlanOwnership = input.kind === "plan-transition" && typeof input.operationId === "string"
            && input.operationId !== existing.operationId;
        const enqueue = transfersPlanOwnership || ["failed", "attention-required"].includes(existing.status);
        if (enqueue)
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [operationId] = ?, [status] = 'queued', [safeFailureCode] = NULL, [providerAcknowledgedAt] = NULL, [resume] = ?, [updatedAt] = ? WHERE [intentId] = ?")).run(transfersPlanOwnership ? input.operationId : existing.operationId, input.resume ?? 0, nowIso(database), existing.intentId);
        return { ...existing, operationId: transfersPlanOwnership ? input.operationId : existing.operationId,
            status: enqueue ? "queued" : existing.status, enqueue };
    }
    const intentId = randomUUID();
    const idempotencyKey = intentIdempotency(database, input.teamId, intentId);
    const now = nowIso(database);
    if (existing) {
        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [intentId] = ?, [kind] = ?, [operationId] = ?, [targetProductKey] = ?, [targetPriceId] = ?, [targetQuantity] = ?, [effectiveAt] = ?, [resetBillingCycle] = ?, [endTrial] = ?, [preserveTrial] = ?, [idempotencyKey] = ?, [status] = 'queued', [safeFailureCode] = NULL, [providerAttemptedAt] = NULL, [providerAcknowledgedAt] = NULL, [activeJobGenerationId] = NULL, [resume] = ?, [createdAt] = ?, [updatedAt] = ? WHERE [teamId] = ?")).run(intentId, input.kind, input.operationId, input.targetProductKey, input.targetPriceId, input.targetQuantity, input.effectiveAt, input.resetBillingCycle, input.endTrial, input.preserveTrial, idempotencyKey, input.resume ?? 0, now, now, input.teamId);
    }
    else {
        await transaction.prepare(transaction.dialect.sql("INSERT INTO [sporades_team_billing_desired_state] ([teamId], [intentId], [kind], [operationId], [targetProductKey], [targetPriceId], [targetQuantity], [effectiveAt], [resetBillingCycle], [endTrial], [preserveTrial], [idempotencyKey], [status], [safeFailureCode], [providerAcknowledgedAt], [activeJobGenerationId], [resume], [createdAt], [updatedAt]) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?, ?)")).run(input.teamId, intentId, input.kind, input.operationId, input.targetProductKey, input.targetPriceId, input.targetQuantity, input.effectiveAt, input.resetBillingCycle, input.endTrial, input.preserveTrial, idempotencyKey, input.resume ?? 0, now, now);
    }
    await ensureLane(transaction, input.teamId, database);
    return { ...input, intentId, idempotencyKey, status: "queued", enqueue: true };
}
async function enqueueIntent(database, transaction, desired, availableAt) {
    const callback = desired.kind === "plan-transition"
        ? database.enqueueTeamBillingPlanTransitionJob : database.enqueueTeamBillingSeatConvergenceJob;
    if (typeof callback !== "function")
        throw retryable("TEAM_BILLING_PROVIDER_UNAVAILABLE");
    // Provider idempotency belongs to the durable desired tuple and remains
    // stable. A repair dispatch is a new Job generation: terminal Job rows are
    // intentionally retained, so reusing their queue idempotency would make
    // restart or provider-drift repair collide with the unique Job index.
    const generationId = randomUUID();
    const activated = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [activeJobGenerationId] = ?, [updatedAt] = ? WHERE [intentId] = ?")).run(generationId, nowIso(database), desired.intentId);
    if (Number(activated?.changes ?? activated?.changesCount ?? 0) !== 1)
        throw retryable("TEAM_BILLING_DESIRED_STATE_SUPERSEDED");
    await callback(transaction, { intentId: desired.intentId, generationId }, `team-billing-management:${desired.intentId}:${generationId}`, availableAt);
    return generationId;
}
async function admitPlanTransition(database, transaction, auth, teamId, productKey, interval) {
    if (!await tryAdmitPlanTransition(database, transaction, auth, teamId, productKey, interval))
        throw denied();
}
async function tryAdmitPlanTransition(database, transaction, auth, teamId, productKey, interval) {
    if (!auth?.userId || auth.isAuthenticated !== true || auth.isGuest === true)
        return false;
    // Membership changes, Billing Holder transfer, and app downgrade reads all
    // share this Team lifecycle lane. Claim it before the first authority read;
    // countAcceptedTeamMembers may re-enter the same row lock later from the
    // authorized callback, which is safe within this exact transaction.
    await lockTeamLifecycle(transaction, teamId, denied);
    const membership = await transaction.prepare(transaction.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
    if (membership?.role !== "admin")
        return false;
    const source = await optionalCurrentSubscription(transaction, teamId);
    const decision = await database.runTeamBillingAuthority?.(transaction, auth, Object.freeze({
        ...(source?.currency ? { currency: source.currency } : {}),
        operation: "plan-transition", teamId, teamRole: "admin", productKey, ...(interval ? { interval } : {}),
        ...(source ? { fromProductKey: source.productKey, ...(source.interval ? { fromInterval: source.interval } : {}) } : {}),
    }));
    return decision?.allow === true;
}
async function actorForOperation(transaction, operationId) {
    if (typeof operationId !== "string")
        return null;
    return (await transaction.prepare(transaction.dialect.sql("SELECT [actorUserId] FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'plan-transition'")).get(operationId))?.actorUserId ?? null;
}
async function targetQuantity(database, transaction, teamId, product) {
    return readTeamBillingQuantity(database, transaction, teamId, product.quantity);
}
async function currentSubscription(transaction, teamId) {
    const rows = await transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ? AND [replacedBy] IS NULL AND [state] <> 'cancelled' AND [terminalLatch] = 0 ORDER BY [id]")).all(teamId);
    if (rows.length !== 1 || !rows[0].providerSubscriptionItemId)
        throw attentionRequired();
    return rows[0];
}
function transitionRefusal(subscription, resume) {
    return teamBillingTransitionRefusal(subscription.state, !resume && subscription.cancelAtPeriodEnd === 1, subscription.hasSchedule === 1);
}
async function optionalCurrentSubscription(transaction, teamId) {
    try {
        return await currentSubscription(transaction, teamId);
    }
    catch {
        return null;
    }
}
async function desiredForTeam(transaction, teamId) {
    return transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
}
async function desiredByIntent(transaction, intentId) {
    return transaction.prepare(transaction.dialect.sql("SELECT * FROM [sporades_team_billing_desired_state] WHERE [intentId] = ?")).get(intentId);
}
async function ensureLane(transaction, teamId, database) {
    const existing = await transaction.prepare(transaction.dialect.sql("SELECT [teamId] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?")).get(teamId);
    if (!existing)
        await transaction.prepare(transaction.dialect.sql("INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?)")).run(teamId, nowIso(database));
}
async function claimLane(transaction, teamId, token, database) {
    await ensureLane(transaction, teamId, database);
    const now = nowIso(database);
    const expiresAt = new Date(database.clock.now().getTime() + CLAIM_TTL_MS).toISOString();
    const result = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = ?, [claimExpiresAt] = ?, [updatedAt] = ? " +
        "WHERE [teamId] = ? AND ([claimToken] IS NULL OR [claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(token, expiresAt, now, teamId, now);
    return Number(result?.changes ?? result?.changesCount ?? 0) === 1;
}
async function releaseLane(transaction, teamId, token, database) {
    const released = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = NULL, [claimExpiresAt] = NULL, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?")).run(nowIso(database), teamId, token);
    return Number(released?.changes ?? released?.changesCount ?? 0) === 1;
}
async function releaseAfterFailure(database, desired, token, classified, paymentAction = null) {
    await inTransaction(database, async (transaction) => {
        await releaseLane(transaction, desired.teamId, token, database);
        const current = await desiredByIntent(transaction, desired.intentId);
        if (!current)
            return;
        const updated = await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = ?, [safeFailureCode] = ?, [updatedAt] = ? " +
            "WHERE [intentId] = ? AND [activeJobGenerationId] = ?")).run(classified.retryable ? "queued" : "failed", classified.code, nowIso(database), desired.intentId, desired.activeJobGenerationId);
        if (!classified.retryable && Number(updated?.changes ?? updated?.changesCount ?? 0) === 1 && current.operationId)
            await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [paymentActionUrl] = ?, [paymentActionExpiresAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(classified.code, paymentAction?.url ?? null, paymentAction?.expiresAt ?? null, nowIso(database), current.operationId);
    });
}
async function attention(transaction, database, desired, code, deniedResult = false) {
    const updatedAt = nowIso(database);
    await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_desired_state] SET [status] = 'attention-required', [safeFailureCode] = ?, [updatedAt] = ? WHERE [intentId] = ?")).run(code, updatedAt, desired.intentId);
    if (desired.operationId)
        await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = ?, [updatedAt] = ? WHERE [id] = ?")).run(code, updatedAt, desired.operationId);
    return deniedResult ? { denied: true } : { superseded: true };
}
function classifyProviderError(database, error) {
    const classified = database.classifyTeamBillingProviderError?.(error);
    return { retryable: classified?.retryable ?? error?.retryable === true, code: safeCode(classified?.code ?? error?.code ?? "PROVIDER_REJECTED") };
}
function modeBinding(database, product) {
    return product.stripe[database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox"];
}
function assertCurrentModeAndCatalogue(database, subscription, product) {
    const mode = database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox";
    const price = teamBillingPriceById(product?.stripe?.[mode], subscription.providerPriceId);
    if ((price?.currency && billingCurrencyAmount(price, subscription.currency) === undefined)
        || !product || subscription.mode !== mode || !teamBillingPriceById(product.stripe?.[mode], subscription.providerPriceId)
        || (product.stripe[mode].prices && teamBillingPriceById(product.stripe[mode], subscription.providerPriceId)?.interval !== subscription.interval))
        throw attentionRequired();
}
function managedTransitionAllowed(database, subscription, targetProduct, price) {
    const source = database.teamBillingDefinition.catalogue[subscription.productKey];
    const sourceInterval = teamBillingPriceById(modeBinding(database, source), subscription.providerPriceId)?.interval;
    return database.teamBillingDefinition.transitions?.allowSamePolicy === true
        || !sameQuantityPolicy(source.quantity, targetProduct.quantity)
        || (price.interval !== undefined && price.interval !== sourceInterval);
}
function sameQuantityPolicy(left, right) {
    return left?.kind === right?.kind && teamBillingQuantityPolicyFingerprint(left) === teamBillingQuantityPolicyFingerprint(right);
}
function intentIdempotency(database, teamId, intentId) {
    return `sporades-team-billing-${createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0${teamId}\0${intentId}`).digest("hex")}`;
}
function operationIdempotency(database, operationId) {
    return `sporades-team-billing-operation-${createHash("sha256").update(`${database.capsuleIdentity ?? "capsule"}\0${operationId}`).digest("hex")}`;
}
async function inTransaction(database, callback) {
    if (database.__transactionActive || typeof database.adapter?.withTransaction !== "function")
        return callback(database.adapter);
    return database.adapter.withTransaction(callback);
}
function nowIso(database) {
    return database.clock.now().toISOString();
}
function nowSeconds(database) {
    return Math.floor(database.clock.now().getTime() / 1_000);
}
function scheduleAfterOwnedTransaction(database) {
    database.scheduleTeamBillingJobDispatch?.();
}
function safeCode(value) {
    const text = String(value ?? "PROVIDER_REJECTED").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
    return text || "PROVIDER_REJECTED";
}
function validProviderAcknowledgement(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !Object.keys(value).every((key) => ["ok", "outcome", "paymentAction"].includes(key)))
        return false;
    if (value.ok !== true || !["acknowledged", "payment-action-required"].includes(value.outcome))
        return false;
    return value.paymentAction === undefined
        ? true : value.outcome === "payment-action-required" && validPaymentAction(value.paymentAction);
}
/** The hosted-invoice capability is revalidated at this seam: never an arbitrary URL. */
function validPaymentAction(action) {
    if (!action || typeof action !== "object" || Array.isArray(action)
        || Object.keys(action).sort().join("\0") !== "expiresAt\0url")
        return false;
    return validTeamBillingHostedInvoiceUrl(action.url) && typeof action.expiresAt === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(action.expiresAt)
        && Number.isFinite(Date.parse(action.expiresAt))
        && new Date(action.expiresAt).toISOString() === action.expiresAt;
}
function planOperationResult(database, teamId, requestId, productKey, operation) {
    if (operation.status === "completed" || operation.status === "superseded") {
        return Object.freeze({ state: operation.status, teamId, requestId, productKey });
    }
    if (operation.status === "failed") {
        const reason = operation.safeFailureCode === "TEAM_BILLING_QUOTE_INVALID" ? "quote-invalid"
            : operation.safeFailureCode === "AUTHORITY_CHANGED" ? "authority-changed"
                : operation.safeFailureCode === "PAYMENT_ACTION_REQUIRED" ? "payment-action-required"
                    : operation.safeFailureCode === "CURRENCY_MISMATCH" ? "currency-mismatch"
                        : ["PROVIDER_STATE_AMBIGUOUS", "CATALOGUE_MISMATCH", "PROVIDER_DRIFT"].includes(operation.safeFailureCode)
                            ? "provider-state-ambiguous" : "unavailable";
        const action = { url: operation.paymentActionUrl, expiresAt: operation.paymentActionExpiresAt };
        const paymentAction = reason === "payment-action-required" && validPaymentAction(action)
            && action.expiresAt > nowIso(database) ? Object.freeze(action) : null;
        return Object.freeze({ state: "failed", teamId, requestId, productKey, reason,
            ...(paymentAction ? { paymentAction } : {}) });
    }
    return Object.freeze({ state: "pending", teamId, requestId, productKey, requestedAt: operation.createdAt });
}
function coded(message, code, retry = false) {
    return Object.assign(new Error(message), { code, ...(retry ? { retryable: true } : {}) });
}
function denied() { return coded("Team Billing plan transition denied.", "TEAM_BILLING_DENIED"); }
function conflict() { return coded("The Team Billing request conflicts with an existing request.", "TEAM_BILLING_REQUEST_CONFLICT"); }
function transitionNotRequired() { return coded("This Plan transition does not require managed quantity policy work.", "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED"); }
function attentionRequired() { return coded("Team Billing provider state requires attention.", "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS"); }
function retryable(code) { return coded("Team Billing provider work should be retried.", code, true); }
function longerInterval(source, target, at) {
    if (!source || !target)
        return false;
    const [sourceUnit, sourceCount] = source.split(":");
    const [targetUnit, targetCount] = target.split(":");
    return teamBillingIntervalEnd(at, targetUnit, Number(targetCount)) > teamBillingIntervalEnd(at, sourceUnit, Number(sourceCount));
}
//# sourceMappingURL=team-billing-management.js.map