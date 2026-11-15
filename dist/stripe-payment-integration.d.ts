export { validateTeamBillingPriceEvidence } from "./team-billing-price-evidence.js";
export type { TeamBillingPriceEvidenceInput } from "../src/types/stripe.js";
import type { StripeDisabledPaymentIntegration, StripeEnabledPaymentIntegration, StripePaymentIntegrationOptions } from "../src/types/stripe.js";
export type { StripeDisabledPaymentIntegration, StripeEnabledPaymentIntegration, StripeCardIdentityResult, StripePaymentIntegration, StripePaymentIntegrationOptions, StripePaymentsDisabledResult, StripeCustomerPortalSessionInput, StripeCustomerPortalSessionResult, StripeWebhookVerificationInput, VerifiedStripeEvent, } from "../src/types/stripe.js";
/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Dormant use receives no provider authority. Complete activation admits only
 * narrow validated Checkout, Customer Portal, and exact-byte callback
 * verification operations. Capsule code keeps product, Customer association,
 * billing-holder authority, and every payment consequence outside Sporades.
 */
export declare function createStripePaymentIntegration(options: Readonly<{
    enabled: false;
}>): StripeDisabledPaymentIntegration;
export declare function createStripePaymentIntegration(options: Extract<StripePaymentIntegrationOptions, {
    enabled: true;
}>): StripeEnabledPaymentIntegration;
//# sourceMappingURL=stripe-payment-integration.d.ts.map