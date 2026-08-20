import { createHash } from "node:crypto";
import { createStripePaymentIntegration } from "./stripe-payment-integration.js";
import { STRIPE_EVENT_JOB } from "./jobs-runtime.js";
const STRIPE_EVENT_RETRY = Object.freeze({ maxAttempts: 5, delayMs: 1_000 });
export function createStripeCallbackEndpoint(payments, serverEnv, capsuleIdentity, admissionFault) {
    const config = payments?.stripe;
    if (!config?.enabled)
        return null;
    const integration = createStripePaymentIntegration({ enabled: true, config, env: serverEnv });
    return {
        name: "__sporades_stripe_events",
        runtimeOwnedStripeCallback: true,
        method: "POST",
        path: config.callbackPath,
        async handler(ctx) {
            let event;
            try {
                event = await integration.verifyWebhookEvent({
                    bodyBytes: ctx.request.bodyBytes.toUint8Array(),
                    signature: ctx.request.headers["stripe-signature"],
                });
            }
            catch (error) {
                if (error?.code === "STRIPE_WEBHOOK_REJECTED") {
                    return { status: 400, body: { ok: false } };
                }
                throw error;
            }
            const identity = createHash("sha256")
                .update(JSON.stringify([capsuleIdentity, event.providerEventId]))
                .digest("hex");
            const admitted = await ctx.jobs.enqueue(STRIPE_EVENT_JOB, event, { idempotencyKey: `stripe-event:${identity}`, retry: STRIPE_EVENT_RETRY });
            await admissionFault?.("after-enqueue", { jobId: admitted.id, providerEventId: event.providerEventId });
            return { status: 200, body: { ok: true, jobId: admitted.id } };
        },
    };
}
//# sourceMappingURL=stripe-webhook-runtime.js.map