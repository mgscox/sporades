type LooseRecord = Record<string, any>;

/** Restore the verifier's recursive immutability after durable JSON round-tripping. */
export function deepFreezeVerifiedJson<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeVerifiedJson(child);
  return Object.freeze(value);
}

/** Deliver one already-verified durable Stripe Event through the Capsule's single policy seam. */
export async function dispatchVerifiedStripeEvent(
  ctx: LooseRecord,
  event: LooseRecord,
  subscription?: LooseRecord,
) {
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
