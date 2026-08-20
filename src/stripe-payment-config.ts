type LooseRecord = Record<string, any>;

export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

export type DormantStripePaymentsConfig = Readonly<{ enabled: false }>;
export type StripeEnabledPaymentsConfig = Readonly<{
  enabled: true;
  secretKeyEnv: string;
  webhookSecretEnv: string;
  publicOrigin: string;
  callbackPath: string;
  apiVersion: typeof STRIPE_API_VERSION;
  livemode: boolean;
  requestTimeoutMs: number;
}>;
export type StripePaymentsConfig = DormantStripePaymentsConfig | StripeEnabledPaymentsConfig;
export type PaymentsConfig = Readonly<{ stripe: StripePaymentsConfig }>;

const ENABLED_KEYS = [
  "enabled",
  "secretKeyEnv",
  "webhookSecretEnv",
  "publicOrigin",
  "callbackPath",
  "apiVersion",
  "livemode",
  "requestTimeoutMs",
] as const;

export function validatePaymentsConfig(payments: unknown): PaymentsConfig | undefined {
  if (payments === undefined) return undefined;
  if (!isPlainRecord(payments)) {
    fail("Invalid payments configuration.", "Set `payments` to an object containing `stripe`.");
  }
  const unknownProviders = Object.keys(payments).filter((key) => key !== "stripe");
  if (unknownProviders.length > 0) {
    fail("Unsupported payment provider configuration.", "Configure only `payments.stripe`.");
  }
  if (payments.stripe === undefined) {
    fail("Missing Stripe payments configuration.", "Configure `payments.stripe` with an explicit enabled flag.");
  }
  if (!isPlainRecord(payments.stripe)) {
    fail("Invalid Stripe payments configuration.", "Set `payments.stripe` to an object with an explicit enabled flag.");
  }
  const stripe = payments.stripe;
  if (stripe.enabled === false) {
    if (Object.keys(stripe).some((key) => key !== "enabled")) {
      fail("Unsupported dormant Stripe payments configuration.", "Configure only `payments.stripe.enabled` while Stripe payments are disabled.");
    }
    return { stripe: { enabled: false } };
  }
  if (stripe.enabled !== true) {
    fail("Invalid Stripe payments enabled flag.", "Set `payments.stripe.enabled` to true or false.");
  }
  const unknownKeys = Object.keys(stripe).filter((key) => !(ENABLED_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    fail("Unsupported Stripe payments configuration.", `Configure only ${ENABLED_KEYS.map((key) => `payments.stripe.${key}`).join(", ")} when Stripe payments are enabled.`);
  }
  for (const key of ENABLED_KEYS) {
    if (!(key in stripe)) {
      fail("Incomplete Stripe payments configuration.", `Set \`payments.stripe.${key}\` before enabling Stripe payments.`);
    }
  }
  if (!isServerEnvReference(stripe.secretKeyEnv) || !isServerEnvReference(stripe.webhookSecretEnv) || stripe.secretKeyEnv === stripe.webhookSecretEnv) {
    fail("Invalid Stripe Server env references.", "Use two distinct uppercase Sealed Server env names for the Stripe secret key and webhook signing secret.");
  }
  validatePublicOrigin(stripe.publicOrigin);
  if (!isSameOriginAbsolutePath(stripe.callbackPath)) {
    fail("Invalid Stripe callback path.", "Set `payments.stripe.callbackPath` to a same-origin absolute path without a query or fragment.");
  }
  if (stripe.apiVersion !== STRIPE_API_VERSION) {
    fail("Unsupported Stripe API compatibility version.", `Set \`payments.stripe.apiVersion\` to \`${STRIPE_API_VERSION}\` for this Sporades release.`);
  }
  if (typeof stripe.livemode !== "boolean") {
    fail("Invalid Stripe mode.", "Set `payments.stripe.livemode` to true for live credentials or false for test credentials.");
  }
  if (!Number.isInteger(stripe.requestTimeoutMs) || stripe.requestTimeoutMs < 1_000 || stripe.requestTimeoutMs > 30_000) {
    fail("Invalid Stripe request timeout.", "Set `payments.stripe.requestTimeoutMs` to an integer from 1000 through 30000 milliseconds.");
  }
  return {
    stripe: {
      enabled: true,
      secretKeyEnv: stripe.secretKeyEnv,
      webhookSecretEnv: stripe.webhookSecretEnv,
      publicOrigin: stripe.publicOrigin,
      callbackPath: stripe.callbackPath,
      apiVersion: STRIPE_API_VERSION,
      livemode: stripe.livemode,
      requestTimeoutMs: stripe.requestTimeoutMs,
    },
  };
}

export function validateStripePaymentsRuntimeConfig(payments: unknown, serverEnv: LooseRecord): PaymentsConfig | undefined {
  const normalized = validatePaymentsConfig(payments);
  if (!normalized || normalized.stripe.enabled === false) return normalized;
  const secretKey = serverEnv?.[normalized.stripe.secretKeyEnv];
  const webhookSecret = serverEnv?.[normalized.stripe.webhookSecretEnv];
  const expectedSecretPrefix = normalized.stripe.livemode ? "sk_live_" : "sk_test_";
  if (typeof secretKey !== "string" || !secretKey.startsWith(expectedSecretPrefix) || secretKey.length <= expectedSecretPrefix.length) {
    fail("Stripe secret key is unavailable or does not match the configured mode.", "Set the named Stripe secret key in Sealed Server env and make `payments.stripe.livemode` match it.");
  }
  if (typeof webhookSecret !== "string" || !webhookSecret.startsWith("whsec_") || webhookSecret.length <= "whsec_".length) {
    fail("Stripe webhook signing secret is unavailable.", "Set the named Stripe webhook signing secret in Sealed Server env before enabling Stripe payments.");
  }
  return normalized;
}

export function validateStripePaymentsSealedServerEnv(payments: unknown, hasSealedEnvelope: boolean): PaymentsConfig | undefined {
  const normalized = validatePaymentsConfig(payments);
  if (normalized?.stripe.enabled && !hasSealedEnvelope) {
    fail("Enabled Stripe payments require Sealed Server env.", "Set both named Stripe credentials with `sporades env set` before building or starting the Capsule.");
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isServerEnvReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
}

function validatePublicOrigin(value: unknown) {
  if (typeof value !== "string") {
    fail("Invalid Stripe public origin.", "Set `payments.stripe.publicOrigin` to a hosted HTTPS origin or an explicit loopback HTTP origin.");
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    fail("Invalid Stripe public origin.", "Set `payments.stripe.publicOrigin` to a hosted HTTPS origin or an explicit loopback HTTP origin.");
  }
  const loopback = origin.hostname === "localhost" || origin.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(origin.hostname);
  const secureHosted = origin.protocol === "https:";
  const localHttp = origin.protocol === "http:" && loopback;
  if ((!secureHosted && !localHttp) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.origin !== value.replace(/\/$/, "")) {
    fail("Invalid Stripe public origin.", "Use an exact hosted HTTPS origin or explicit loopback HTTP origin without credentials, a path, query, or fragment.");
  }
}

function isSameOriginAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !value.includes("?") && !value.includes("#") && !/\s/.test(value) && !value.split("/").includes("..");
}

function fail(message: string, hint: string): never {
  const error: Error & { code?: string; hint?: string } = new Error(message);
  error.code = "INVALID_STRIPE_PAYMENTS_CONFIG";
  error.hint = hint;
  throw error;
}
