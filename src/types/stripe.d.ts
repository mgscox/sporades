/** Configuration admitted by the dormant Stripe payment foundation. */
export type StripePaymentIntegrationOptions = {
  enabled: false;
};

/** Stable result returned by every payment operation while Stripe is disabled. */
export type StripePaymentsDisabledResult = Readonly<{
  ok: false;
  error: Readonly<{
    code: "STRIPE_PAYMENTS_DISABLED";
    message: "Stripe payments are disabled.";
    hint: "Configure server-owned Prices and Sealed Server env, then enable payments.stripe in sporades.json.";
  }>;
}>;

/** Narrow server-only payment operations; no raw Stripe client is exposed. */
export type StripePaymentIntegration = Readonly<{
  createCheckoutSession(input: unknown): Promise<StripePaymentsDisabledResult>;
  createCustomerPortalSession(input: unknown): Promise<StripePaymentsDisabledResult>;
  verifyWebhookEvent(input: unknown): Promise<StripePaymentsDisabledResult>;
}>;

/** Creates the server-only integration used by generated blank-Capsule wiring. */
export function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration;
