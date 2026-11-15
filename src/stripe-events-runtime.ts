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
  const { __sporadesProviderPayloadDigest: _digest, ...publicEvent } = event;
  const deliveredEvent = Object.freeze({
    ...publicEvent,
    raw: deepFreezeVerifiedJson(event.raw),
  });
  if (subscription?.kind !== "stripeEvent" || typeof subscription.handler !== "function") {
    return Object.freeze({ delivered: false, ignored: true, providerEventId: event.providerEventId, type: event.type });
  }
  await subscription.handler(ctx, deliveredEvent);
  return Object.freeze({ delivered: true, providerEventId: event.providerEventId, type: event.type });
}

/** Remove raw card fingerprints without changing provider object references. */
export function redactStripeCardEvidence(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactStripeCardEvidence);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint")
    .map(([key, child]) => [key, redactStripeCardEvidence(child)]));
}
