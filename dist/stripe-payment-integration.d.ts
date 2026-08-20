import type { StripePaymentIntegration, StripePaymentIntegrationOptions } from "./types/stripe.js";
export type { StripePaymentIntegration, StripePaymentIntegrationOptions, StripePaymentsDisabledResult, StripeCustomerPortalSessionInput, StripeCustomerPortalSessionResult, } from "./types/stripe.js";
/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Dormant use receives no provider authority. Complete activation admits only
 * narrow validated Checkout and Customer Portal operations. Capsule code keeps
 * product, Customer association, and billing-holder authority outside Sporades.
 */
export declare function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration;
//# sourceMappingURL=stripe-payment-integration.d.ts.map