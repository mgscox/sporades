type LooseRecord = Record<string, any>;
/** Restore the verifier's recursive immutability after durable JSON round-tripping. */
export declare function deepFreezeVerifiedJson<T>(value: T): T;
/** Deliver one already-verified durable Stripe Event through the Capsule's single policy seam. */
export declare function dispatchVerifiedStripeEvent(ctx: LooseRecord, event: LooseRecord, subscription?: LooseRecord): Promise<Readonly<{
    delivered: false;
    ignored: true;
    providerEventId: any;
    type: any;
}> | Readonly<{
    delivered: true;
    providerEventId: any;
    type: any;
}>>;
export {};
//# sourceMappingURL=stripe-events-runtime.d.ts.map