/** Restore the verifier's recursive immutability after durable JSON round-tripping. */
export function deepFreezeVerifiedJson(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        deepFreezeVerifiedJson(child);
    return Object.freeze(value);
}
/** Deliver one already-verified durable Stripe Event through the Capsule's single policy seam. */
export async function dispatchVerifiedStripeEvent(ctx, event, subscription) {
    const deliveredEvent = Object.freeze({
        ...event,
        raw: deepFreezeVerifiedJson(event.raw),
    });
    if (subscription?.kind !== "stripeEvent" || typeof subscription.handler !== "function") {
        return Object.freeze({ delivered: false, ignored: true, providerEventId: event.providerEventId, type: event.type });
    }
    await subscription.handler(ctx, deliveredEvent);
    return Object.freeze({ delivered: true, providerEventId: event.providerEventId, type: event.type });
}
//# sourceMappingURL=stripe-events-runtime.js.map