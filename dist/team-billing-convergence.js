// Transaction-pure convergence of verified Stripe facts into runtime-owned Team
// Billing state. This module deliberately never owns a transaction: the Stripe
// consequence runner supplies the already-serialized adapter as `database.adapter`.
import { createHash, randomUUID } from "node:crypto";
import { settleVerifiedTeamBillingTarget } from "./team-billing-management.js";
import { teamBillingSubscriptionSemantics } from "./team-billing-subscription-semantics.js";
const SUPPORTED = new Set([
    "checkout.session.completed",
    "checkout.session.expired",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,240}$/;
const CHECKOUT_ID = /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,120}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,240}$/;
const ITEM_ID = /^si_[A-Za-z0-9_]{1,240}$/;
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,240}$/;
const INVOICE_LINE_ID = /^il_[A-Za-z0-9_]{1,240}$/;
const PRICE_ID = /^price_[A-Za-z0-9_]{1,249}$/;
const PRODUCT_ID = /^prod_[A-Za-z0-9_]{1,240}$/;
const CANONICAL_TIME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const RANK = Object.freeze({ active: 20, cancelling: 30, "past-due": 40, cancelled: 50 });
class Quarantine extends Error {
    teamId;
    reason;
    rank;
    objectId;
    constructor(reason, teamId = null, rank = 50, objectId = null) {
        super(reason);
        this.teamId = teamId;
        this.reason = reason;
        this.rank = rank;
        this.objectId = objectId;
    }
}
/** Apply a verified observation using the caller's already-owned transaction. */
export async function applyVerifiedTeamBillingObservation(database, event) {
    if (!SUPPORTED.has(event?.type))
        return Object.freeze({ applied: false, ignored: true });
    const transaction = database?.adapter;
    if (!transaction?.prepare || !database.teamBillingDefinition)
        return Object.freeze({ applied: false, ignored: true });
    if (typeof database.teamBillingErasureObjectKey === "function" && boundedObjectId(event?.objectId)) {
        const erased = await transaction.prepare(transaction.dialect.sql("SELECT [objectKey] FROM [sporades_team_billing_erasure_object_tombstones] WHERE [objectKey] = ?")).get(database.teamBillingErasureObjectKey(event.objectId));
        if (erased)
            return Object.freeze({ applied: false, erased: true });
    }
    const digest = safeDigest(event?.raw);
    const eventId = typeof event?.providerEventId === "string" && EVENT_ID.test(event.providerEventId) ? event.providerEventId : null;
    const occurredAt = canonicalTimestamp(event?.occurredAt);
    const expectedMode = database.paymentsConfig?.stripe?.livemode ? "live" : "sandbox";
    const preliminaryTeamId = await inferTeamId(transaction, event);
    if (eventId && digest) {
        const existing = await transaction.prepare(transaction.dialect.sql("SELECT [payloadDigest], [teamId], [outcome] FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?")).get(eventId);
        if (existing) {
            if (existing.payloadDigest !== digest) {
                await transaction.prepare(transaction.dialect.sql("UPDATE [sporades_team_billing_observations] SET [outcome] = 'quarantined', [safeReason] = 'provider-state-ambiguous' WHERE [providerEventId] = ?")).run(eventId);
                return Object.freeze({ applied: false, quarantined: true });
            }
            return Object.freeze({ applied: false, duplicate: true });
        }
    }
    try {
        validateEnvelope(database, event);
        let result;
        if (event.type.startsWith("checkout.session."))
            result = await applyCheckout(database, event, expectedMode);
        else if (event.type.startsWith("customer.subscription."))
            result = await applySubscription(database, event, expectedMode);
        else
            result = await applyInvoiceFailure(database, event, expectedMode);
        const outcome = result.outcome ?? "applied";
        await recordObservation(database, event, digest, result.teamId, result.objectId, result.rank, outcome, null);
        return Object.freeze({ applied: outcome === "applied" });
    }
    catch (error) {
        if (!(error instanceof Quarantine))
            throw error;
        const quarantine = error;
        if (eventId && digest && occurredAt) {
            await recordObservation(database, event, digest, quarantine.teamId ?? preliminaryTeamId, quarantine.objectId ?? boundedObjectId(event?.objectId), quarantine.rank, "quarantined", quarantine.reason);
        }
        return Object.freeze({ applied: false, quarantined: true });
    }
}
function validateEnvelope(database, event) {
    const raw = event?.raw;
    const object = raw?.data?.object;
    if (event?.provider !== "stripe" || !EVENT_ID.test(String(event.providerEventId ?? ""))
        || typeof event.livemode !== "boolean" || event.livemode !== Boolean(database.paymentsConfig?.stripe?.livemode)
        || !canonicalTimestamp(event.occurredAt) || !isRecord(raw) || raw.object !== "event"
        || raw.id !== event.providerEventId || raw.type !== event.type || raw.livemode !== event.livemode
        || !Number.isInteger(raw.created) || new Date(raw.created * 1000).toISOString() !== event.occurredAt
        || !isRecord(raw.data) || !isRecord(object) || event.objectId !== object.id || !boundedObjectId(object.id)) {
        throw new Quarantine("provider-state-ambiguous");
    }
}
async function applyCheckout(database, event, mode) {
    const tx = database.adapter;
    const object = event.raw.data.object;
    const operationId = object.client_reference_id;
    if (object.object !== "checkout.session" || object.mode !== "subscription" || object.livemode !== event.livemode
        || !CHECKOUT_ID.test(String(object.id ?? "")) || !UUID.test(String(operationId ?? ""))
        || object.metadata?.sporades_team_billing_operation !== operationId)
        throw new Quarantine("provider-state-ambiguous", null, 50, boundedObjectId(object.id));
    const operation = await tx.prepare(tx.dialect.sql("SELECT [id], [teamId], [mode], [status], [providerObjectId], [providerCustomerId], [providerSubscriptionId], [terminalObservedAt] " +
        "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'checkout'")).get(operationId);
    if (!operation || operation.mode !== mode)
        throw new Quarantine("provider-state-ambiguous", operation?.teamId ?? null, 50, object.id);
    if (operation.providerObjectId && operation.providerObjectId !== object.id)
        throw new Quarantine("provider-state-ambiguous", operation.teamId, 50, object.id);
    const completed = event.type === "checkout.session.completed";
    const customerId = completed && CUSTOMER_ID.test(String(object.customer ?? "")) ? object.customer : null;
    const subscriptionId = completed && SUBSCRIPTION_ID.test(String(object.subscription ?? "")) ? object.subscription : null;
    if ((completed && (!customerId || !subscriptionId || object.status !== "complete"))
        || (!completed && object.status !== "expired")) {
        throw new Quarantine("provider-state-ambiguous", operation.teamId, 50, object.id);
    }
    if (operation.providerCustomerId && customerId && operation.providerCustomerId !== customerId)
        throw new Quarantine("provider-state-ambiguous", operation.teamId, 50, object.id);
    if (operation.providerSubscriptionId && subscriptionId && operation.providerSubscriptionId !== subscriptionId)
        throw new Quarantine("provider-state-ambiguous", operation.teamId, 50, object.id);
    if (customerId)
        await bindCustomer(tx, operation.teamId, mode, customerId, event.occurredAt);
    let outcome = "ignored";
    const currentRank = operation.status === "completed" ? 2 : operation.status === "expired" ? 1 : 0;
    const nextRank = completed ? 2 : 1;
    if (!operation.terminalObservedAt || nextRank > currentRank) {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [status] = ?, [providerObjectId] = ?, [providerCustomerId] = COALESCE(?, [providerCustomerId]), " +
            "[providerSubscriptionId] = COALESCE(?, [providerSubscriptionId]), [continuationUrl] = NULL, [continuationExpiresAt] = NULL, [terminalObservedAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(completed ? "completed" : "expired", object.id, customerId, subscriptionId, event.occurredAt, event.occurredAt, operationId);
        outcome = "applied";
    }
    return { teamId: operation.teamId, objectId: object.id, rank: 10, outcome };
}
async function applySubscription(database, event, mode) {
    const tx = database.adapter;
    const object = event.raw.data.object;
    const subscriptionId = object.id;
    const customerId = object.customer;
    const metadataOperationId = object.metadata?.sporades_team_billing_operation;
    if (object.object !== "subscription" || !SUBSCRIPTION_ID.test(String(subscriptionId ?? ""))
        || !CUSTOMER_ID.test(String(customerId ?? "")) || object.livemode !== event.livemode) {
        throw new Quarantine("provider-state-ambiguous", null, 50, boundedObjectId(subscriptionId));
    }
    const existing = await tx.prepare(tx.dialect.sql("SELECT [id], [teamId], [mode], [providerSubscriptionId], [terminalLatch], [currentPeriodStart], [lastEventOccurredAt], [lastEventRank] " +
        "FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = ?")).get(subscriptionId);
    const operation = metadataOperationId && UUID.test(metadataOperationId)
        ? await tx.prepare(tx.dialect.sql("SELECT [id], [teamId], [mode], [productKey], [quantity], [providerCustomerId], [providerSubscriptionId] " +
            "FROM [sporades_team_billing_operations] WHERE [id] = ? AND [kind] = 'checkout'")).get(metadataOperationId) : null;
    const teamId = existing?.teamId ?? operation?.teamId ?? null;
    if (!teamId || (existing && operation && existing.teamId !== operation.teamId) || existing?.mode !== undefined && existing.mode !== mode
        || operation?.mode !== undefined && operation.mode !== mode)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, subscriptionId);
    if (operation?.providerCustomerId && operation.providerCustomerId !== customerId)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, subscriptionId);
    if (operation?.providerSubscriptionId && operation.providerSubscriptionId !== subscriptionId)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, subscriptionId);
    await assertCustomerAssociation(tx, teamId, mode, customerId);
    const deleted = event.type === "customer.subscription.deleted";
    const desiredTeamQuantity = existing ? null : Number((await tx.prepare(tx.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(teamId))?.count ?? 0);
    const normalized = normalizeSubscription(database.teamBillingDefinition, object, existing ? null : operation, mode, event.type, teamId, desiredTeamQuantity);
    if (existing?.terminalLatch === 1) {
        return { teamId, objectId: subscriptionId, rank: normalized.rank, outcome: "ignored" };
    }
    if (existing && !deleted && !winsRatchet(normalized.periodStart, event.occurredAt, normalized.rank, existing.currentPeriodStart, existing.lastEventOccurredAt, Number(existing.lastEventRank ?? 0))) {
        return { teamId, objectId: subscriptionId, rank: normalized.rank, outcome: "ignored" };
    }
    await bindCustomer(tx, teamId, mode, customerId, event.occurredAt);
    if (!existing) {
        await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodStart], [currentPeriodEnd], [observedAt], [updatedAt], [lastEventOccurredAt], [lastEventKind], [lastEventRank], [terminalLatch]) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(randomUUID(), teamId, mode, subscriptionId, normalized.priceId, normalized.itemId, normalized.productKey, normalized.quantity, normalized.state, normalized.cancelAtPeriodEnd, normalized.periodStart, normalized.periodEnd, event.occurredAt, event.occurredAt, event.occurredAt, normalized.kind, normalized.rank, deleted ? 1 : 0);
    }
    else {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_subscriptions] SET [providerPriceId] = ?, [providerSubscriptionItemId] = ?, [productKey] = ?, [quantity] = ?, [state] = ?, " +
            "[cancelAtPeriodEnd] = ?, [currentPeriodStart] = ?, [currentPeriodEnd] = ?, [observedAt] = ?, [updatedAt] = ?, [lastEventOccurredAt] = ?, [lastEventKind] = ?, [lastEventRank] = ?, [terminalLatch] = ? WHERE [providerSubscriptionId] = ?")).run(normalized.priceId, normalized.itemId, normalized.productKey, normalized.quantity, normalized.state, normalized.cancelAtPeriodEnd, normalized.periodStart, normalized.periodEnd, event.occurredAt, event.occurredAt, event.occurredAt, normalized.kind, normalized.rank, deleted ? 1 : 0, subscriptionId);
    }
    if (operation) {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_operations] SET [providerCustomerId] = ?, [providerSubscriptionId] = ?, [updatedAt] = ? WHERE [id] = ?")).run(customerId, subscriptionId, event.occurredAt, operation.id);
    }
    await settleVerifiedTeamBillingTarget({ ...database, adapter: tx, __transactionActive: true, __rootDatabase: database.__rootDatabase ?? database }, { teamId, productKey: normalized.productKey, quantity: normalized.quantity, subscriptionId, occurredAt: event.occurredAt });
    return { teamId, objectId: subscriptionId, rank: normalized.rank };
}
function normalizeSubscription(definition, object, operation, mode, eventType, teamId, desiredTeamQuantity) {
    const items = object.items?.data;
    if (!isRecord(object.items) || object.items.object !== "list" || object.items.has_more !== false
        || !Array.isArray(items) || items.length !== 1 || !isRecord(items[0]))
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    const item = items[0];
    const priceId = item.price?.id;
    const productId = typeof item.price?.product === "string" ? item.price.product : item.price?.product?.id;
    if (item.object !== "subscription_item" || item.subscription !== object.id || item.price?.recurring?.usage_type !== "licensed"
        || !ITEM_ID.test(String(item.id ?? "")) || !PRICE_ID.test(String(priceId ?? "")) || !PRODUCT_ID.test(String(productId ?? ""))
        || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    const matches = Object.entries(definition.catalogue).filter(([, product]) => {
        const binding = product.stripe?.[mode];
        return binding?.priceId === priceId && (!binding.productId || binding.productId === productId);
    });
    if (matches.length !== 1)
        throw new Quarantine("catalogue-mismatch", teamId, 50, object.id);
    const [productKey, product] = matches[0];
    if (operation && (operation.productKey !== productKey || Number(operation.quantity) !== item.quantity))
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    if (product.quantity.kind === "fixed" && product.quantity.value !== item.quantity)
        throw new Quarantine("catalogue-mismatch", teamId, 50, object.id);
    if (product.quantity.kind === "team-members" && desiredTeamQuantity !== null
        && (!Number.isSafeInteger(desiredTeamQuantity) || desiredTeamQuantity < 1 || desiredTeamQuantity !== item.quantity)) {
        throw new Quarantine("catalogue-mismatch", teamId, 50, object.id);
    }
    const periodStart = unixTimestamp(item.current_period_start);
    const periodEnd = unixTimestamp(item.current_period_end);
    if (!periodStart || !periodEnd || periodEnd <= periodStart)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    const cancel = object.cancel_at_period_end;
    if (typeof cancel !== "boolean")
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    const deleted = eventType === "customer.subscription.deleted";
    let state;
    if (deleted) {
        if (object.status !== "canceled")
            throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
        state = "cancelled";
    }
    else if (object.status === "active") {
        state = "active";
    }
    else if (object.status === "past_due" || object.status === "unpaid") {
        state = "past-due";
    }
    else
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    const semantics = teamBillingSubscriptionSemantics(eventType, state, cancel);
    if (!semantics)
        throw new Quarantine("provider-state-ambiguous", teamId, 50, object.id);
    return { productKey, priceId, itemId: item.id, quantity: item.quantity, periodStart, periodEnd, state,
        cancelAtPeriodEnd: cancel ? 1 : 0, kind: semantics.kind, rank: semantics.rank };
}
async function applyInvoiceFailure(database, event, mode) {
    const tx = database.adapter;
    const object = event.raw.data.object;
    const subscriptionId = object.parent?.subscription_details?.subscription;
    const customerId = object.customer;
    if (object.object !== "invoice" || !INVOICE_ID.test(String(object.id ?? ""))
        || object.parent?.type !== "subscription_details" || !isRecord(object.parent?.subscription_details)
        || !SUBSCRIPTION_ID.test(String(subscriptionId ?? "")) || !CUSTOMER_ID.test(String(customerId ?? ""))
        || object.livemode !== event.livemode || object.status !== "open" || object.paid !== false
        || !Number.isInteger(object.attempt_count) || object.attempt_count < 1)
        throw new Quarantine("provider-state-ambiguous", null, 40, boundedObjectId(object.id));
    const subscription = await tx.prepare(tx.dialect.sql("SELECT [teamId], [mode], [providerSubscriptionId], [providerSubscriptionItemId], [providerPriceId], [productKey], [quantity], [currentPeriodStart], [currentPeriodEnd], [terminalLatch], [lastEventOccurredAt], [lastEventRank] " +
        "FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = ?")).get(subscriptionId);
    if (!subscription || subscription.mode !== mode)
        throw new Quarantine("provider-state-ambiguous", subscription?.teamId ?? null, 40, boundedObjectId(object.id));
    await assertCustomerAssociation(tx, subscription.teamId, mode, customerId);
    const lines = object.lines?.data;
    if (!isRecord(object.lines) || object.lines.object !== "list" || object.lines.has_more !== false
        || !Array.isArray(lines) || lines.length !== 1)
        throw new Quarantine("provider-state-ambiguous", subscription.teamId, 40, object.id);
    const line = lines[0];
    const details = line?.parent?.subscription_item_details;
    const pricing = line?.pricing?.price_details;
    const binding = database.teamBillingDefinition.catalogue[subscription.productKey]?.stripe?.[mode];
    const pricingProductId = typeof pricing?.product === "string" ? pricing.product : pricing?.product?.id;
    if (!binding || binding.priceId !== subscription.providerPriceId
        || !isRecord(line) || line.object !== "line_item" || !INVOICE_LINE_ID.test(String(line.id ?? ""))
        || line.invoice !== object.id || line.livemode !== event.livemode || line.parent?.type !== "subscription_item_details"
        || details?.proration !== false || details?.subscription !== subscriptionId
        || details?.subscription_item !== subscription.providerSubscriptionItemId
        || line.pricing?.type !== "price_details" || pricing?.price !== subscription.providerPriceId
        || !PRODUCT_ID.test(String(pricingProductId ?? "")) || (binding?.productId && pricingProductId !== binding.productId)
        || line.quantity !== subscription.quantity || unixTimestamp(line.period?.start) !== subscription.currentPeriodStart
        || unixTimestamp(line.period?.end) !== subscription.currentPeriodEnd)
        throw new Quarantine("provider-state-ambiguous", subscription.teamId, 40, object.id);
    if (subscription.terminalLatch === 1)
        return { teamId: subscription.teamId, objectId: object.id, rank: RANK["past-due"], outcome: "ignored" };
    let outcome = "ignored";
    if (winsRatchet(subscription.currentPeriodStart, event.occurredAt, RANK["past-due"], subscription.currentPeriodStart, subscription.lastEventOccurredAt, Number(subscription.lastEventRank ?? 0))) {
        await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'past-due', [observedAt] = ?, [updatedAt] = ?, [lastEventOccurredAt] = ?, [lastEventKind] = 'invoice-failed', [lastEventRank] = ? WHERE [providerSubscriptionId] = ?")).run(event.occurredAt, event.occurredAt, event.occurredAt, RANK["past-due"], subscriptionId);
        outcome = "applied";
    }
    return { teamId: subscription.teamId, objectId: object.id, rank: RANK["past-due"], outcome };
}
async function inferTeamId(tx, event) {
    const object = event?.raw?.data?.object;
    const operationId = object?.client_reference_id ?? object?.metadata?.sporades_team_billing_operation;
    if (UUID.test(String(operationId ?? ""))) {
        const row = await tx.prepare(tx.dialect.sql("SELECT [teamId] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(operationId);
        if (row?.teamId)
            return row.teamId;
    }
    const subscriptionId = object?.object === "subscription" ? object.id : object?.parent?.subscription_details?.subscription;
    if (SUBSCRIPTION_ID.test(String(subscriptionId ?? ""))) {
        const row = await tx.prepare(tx.dialect.sql("SELECT [teamId] FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = ?")).get(subscriptionId);
        if (row?.teamId)
            return row.teamId;
    }
    return null;
}
async function assertCustomerAssociation(tx, teamId, mode, customerId) {
    const sql = tx.dialect.sql;
    const byTeam = await tx.prepare(sql("SELECT [mode], [providerCustomerId] FROM [sporades_team_billing_customers] WHERE [teamId] = ?")).get(teamId);
    const byProvider = await tx.prepare(sql("SELECT [teamId], [mode] FROM [sporades_team_billing_customers] WHERE [providerCustomerId] = ?")).get(customerId);
    if ((byTeam && (byTeam.mode !== mode || byTeam.providerCustomerId !== customerId))
        || (byProvider && (byProvider.teamId !== teamId || byProvider.mode !== mode)))
        throw new Quarantine("provider-state-ambiguous", teamId);
}
async function bindCustomer(tx, teamId, mode, customerId, now) {
    await assertCustomerAssociation(tx, teamId, mode, customerId);
    await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT ([teamId]) DO UPDATE SET [updatedAt] = excluded.[updatedAt]")).run(teamId, mode, customerId, now, now);
}
async function recordObservation(database, event, digest, teamId, objectId, rank, outcome, safeReason) {
    await database.adapter.prepare(database.adapter.dialect.sql("INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt], [eventType], [eventRank], [outcome], [safeReason]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT ([providerEventId]) DO NOTHING")).run(randomUUID(), teamId, event.livemode ? "live" : "sandbox", event.providerEventId, objectId, digest, event.occurredAt, database.clock?.now?.().toISOString?.() ?? event.occurredAt, event.type, rank, outcome, safeReason);
}
function winsRatchet(periodStart, occurredAt, rank, previousPeriodStart, previousAt, previousRank) {
    if (!canonicalTimestamp(previousPeriodStart))
        return true;
    if (periodStart !== previousPeriodStart)
        return periodStart > previousPeriodStart;
    if (!canonicalTimestamp(previousAt))
        return true;
    return occurredAt > previousAt || (occurredAt === previousAt && rank > previousRank);
}
function unixTimestamp(value) {
    if (!Number.isInteger(value) || value < 1)
        return null;
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function canonicalTimestamp(value) {
    if (typeof value !== "string" || !CANONICAL_TIME.test(value))
        return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}
function boundedObjectId(value) {
    return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{1,240}$/.test(value) ? value : null;
}
function safeDigest(raw) {
    try {
        return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    }
    catch {
        return null;
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=team-billing-convergence.js.map