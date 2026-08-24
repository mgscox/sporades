import Stripe from "stripe";
/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export function createStripeTeamBillingProvider(options) {
    const config = options.config;
    const secretKey = options.env?.[config?.secretKeyEnv];
    if (!config?.enabled || typeof secretKey !== "string")
        throw providerFailure(false);
    const provider = loopbackProvider(options.apiBaseUrl);
    const stripe = new Stripe(secretKey, {
        apiVersion: config.apiVersion,
        timeout: config.requestTimeoutMs,
        maxNetworkRetries: 0,
        telemetry: false,
        ...(provider ?? {}),
    });
    return Object.freeze({
        async create(input) {
            validateInput(input);
            throwIfAborted(options.signal);
            let session;
            try {
                session = await stripe.checkout.sessions.create({
                    mode: "subscription",
                    line_items: [{ price: input.priceId, quantity: input.quantity }],
                    success_url: new URL(input.successPath, config.publicOrigin).toString(),
                    cancel_url: new URL(input.cancelPath, config.publicOrigin).toString(),
                    client_reference_id: input.businessReference,
                    expires_at: input.providerExpiresAt,
                    metadata: { sporades_team_billing_operation: input.operationId },
                    subscription_data: { metadata: { sporades_team_billing_operation: input.operationId } },
                    ...(input.customerId ? { customer: input.customerId } : {}),
                }, { idempotencyKey: input.idempotencyKey });
            }
            catch (error) {
                if (error?.name === "AbortError" || error?.code === "ABORT_ERR")
                    throw error;
                const status = Number(error?.statusCode);
                throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
            }
            throwIfAborted(options.signal);
            if (session.mode !== "subscription" || session.livemode !== config.livemode
                || session.client_reference_id !== input.businessReference || session.expires_at !== input.providerExpiresAt
                || !validSessionId(session.id) || !validUrl(session.url, session.id)
                || (input.customerId && session.customer !== input.customerId))
                throw providerFailure(false);
            return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
        },
        async retrievePortalConfiguration(input) {
            validatePortalConfigurationInput(input);
            throwIfAborted(options.signal);
            let portalConfiguration;
            try {
                portalConfiguration = await stripe.billingPortal.configurations.retrieve(input.configurationId, {
                    expand: ["features.subscription_update.products"],
                });
            }
            catch (error) {
                throwProviderOperationFailure(error);
            }
            throwIfAborted(options.signal);
            attestPortalConfiguration(portalConfiguration, input, config.livemode);
            return Object.freeze({ ok: true });
        },
        async createPortal(input) {
            validatePortalInput(input);
            throwIfAborted(options.signal);
            const returnUrl = new URL(input.returnPath, config.publicOrigin).toString();
            let session;
            try {
                session = await stripe.billingPortal.sessions.create({
                    customer: input.customerId,
                    configuration: input.configurationId,
                    return_url: returnUrl,
                }, { idempotencyKey: input.idempotencyKey });
            }
            catch (error) {
                throwProviderOperationFailure(error);
            }
            throwIfAborted(options.signal);
            if (session.object !== "billing_portal.session" || session.customer !== input.customerId
                || session.configuration !== input.configurationId || session.livemode !== config.livemode
                || session.return_url !== returnUrl || !validPortalSessionId(session.id) || !validPortalUrl(session.url)) {
                throw providerFailure(false);
            }
            return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
        },
        async updateManagedSubscription(input) {
            validateManagedSubscriptionInput(input, config.livemode);
            throwIfAborted(options.signal);
            let current;
            try {
                current = await stripe.subscriptions.retrieve(input.subscriptionId);
            }
            catch (error) {
                throwProviderOperationFailure(error);
            }
            throwIfAborted(options.signal);
            attestManagedSubscription(current, input, new Set([input.sourcePriceId, input.targetPriceId]), false);
            let updated;
            try {
                updated = await stripe.subscriptions.update(input.subscriptionId, {
                    items: [{
                            id: input.subscriptionItemId,
                            price: input.targetPriceId,
                            quantity: input.targetQuantity,
                        }],
                    proration_behavior: "create_prorations",
                    proration_date: input.prorationDate,
                    payment_behavior: "pending_if_incomplete",
                }, { idempotencyKey: input.idempotencyKey });
            }
            catch (error) {
                throwProviderOperationFailure(error);
            }
            throwIfAborted(options.signal);
            attestManagedSubscription(updated, input, new Set([input.targetPriceId]), true);
            const paymentActionRequired = updated.pending_update != null
                || ["incomplete", "past_due", "unpaid"].includes(updated.status);
            return Object.freeze({
                ok: true,
                outcome: paymentActionRequired ? "payment-action-required" : "acknowledged",
            });
        },
        async quiesceTeamBilling(input) {
            validateErasureInput(input, config.livemode);
            throwIfAborted(options.signal);
            const checkouts = [];
            const subscriptionIds = new Set(input.subscriptionIds);
            const checkoutSessionIds = new Set(input.checkoutSessionIds);
            let customerId = input.customerId ?? null;
            for (const recovery of input.checkoutRecoveries ?? []) {
                let recovered;
                try {
                    recovered = await stripe.checkout.sessions.create({
                        mode: "subscription",
                        line_items: [{ price: recovery.priceId, quantity: recovery.quantity }],
                        success_url: new URL(recovery.successPath, config.publicOrigin).toString(),
                        cancel_url: new URL(recovery.cancelPath, config.publicOrigin).toString(),
                        client_reference_id: recovery.businessReference,
                        expires_at: recovery.providerExpiresAt,
                        metadata: { sporades_team_billing_operation: recovery.operationId },
                        subscription_data: { metadata: { sporades_team_billing_operation: recovery.operationId } },
                        ...(recovery.customerId ? { customer: recovery.customerId } : {}),
                    }, { idempotencyKey: recovery.idempotencyKey });
                }
                catch (error) {
                    throwProviderOperationFailure(error);
                }
                if (!validSessionId(recovered?.id) || recovered.client_reference_id !== recovery.operationId
                    || recovered.livemode !== config.livemode || recovered.mode !== "subscription")
                    throw providerFailure(false);
                checkoutSessionIds.add(recovered.id);
            }
            for (const sessionId of [...checkoutSessionIds].sort()) {
                let session;
                try {
                    session = await stripe.checkout.sessions.retrieve(sessionId);
                }
                catch (error) {
                    if (Number(error?.statusCode) === 404) {
                        checkouts.push({ id: sessionId, state: "safely-closed" });
                        continue;
                    }
                    throwProviderOperationFailure(error);
                }
                attestErasureCheckout(session, sessionId, config.livemode);
                if (session.status === "open") {
                    try {
                        session = await stripe.checkout.sessions.expire(sessionId);
                    }
                    catch (error) {
                        if (Number(error?.statusCode) !== 404 && !isCheckoutNonExpireableRace(error)) {
                            throwProviderOperationFailure(error);
                        }
                        try {
                            session = await stripe.checkout.sessions.retrieve(sessionId);
                        }
                        catch (retrieval) {
                            if (Number(retrieval?.statusCode) === 404) {
                                checkouts.push({ id: sessionId, state: "safely-closed" });
                                continue;
                            }
                            throwProviderOperationFailure(retrieval);
                        }
                    }
                    attestErasureCheckout(session, sessionId, config.livemode);
                }
                if (session.status === "complete") {
                    if (session.customer && !validCustomerId(session.customer))
                        throw providerFailure(false);
                    if (session.subscription && !validSubscriptionId(session.subscription))
                        throw providerFailure(false);
                    if (customerId && session.customer && customerId !== session.customer)
                        throw providerFailure(false);
                    customerId ??= session.customer ?? null;
                    if (session.subscription)
                        subscriptionIds.add(session.subscription);
                    checkouts.push({ id: sessionId, state: "complete" });
                }
                else if (session.status === "expired")
                    checkouts.push({ id: sessionId, state: "expired" });
                else
                    throw providerFailure(false);
            }
            const subscriptions = new Map();
            for (let pass = 0; pass < 4; pass += 1) {
                if (customerId) {
                    let startingAfter;
                    do {
                        let page;
                        try {
                            page = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
                        }
                        catch (error) {
                            throwProviderOperationFailure(error);
                        }
                        if (page?.object !== "list" || !Array.isArray(page.data) || typeof page.has_more !== "boolean")
                            throw providerFailure(false);
                        for (const subscription of page.data) {
                            attestErasureSubscription(subscription, subscription.id, customerId, config.livemode);
                            subscriptionIds.add(subscription.id);
                            subscriptions.set(subscription.id, subscription);
                        }
                        startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
                        if (page.has_more && !validSubscriptionId(startingAfter))
                            throw providerFailure(false);
                    } while (startingAfter);
                }
                let changed = false;
                for (const subscriptionId of [...subscriptionIds].sort()) {
                    let subscription = subscriptions.get(subscriptionId);
                    if (!subscription) {
                        try {
                            subscription = await stripe.subscriptions.retrieve(subscriptionId);
                        }
                        catch (error) {
                            if (Number(error?.statusCode) === 404) {
                                subscriptions.set(subscriptionId, { id: subscriptionId, safelyClosed: true });
                                continue;
                            }
                            throwProviderOperationFailure(error);
                        }
                        const inferredCustomer = subscription.customer;
                        if (!customerId && validCustomerId(inferredCustomer))
                            customerId = inferredCustomer;
                        if (!customerId)
                            throw providerFailure(false);
                        attestErasureSubscription(subscription, subscriptionId, customerId, config.livemode);
                        subscriptions.set(subscriptionId, subscription);
                    }
                    if (!subscription.safelyClosed && subscription.status !== "canceled") {
                        try {
                            subscription = await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey: erasureCancellationKey(input.idempotencyKey, subscriptionId) });
                        }
                        catch (error) {
                            if (Number(error?.statusCode) === 404) {
                                subscriptions.set(subscriptionId, { id: subscriptionId, safelyClosed: true });
                                continue;
                            }
                            throwProviderOperationFailure(error);
                        }
                        attestErasureSubscription(subscription, subscriptionId, customerId, config.livemode);
                        if (subscription.status !== "canceled")
                            throw providerFailure(false);
                        subscriptions.set(subscriptionId, subscription);
                        changed = true;
                    }
                }
                if (!changed)
                    break;
                if (pass === 3)
                    throw providerFailure(true);
            }
            throwIfAborted(options.signal);
            return Object.freeze({
                ok: true,
                outcome: "quiesced",
                providerObservedAt: new Date().toISOString(),
                checkouts: Object.freeze(checkouts.sort((left, right) => left.id.localeCompare(right.id)).map(Object.freeze)),
                subscriptions: Object.freeze([...subscriptions.values()].sort((left, right) => left.id.localeCompare(right.id))
                    .map((subscription) => Object.freeze({ id: subscription.id, state: subscription.safelyClosed ? "safely-closed" : "cancelled" }))),
            });
        },
    });
}
function validateErasureInput(input, livemode) {
    const keys = Object.keys(input ?? {}).sort();
    const expected = ["checkoutSessionIds", "idempotencyKey", "mode", "subscriptionIds",
        ...(input?.customerId === undefined ? [] : ["customerId"]), ...(input?.checkoutRecoveries === undefined ? [] : ["checkoutRecoveries"])].sort();
    if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== expected.join("\0")
        || !["sandbox", "live"].includes(input.mode) || (input.mode === "live") !== livemode
        || input.customerId !== undefined && !validCustomerId(input.customerId)
        || !Array.isArray(input.checkoutSessionIds) || !input.checkoutSessionIds.every(validSessionId)
        || !Array.isArray(input.subscriptionIds) || !input.subscriptionIds.every(validSubscriptionId)
        || new Set(input.checkoutSessionIds).size !== input.checkoutSessionIds.length
        || new Set(input.subscriptionIds).size !== input.subscriptionIds.length
        || input.checkoutRecoveries !== undefined && (!Array.isArray(input.checkoutRecoveries)
            || !input.checkoutRecoveries.every((recovery) => { try {
                validateInput(recovery);
                return true;
            }
            catch {
                return false;
            } }))
        || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255)
        throw providerFailure(false);
}
function attestErasureCheckout(session, sessionId, livemode) {
    if (session?.object !== "checkout.session" || session.id !== sessionId || session.mode !== "subscription"
        || session.livemode !== livemode || !["open", "complete", "expired"].includes(session.status))
        throw providerFailure(false);
}
function attestErasureSubscription(subscription, subscriptionId, customerId, livemode) {
    if (subscription?.object !== "subscription" || subscription.id !== subscriptionId
        || subscription.customer !== customerId || subscription.livemode !== livemode || typeof subscription.status !== "string")
        throw providerFailure(false);
}
function erasureCancellationKey(erasureKey, subscriptionId) {
    const crypto = process.getBuiltinModule("node:crypto");
    return `sporades-team-billing-cancel-${crypto.createHash("sha256").update(`${erasureKey}\0${subscriptionId}`).digest("hex")}`;
}
function validateManagedSubscriptionInput(input, livemode) {
    const required = ["customerId", "idempotencyKey", "mode", "operationKind", "prorationDate", "sourcePriceId", "subscriptionId", "subscriptionItemId", "targetPriceId", "targetQuantity"];
    const keys = Object.keys(input ?? {}).filter((key) => key !== "targetProductId").sort();
    if (!input || typeof input !== "object" || Array.isArray(input)
        || keys.join("\0") !== required.join("\0")
        || !["sandbox", "live"].includes(input.mode) || (input.mode === "live") !== livemode
        || !["plan-transition", "seat-convergence"].includes(input.operationKind)
        || !validCustomerId(input.customerId) || !validSubscriptionId(input.subscriptionId)
        || !validSubscriptionItemId(input.subscriptionItemId)
        || !validPriceId(input.sourcePriceId) || !validPriceId(input.targetPriceId)
        || (input.targetProductId !== undefined && !validProductId(input.targetProductId))
        || !Number.isInteger(input.targetQuantity) || input.targetQuantity < 1 || input.targetQuantity > 999_999
        || !Number.isSafeInteger(input.prorationDate) || input.prorationDate < 1
        || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
        || /[\r\n\0]/.test(input.idempotencyKey))
        throw providerFailure(false);
}
function attestManagedSubscription(subscription, input, acceptedPriceIds, requireTarget) {
    const items = subscription?.items;
    if (subscription?.object !== "subscription" || subscription.id !== input.subscriptionId
        || subscription.customer !== input.customerId || subscription.livemode !== (input.mode === "live")
        || items?.object !== "list" || items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) {
        throw providerFailure(false);
    }
    const item = items.data[0];
    const price = item?.price;
    if (item?.object !== "subscription_item" || item.id !== input.subscriptionItemId
        || item.subscription !== input.subscriptionId || !acceptedPriceIds.has(price?.id)
        || price?.object !== "price" || price.livemode !== (input.mode === "live")
        || !validProductId(price?.product) || price?.recurring?.usage_type !== "licensed"
        || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999_999
        || (requireTarget && price.id !== input.targetPriceId)
        || (requireTarget && item.quantity !== input.targetQuantity)
        || (requireTarget && input.targetProductId !== undefined && price.product !== input.targetProductId)) {
        throw providerFailure(false);
    }
}
function validCustomerId(value) {
    return typeof value === "string" && /^cus_[A-Za-z0-9_]{1,120}$/.test(value);
}
function validSubscriptionId(value) {
    return typeof value === "string" && /^sub_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validSubscriptionItemId(value) {
    return typeof value === "string" && /^si_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validPriceId(value) {
    return typeof value === "string" && /^price_[A-Za-z0-9_]{1,249}$/.test(value);
}
function validProductId(value) {
    return typeof value === "string" && /^prod_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validatePortalConfigurationInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join("\0") !== ["configurationId", "expectedProducts", "mode"].join("\0")
        || !validPortalConfigurationId(input.configurationId) || !["sandbox", "live"].includes(input.mode)
        || !Array.isArray(input.expectedProducts) || input.expectedProducts.length < 1)
        throw providerFailure(false);
    let previousProductId = "";
    const seenPrices = new Set();
    for (const product of input.expectedProducts) {
        if (!product || typeof product !== "object" || Array.isArray(product)
            || Object.keys(product).sort().join("\0") !== "priceIds\0productId"
            || typeof product.productId !== "string" || !/^prod_[A-Za-z0-9_]{1,240}$/.test(product.productId)
            || product.productId <= previousProductId || !Array.isArray(product.priceIds) || product.priceIds.length < 1)
            throw providerFailure(false);
        previousProductId = product.productId;
        let previousPriceId = "";
        for (const priceId of product.priceIds) {
            if (typeof priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(priceId)
                || priceId <= previousPriceId || seenPrices.has(priceId))
                throw providerFailure(false);
            previousPriceId = priceId;
            seenPrices.add(priceId);
        }
    }
}
function validatePortalInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join("\0") !== ["configurationId", "customerId", "idempotencyKey", "returnPath"].join("\0")
        || !validPortalConfigurationId(input.configurationId)
        || typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)
        || !validReturnPath(input.returnPath)
        || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
        || /[\r\n\0]/.test(input.idempotencyKey))
        throw providerFailure(false);
}
function attestPortalConfiguration(portalConfiguration, input, livemode) {
    const subscriptionUpdate = portalConfiguration?.features?.subscription_update;
    if (portalConfiguration?.object !== "billing_portal.configuration"
        || portalConfiguration.id !== input.configurationId || portalConfiguration.active !== true
        || portalConfiguration.livemode !== livemode || (input.mode === "live") !== livemode
        || portalConfiguration.features?.payment_method_update?.enabled !== true
        || portalConfiguration.features?.invoice_history?.enabled !== true
        || portalConfiguration.features?.subscription_cancel?.enabled !== true
        || portalConfiguration.features?.subscription_cancel?.mode !== "at_period_end"
        || subscriptionUpdate?.enabled !== true
        || !sameExactStringList(subscriptionUpdate.default_allowed_updates, ["price"])
        || !sameExactPortalProducts(subscriptionUpdate.products, input.expectedProducts))
        throw providerFailure(false);
}
function sameExactPortalProducts(actual, expected) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
        return false;
    const normalized = [];
    const seenProducts = new Set();
    const seenPrices = new Set();
    for (const product of actual) {
        if (!product || typeof product !== "object" || Array.isArray(product)
            || typeof product.product !== "string" || seenProducts.has(product.product)
            || product.adjustable_quantity?.enabled !== false || !Array.isArray(product.prices) || product.prices.length < 1)
            return false;
        seenProducts.add(product.product);
        const priceIds = [];
        for (const priceId of product.prices) {
            if (typeof priceId !== "string" || seenPrices.has(priceId) || priceIds.includes(priceId))
                return false;
            priceIds.push(priceId);
            seenPrices.add(priceId);
        }
        priceIds.sort();
        normalized.push({ productId: product.product, priceIds });
    }
    normalized.sort((left, right) => left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0);
    return JSON.stringify(normalized) === JSON.stringify(expected);
}
function sameExactStringList(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
}
function validPortalConfigurationId(value) {
    return typeof value === "string" && /^bpc_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validPortalSessionId(value) {
    return typeof value === "string" && /^bps_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validPortalUrl(value) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
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
function isCheckoutNonExpireableRace(error) {
    const message = error?.raw?.message ?? error?.message;
    return Number(error?.statusCode) === 400
        && error?.type === "StripeInvalidRequestError"
        && error?.raw?.type === "invalid_request_error"
        && /^Only Checkout Sessions with a status in \["open"\] can be expired\. This Checkout Session has a status of `(complete|expired)`\.$/.test(message);
}
function throwProviderOperationFailure(error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR")
        throw error;
    const status = Number(error?.statusCode);
    throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
}
function validateInput(input) {
    const required = ["businessReference", "cancelPath", "idempotencyKey", "mode", "operationId", "priceId", "productKey", "providerExpiresAt", "quantity", "successPath", "teamId"];
    const keys = Object.keys(input ?? {}).filter((key) => key !== "customerId").sort();
    if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== required.sort().join("\0")
        || input.mode !== "subscription" || !validUuid(input.operationId) || input.businessReference !== input.operationId
        || !validUuid(input.teamId) || typeof input.productKey !== "string"
        || typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(input.priceId)
        || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999_999
        || !Number.isInteger(input.providerExpiresAt)
        || !validReturnPath(input.successPath) || !validReturnPath(input.cancelPath)
        || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
        || /[\r\n\0]/.test(input.idempotencyKey)
        || (input.customerId !== undefined && (typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId))))
        throw providerFailure(false);
}
function validReturnPath(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
        || value.includes("\\") || value.includes("?") || value.includes("#") || /\s/.test(value))
        return false;
    try {
        return new URL(value, "https://sporades.invalid").pathname === value;
    }
    catch {
        return false;
    }
}
function validUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validSessionId(value) {
    return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validUrl(value, sessionId) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
            && (url.pathname === `/c/pay/${sessionId}` || url.pathname === `/pay/${sessionId}`)
            && !url.username && !url.password && !url.port;
    }
    catch {
        return false;
    }
}
function loopbackProvider(value) {
    if (value === undefined)
        return undefined;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw providerFailure(false);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (!loopback || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
        throw providerFailure(false);
    return { protocol: url.protocol.slice(0, -1), host: url.hostname, port: url.port };
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const error = new Error("Team Checkout provider operation was cancelled.");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    throw error;
}
function providerFailure(retryable) {
    const error = new Error("Team Checkout provider operation failed.");
    error.code = retryable ? "TEAM_BILLING_PROVIDER_UNAVAILABLE" : "TEAM_BILLING_PROVIDER_REJECTED";
    error.retryable = retryable;
    return error;
}
//# sourceMappingURL=stripe-team-billing-provider.js.map