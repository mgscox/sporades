import { createHmac } from "node:crypto";
/** Internal transient provider evidence; only the keyed token may leave this boundary. */
export function cardIdentityKey(config, env) {
    const key = config.cardIdentityKeyEnv && env?.[config.cardIdentityKeyEnv];
    if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32 || !key.trim()) {
        throw Object.assign(new Error("Stripe card identity is not configured."), {
            code: "STRIPE_CARD_IDENTITY_NOT_CONFIGURED", retryable: false,
            hint: "Configure payments.stripe.cardIdentityKeyEnv with a dedicated Sealed Server secret.",
        });
    }
    return key;
}
export function stripeCardIdentity(paymentMethod, key, livemode) {
    if (paymentMethod === null || paymentMethod === undefined)
        return null;
    if (typeof paymentMethod !== "object" || Array.isArray(paymentMethod) || paymentMethod.object !== "payment_method"
        || typeof paymentMethod.type !== "string" || !paymentMethod.type
        || paymentMethod.livemode !== undefined && paymentMethod.livemode !== livemode)
        throw cardIdentityUnavailable();
    if (paymentMethod.type !== "card" || !paymentMethod.card?.fingerprint)
        return null;
    const fingerprint = paymentMethod.card.fingerprint;
    if (typeof fingerprint !== "string" || Buffer.byteLength(fingerprint, "utf8") > 256)
        throw cardIdentityUnavailable();
    const token = createHmac("sha256", key).update(`sporades-card-identity\0v1\0${livemode ? "live" : "sandbox"}\0${fingerprint}`).digest("base64url");
    return Object.freeze({ token });
}
export function cardIdentityUnavailable() {
    return Object.assign(new Error("Stripe card identity is unavailable."), {
        code: "STRIPE_CARD_IDENTITY_UNAVAILABLE", retryable: false,
        hint: "Read a completed Checkout in the configured Stripe mode.",
    });
}
export const CHECKOUT_CARD_EXPAND = ["payment_intent.payment_method", "setup_intent.payment_method",
    "subscription.default_payment_method", "subscription.pending_setup_intent.payment_method"];
export const SUBSCRIPTION_CARD_EXPAND = ["default_payment_method", "pending_setup_intent.payment_method"];
//# sourceMappingURL=stripe-card-identity.js.map