export type StripeEnabledPaymentsConfig = Readonly<{
  enabled: true;
  secretKeyEnv: string;
  webhookSecretEnv: string;
  publicOrigin: string;
  callbackPath: string;
  apiVersion: "2026-07-29.dahlia";
  livemode: boolean;
  requestTimeoutMs: number;
}>;

/** Configuration accepted by the server-only Stripe integration. */
export type StripePaymentIntegrationOptions =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      config: StripeEnabledPaymentsConfig;
      env: Readonly<Record<string, string | undefined>>;
      signal?: AbortSignal;
      /** Loopback-only provider origin for deterministic local protocol tests. */
      apiBaseUrl?: string;
    }>;

/** Stable result returned by every payment operation while Stripe is disabled. */
export type StripePaymentsDisabledResult = Readonly<{
  ok: false;
  error: Readonly<{
    code: "STRIPE_PAYMENTS_DISABLED";
    message: "Stripe payments are disabled.";
    hint: "Configure server-owned Prices and Sealed Server env, then enable payments.stripe in sporades.json.";
  }>;
}>;

export type StripeCheckoutSessionInput = Readonly<{
  priceId: string;
  quantity: number;
  successPath: string;
  cancelPath: string;
  idempotencyKey: string;
  businessReference: string;
}>;

export type StripeCheckoutSessionResult = Readonly<{
  ok: true;
  sessionId: string;
  url: string;
}>;

export type StripeDisabledPaymentIntegration = Readonly<{
  createCheckoutSession(input: unknown): Promise<StripePaymentsDisabledResult>;
  createCustomerPortalSession(input: unknown): Promise<StripePaymentsDisabledResult>;
  verifyWebhookEvent(input: unknown): Promise<StripePaymentsDisabledResult>;
}>;

export type StripeEnabledPaymentIntegration = Readonly<{
  createCheckoutSession(input: StripeCheckoutSessionInput): Promise<StripeCheckoutSessionResult>;
  createCustomerPortalSession(input: unknown): Promise<never>;
  verifyWebhookEvent(input: unknown): Promise<never>;
}>;

/** Narrow server-only payment operations; no raw Stripe client is exposed. */
export type StripePaymentIntegration = StripeDisabledPaymentIntegration | StripeEnabledPaymentIntegration;

/** Creates the server-only integration used by generated blank-Capsule wiring. */
export function createStripePaymentIntegration(options: Readonly<{ enabled: false }>): StripeDisabledPaymentIntegration;
export function createStripePaymentIntegration(options: Extract<StripePaymentIntegrationOptions, { enabled: true }>): StripeEnabledPaymentIntegration;
