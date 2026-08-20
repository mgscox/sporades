import type {
  StripePaymentIntegration,
  StripePaymentIntegrationOptions,
  StripePaymentsDisabledResult,
} from "./types/stripe.js";

export type {
  StripePaymentIntegration,
  StripePaymentIntegrationOptions,
  StripePaymentsDisabledResult,
} from "./types/stripe.js";

const DISABLED_RESULT: StripePaymentsDisabledResult = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "STRIPE_PAYMENTS_DISABLED",
    message: "Stripe payments are disabled.",
    hint: "Configure server-owned Prices and Sealed Server env, then enable payments.stripe in sporades.json.",
  }),
});

/**
 * Creates the server-only Stripe integration used by generated Capsule wiring.
 * Ticket 02 deliberately admits only the disabled foundation; later narrow
 * payment tickets add validated enabled operations behind this same boundary.
 */
export function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration {
  if (options?.enabled !== false) {
    const error: Error & { code?: string; hint?: string } = new Error("Stripe payments are not fully configured.");
    error.code = "STRIPE_PAYMENTS_NOT_CONFIGURED";
    error.hint = "Configure Sealed Server env and server-owned Prices before enabling Stripe payments.";
    throw error;
  }

  return Object.freeze({
    async createCheckoutSession(_input: unknown) {
      return DISABLED_RESULT;
    },
    async createCustomerPortalSession(_input: unknown) {
      return DISABLED_RESULT;
    },
    async verifyWebhookEvent(_input: unknown) {
      return DISABLED_RESULT;
    },
  });
}
