import type { StripePaymentIntegration, StripePaymentIntegrationOptions } from "./types/stripe.js";
export type { StripePaymentIntegration, StripePaymentIntegrationOptions, StripePaymentsDisabledResult, } from "./types/stripe.js";
/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Dormant use receives no provider authority. Complete activation admits only
 * the narrow validated one-time Checkout operation implemented here.
 */
export declare function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration;
//# sourceMappingURL=stripe-payment-integration.d.ts.map