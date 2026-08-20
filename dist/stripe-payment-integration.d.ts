import type { StripePaymentIntegration, StripePaymentIntegrationOptions } from "./types/stripe.js";
export type { StripePaymentIntegration, StripePaymentIntegrationOptions, StripePaymentsDisabledResult, } from "./types/stripe.js";
/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Ticket 02 deliberately admits only the disabled foundation; later narrow
 * payment tickets add validated enabled operations behind this same boundary.
 */
export declare function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration;
//# sourceMappingURL=stripe-payment-integration.d.ts.map