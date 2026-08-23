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
    });
}
function validateInput(input) {
    const required = ["businessReference", "cancelPath", "idempotencyKey", "mode", "operationId", "priceId", "productKey", "providerExpiresAt", "quantity", "successPath", "teamId"];
    const keys = Object.keys(input ?? {}).filter((key) => key !== "customerId").sort();
    if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== required.sort().join("\0")
        || input.mode !== "subscription" || !validUuid(input.operationId) || input.businessReference !== input.operationId
        || !validUuid(input.teamId) || typeof input.productKey !== "string"
        || typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(input.priceId)
        || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99
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