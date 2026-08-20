import Stripe from "stripe";
import { validateStripePaymentsRuntimeConfig } from "./stripe-payment-config.js";
const DISABLED_RESULT = Object.freeze({
    ok: false,
    error: Object.freeze({
        code: "STRIPE_PAYMENTS_DISABLED",
        message: "Stripe payments are disabled.",
        hint: "Configure server-owned Prices and Sealed Server env, then enable payments.stripe in sporades.json.",
    }),
});
/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Dormant use receives no provider authority. Complete activation admits only
 * narrow validated Checkout, Customer Portal, and exact-byte callback
 * verification operations. Capsule code keeps product, Customer association,
 * billing-holder authority, and every payment consequence outside Sporades.
 */
export function createStripePaymentIntegration(options) {
    if (options?.enabled !== false && options?.enabled !== true) {
        const error = new Error("Stripe payments are not fully configured.");
        error.code = "STRIPE_PAYMENTS_NOT_CONFIGURED";
        error.hint = "Configure Sealed Server env and server-owned Prices before enabling Stripe payments.";
        throw error;
    }
    if (options.enabled === true) {
        const payments = validateStripePaymentsRuntimeConfig({ stripe: options.config }, options.env);
        if (!payments || payments.stripe.enabled === false)
            throw new Error("Stripe payments are disabled.");
        const enabledConfig = payments.stripe;
        const secretKey = options.env[enabledConfig.secretKeyEnv];
        const provider = stripeProviderAddress(options.apiBaseUrl);
        const stripe = new Stripe(secretKey, {
            apiVersion: enabledConfig.apiVersion,
            timeout: enabledConfig.requestTimeoutMs,
            maxNetworkRetries: 0,
            telemetry: false,
            ...(provider ?? {}),
        });
        return Object.freeze({
            async createCheckoutSession(input) {
                const checkout = validateCheckoutInput(input, enabledConfig.publicOrigin);
                throwIfAborted(options.signal);
                let session;
                try {
                    session = await waitForStripeRequest(stripe.checkout.sessions.create({
                        mode: checkout.mode,
                        line_items: [{ price: checkout.priceId, quantity: checkout.quantity }],
                        success_url: checkout.successUrl,
                        cancel_url: checkout.cancelUrl,
                        client_reference_id: checkout.businessReference,
                    }, {
                        idempotencyKey: checkout.idempotencyKey,
                    }), options.signal);
                }
                catch (error) {
                    throw stripeOperationFailure(error, "checkout");
                }
                throwIfAborted(options.signal);
                if (session.mode !== checkout.mode || session.livemode !== enabledConfig.livemode || !validCheckoutSessionId(session.id) || !validCheckoutUrl(session.url, session.id)) {
                    throw paymentError("STRIPE_CHECKOUT_RESPONSE_INVALID", "Stripe returned an invalid Checkout Session.", "Retry later or check the configured Stripe account mode.", false);
                }
                return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
            },
            async createCustomerPortalSession(input) {
                const portal = validateCustomerPortalInput(input, enabledConfig.publicOrigin);
                throwIfAborted(options.signal);
                let session;
                try {
                    session = await waitForStripeRequest(stripe.billingPortal.sessions.create({
                        customer: portal.customerId,
                        return_url: portal.returnUrl,
                    }, {
                        idempotencyKey: portal.idempotencyKey,
                    }), options.signal);
                }
                catch (error) {
                    throw stripeOperationFailure(error, "portal");
                }
                throwIfAborted(options.signal);
                if (session.customer !== portal.customerId || session.livemode !== enabledConfig.livemode || session.return_url !== portal.returnUrl || !validPortalSessionId(session.id) || !validPortalUrl(session.url)) {
                    throw paymentError("STRIPE_PORTAL_RESPONSE_INVALID", "Stripe returned an invalid Customer Portal Session.", "Retry later or check the configured Stripe account mode.", false);
                }
                return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
            },
            async verifyWebhookEvent(input) {
                return verifyStripeWebhookEvent(stripe, enabledConfig, options.env[enabledConfig.webhookSecretEnv], input);
            },
        });
    }
    return Object.freeze({
        async createCheckoutSession(_input) {
            return DISABLED_RESULT;
        },
        async createCustomerPortalSession(_input) {
            return DISABLED_RESULT;
        },
        async verifyWebhookEvent(_input) {
            return DISABLED_RESULT;
        },
    });
}
// Leave bounded envelope room beneath the Job Queue's 64 KiB payload contract.
const MAX_VERIFIED_STRIPE_EVENT_BYTES = 60 * 1024;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
function verifyStripeWebhookEvent(stripe, config, secret, input) {
    try {
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== "bodyBytes\0signature") {
            throw new Error("invalid input");
        }
        if (!(input.bodyBytes instanceof Uint8Array) || input.bodyBytes.byteLength < 2 || input.bodyBytes.byteLength > MAX_VERIFIED_STRIPE_EVENT_BYTES) {
            throw new Error("invalid body");
        }
        if (typeof input.signature !== "string" || input.signature.length < 1 || input.signature.length > 8 * 1024 || /[\r\n\0]/.test(input.signature)) {
            throw new Error("invalid header");
        }
        const raw = stripe.webhooks.constructEvent(input.bodyBytes, input.signature, secret, STRIPE_WEBHOOK_TOLERANCE_SECONDS);
        if (!isPlainJsonRecord(raw)
            || raw.object !== "event"
            || typeof raw.id !== "string"
            || !/^evt_[A-Za-z0-9_]{1,240}$/.test(raw.id)
            || typeof raw.type !== "string"
            || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(raw.type)
            || raw.type.length > 200
            || !Number.isInteger(raw.created)
            || raw.created < 1
            || typeof raw.livemode !== "boolean"
            || raw.livemode !== config.livemode
            || !isPlainJsonRecord(raw.data)
            || !isPlainJsonRecord(raw.data.object)) {
            throw new Error("invalid event");
        }
        const objectId = typeof raw.data.object.id === "string" && /^[A-Za-z][A-Za-z0-9_]{1,240}$/.test(raw.data.object.id)
            ? raw.data.object.id
            : null;
        const frozenRaw = deepFreezeJson(raw);
        return Object.freeze({
            provider: "stripe",
            providerEventId: raw.id,
            type: raw.type,
            occurredAt: new Date(raw.created * 1000).toISOString(),
            livemode: raw.livemode,
            objectId,
            raw: frozenRaw,
        });
    }
    catch {
        throw paymentError("STRIPE_WEBHOOK_REJECTED", "Stripe callback was rejected.", "Confirm the endpoint configuration and retry the provider delivery.", false);
    }
}
function isPlainJsonRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function deepFreezeJson(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        deepFreezeJson(child);
    return Object.freeze(value);
}
function validateCustomerPortalInput(input, publicOrigin) {
    const keys = ["customerId", "idempotencyKey", "returnPath"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== keys.join("\0")) {
        throw paymentError("STRIPE_PORTAL_INPUT_INVALID", "Invalid Stripe Customer Portal input.", "Pass only a Capsule-authorized Customer, return path, and stable idempotency key.", false);
    }
    if (typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)) {
        throw paymentError("STRIPE_PORTAL_INPUT_INVALID", "Invalid server-resolved Stripe Customer.", "Resolve an existing Customer only after Capsule billing-holder authorization.", false);
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255 || /[\r\n\0]/.test(input.idempotencyKey)) {
        throw paymentError("STRIPE_PORTAL_INPUT_INVALID", "Invalid Stripe Customer Portal idempotency key.", "Use a stable bounded business-derived idempotency key.", false);
    }
    return {
        customerId: input.customerId,
        idempotencyKey: input.idempotencyKey,
        returnUrl: resolveReturnUrl(publicOrigin, input.returnPath, "return", "STRIPE_PORTAL_RETURN_PATH_INVALID", "Customer Portal"),
    };
}
function validateCheckoutInput(input, publicOrigin) {
    const keys = ["businessReference", "cancelPath", "idempotencyKey", "mode", "priceId", "quantity", "successPath"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== keys.join("\0")) {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout input.", "Pass only the server-owned Checkout mode, Price, quantity, return paths, idempotency key, and business reference.", false);
    }
    if (input.mode !== "payment" && input.mode !== "subscription") {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout mode.", "Use the explicit mode attached to the server-owned Capsule product.", false);
    }
    if (typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,120}$/.test(input.priceId)) {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid server-owned Stripe Price.", "Map a Capsule product key to one configured Stripe Price before calling the integration.", false);
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout quantity.", "Use a server-approved integer quantity from 1 through 99.", false);
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255 || /[\r\n\0]/.test(input.idempotencyKey)) {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout idempotency key.", "Use a stable bounded business-derived idempotency key.", false);
    }
    if (typeof input.businessReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.businessReference)) {
        throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout business reference.", "Use a stable opaque business intent reference from 8 through 128 characters.", false);
    }
    return {
        mode: input.mode,
        priceId: input.priceId,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        businessReference: input.businessReference,
        successUrl: resolveReturnUrl(publicOrigin, input.successPath, "success", "STRIPE_CHECKOUT_RETURN_PATH_INVALID", "Checkout"),
        cancelUrl: resolveReturnUrl(publicOrigin, input.cancelPath, "cancellation", "STRIPE_CHECKOUT_RETURN_PATH_INVALID", "Checkout"),
    };
}
function resolveReturnUrl(publicOrigin, path, label, code, operation) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#") || /\s/.test(path) || path.split("/").includes("..")) {
        throw paymentError(code, `Invalid ${operation} ${label} path.`, "Use a same-origin absolute path without a query or fragment.", false);
    }
    return new URL(path, publicOrigin).toString();
}
function validPortalSessionId(value) {
    return typeof value === "string" && /^bps_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validPortalUrl(value) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "billing.stripe.com" && /^\/p\/session\/[A-Za-z0-9_-]{8,1024}$/.test(url.pathname) && !url.username && !url.password && !url.port;
    }
    catch {
        return false;
    }
}
function validCheckoutSessionId(value) {
    return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(value);
}
function validCheckoutUrl(value, sessionId) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
        const validPath = url.pathname === `/c/pay/${sessionId}` || url.pathname === `/pay/${sessionId}`;
        return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && validPath && !url.username && !url.password && !url.port;
    }
    catch {
        return false;
    }
}
const STRIPE_OPERATION_FAILURES = Object.freeze({
    checkout: Object.freeze({
        unavailable: Object.freeze(["STRIPE_CHECKOUT_UNAVAILABLE", "Stripe Checkout is temporarily unavailable.", "The durable payment Job will retry within its bounded policy."]),
        rejected: Object.freeze(["STRIPE_CHECKOUT_REJECTED", "Stripe rejected the Checkout request.", "Check the server-owned Price, account mode, and Stripe configuration before retrying."]),
    }),
    portal: Object.freeze({
        unavailable: Object.freeze(["STRIPE_PORTAL_UNAVAILABLE", "Stripe Customer Portal is temporarily unavailable.", "The durable payment Job will retry within its bounded policy."]),
        rejected: Object.freeze(["STRIPE_PORTAL_REJECTED", "Stripe rejected the Customer Portal request.", "Check the Capsule-owned Customer association and Stripe account configuration before retrying."]),
    }),
});
function stripeOperationFailure(error, operation) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR")
        return error;
    if (typeof error?.retryable === "boolean" && typeof error?.code === "string" && error.code.startsWith("STRIPE_"))
        return error;
    const status = Number(error?.statusCode);
    const retryable = !Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status);
    const [code, message, hint] = STRIPE_OPERATION_FAILURES[operation][retryable ? "unavailable" : "rejected"];
    return paymentError(code, message, hint, retryable);
}
function stripeProviderAddress(apiBaseUrl) {
    if (apiBaseUrl === undefined)
        return undefined;
    let url;
    try {
        url = new URL(apiBaseUrl);
    }
    catch {
        throw paymentError("STRIPE_API_ORIGIN_INVALID", "Invalid Stripe API test origin.", "Use an explicit loopback HTTP origin for the local Stripe protocol fake.", false);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (!loopback || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
        throw paymentError("STRIPE_API_ORIGIN_INVALID", "Invalid Stripe API test origin.", "Use an explicit loopback HTTP origin for the local Stripe protocol fake.", false);
    }
    return { protocol: url.protocol.slice(0, -1), host: url.hostname, port: url.port };
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const error = new Error("Stripe payment operation was cancelled.");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    throw error;
}
function waitForStripeRequest(request, signal) {
    if (!signal)
        return request;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const aborted = () => {
            cleanup();
            try {
                throwIfAborted(signal);
            }
            catch (error) {
                reject(error);
            }
        };
        const cleanup = () => signal.removeEventListener("abort", aborted);
        signal.addEventListener("abort", aborted, { once: true });
        request.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function paymentError(code, message, hint, retryable) {
    const error = new Error(message);
    error.code = code;
    error.hint = hint;
    error.retryable = retryable;
    return error;
}
//# sourceMappingURL=stripe-payment-integration.js.map