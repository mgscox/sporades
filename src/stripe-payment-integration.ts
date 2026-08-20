import type {
  StripePaymentIntegration,
  StripePaymentIntegrationOptions,
  StripePaymentsDisabledResult,
} from "./types/stripe.js";
import Stripe from "stripe";

import { validateStripePaymentsRuntimeConfig } from "./stripe-payment-config.js";

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
 * Dormant use receives no provider authority. Complete activation admits only
 * one narrow validated Checkout operation for one-time and recurring Prices.
 */
export function createStripePaymentIntegration(options: StripePaymentIntegrationOptions): StripePaymentIntegration {
  if (options?.enabled !== false && options?.enabled !== true) {
    const error: Error & { code?: string; hint?: string } = new Error("Stripe payments are not fully configured.");
    error.code = "STRIPE_PAYMENTS_NOT_CONFIGURED";
    error.hint = "Configure Sealed Server env and server-owned Prices before enabling Stripe payments.";
    throw error;
  }

  if (options.enabled === true) {
    const payments = validateStripePaymentsRuntimeConfig({ stripe: options.config }, options.env);
    if (!payments || payments.stripe.enabled === false) throw new Error("Stripe payments are disabled.");
    const enabledConfig = payments.stripe;
    const secretKey = options.env[enabledConfig.secretKeyEnv]!;
    const provider = stripeProviderAddress(options.apiBaseUrl);
    const stripe = new Stripe(secretKey, {
      apiVersion: enabledConfig.apiVersion,
      timeout: enabledConfig.requestTimeoutMs,
      maxNetworkRetries: 0,
      telemetry: false,
      ...(provider ?? {}),
    });
    return Object.freeze({
      async createCheckoutSession(input: any) {
        const checkout = validateCheckoutInput(input, enabledConfig.publicOrigin);
        throwIfAborted(options.signal);
        let session;
        try {
          session = await waitForStripeRequest(stripe.checkout.sessions.create({
            mode: checkout.mode,
            line_items: [{ price: checkout.priceId, quantity: checkout.quantity }],
            success_url: checkout.successUrl,
            cancel_url: checkout.cancelUrl,
            client_reference_id: checkout.businessReference,
          }, {
            idempotencyKey: checkout.idempotencyKey,
          }), options.signal);
        } catch (error: any) {
          if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
          if (typeof error?.retryable === "boolean" && typeof error?.code === "string" && error.code.startsWith("STRIPE_")) throw error;
          const status = Number(error?.statusCode);
          const retryable = !Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status);
          throw retryable
            ? paymentError("STRIPE_CHECKOUT_UNAVAILABLE", "Stripe Checkout is temporarily unavailable.", "The durable payment Job will retry within its bounded policy.", true)
            : paymentError("STRIPE_CHECKOUT_REJECTED", "Stripe rejected the Checkout request.", "Check the server-owned Price, account mode, and Stripe configuration before retrying.", false);
        }
        throwIfAborted(options.signal);
        if (session.mode !== checkout.mode || session.livemode !== enabledConfig.livemode || !validCheckoutSessionId(session.id) || !validCheckoutUrl(session.url, session.id)) {
          throw paymentError("STRIPE_CHECKOUT_RESPONSE_INVALID", "Stripe returned an invalid Checkout Session.", "Retry later or check the configured Stripe account mode.", false);
        }
        return Object.freeze({ ok: true as const, sessionId: session.id, url: session.url });
      },
      async createCustomerPortalSession(_input: unknown) {
        throw paymentError("STRIPE_CUSTOMER_PORTAL_UNAVAILABLE", "Stripe Customer Portal is not available in this release.", "Use the Checkout operation implemented by the current payment ticket.", false);
      },
      async verifyWebhookEvent(_input: unknown) {
        throw paymentError("STRIPE_WEBHOOKS_UNAVAILABLE", "Stripe callback admission is not available in this release.", "Keep the configured callback route unregistered until webhook support is implemented.", false);
      },
    });
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

function validateCheckoutInput(input: any, publicOrigin: string) {
  const keys = ["businessReference", "cancelPath", "idempotencyKey", "mode", "priceId", "quantity", "successPath"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== keys.join("\0")) {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout input.", "Pass only the server-owned Checkout mode, Price, quantity, return paths, idempotency key, and business reference.", false);
  }
  if (input.mode !== "payment" && input.mode !== "subscription") {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout mode.", "Use the explicit mode attached to the server-owned Capsule product.", false);
  }
  if (typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,120}$/.test(input.priceId)) {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid server-owned Stripe Price.", "Map a Capsule product key to one configured Stripe Price before calling the integration.", false);
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout quantity.", "Use a server-approved integer quantity from 1 through 99.", false);
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255 || /[\r\n\0]/.test(input.idempotencyKey)) {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout idempotency key.", "Use a stable bounded business-derived idempotency key.", false);
  }
  if (typeof input.businessReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.businessReference)) {
    throw paymentError("STRIPE_CHECKOUT_INPUT_INVALID", "Invalid Stripe Checkout business reference.", "Use a stable opaque business intent reference from 8 through 128 characters.", false);
  }
  return {
    mode: input.mode as "payment" | "subscription",
    priceId: input.priceId,
    quantity: input.quantity,
    idempotencyKey: input.idempotencyKey,
    businessReference: input.businessReference,
    successUrl: resolveReturnUrl(publicOrigin, input.successPath, "success"),
    cancelUrl: resolveReturnUrl(publicOrigin, input.cancelPath, "cancellation"),
  };
}

function resolveReturnUrl(publicOrigin: string, path: unknown, label: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#") || /\s/.test(path) || path.split("/").includes("..")) {
    throw paymentError("STRIPE_CHECKOUT_RETURN_PATH_INVALID", `Invalid Checkout ${label} path.`, "Use a same-origin absolute path without a query or fragment.", false);
  }
  return new URL(path, publicOrigin).toString();
}

function validCheckoutSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validCheckoutUrl(value: unknown, sessionId: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const validPath = url.pathname === `/c/pay/${sessionId}` || url.pathname === `/pay/${sessionId}`;
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && validPath && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function stripeProviderAddress(apiBaseUrl: string | undefined) {
  if (apiBaseUrl === undefined) return undefined;
  let url: URL;
  try { url = new URL(apiBaseUrl); } catch { throw paymentError("STRIPE_API_ORIGIN_INVALID", "Invalid Stripe API test origin.", "Use an explicit loopback HTTP origin for the local Stripe protocol fake.", false); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw paymentError("STRIPE_API_ORIGIN_INVALID", "Invalid Stripe API test origin.", "Use an explicit loopback HTTP origin for the local Stripe protocol fake.", false);
  }
  return { protocol: url.protocol.slice(0, -1) as "http" | "https", host: url.hostname, port: url.port };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error("Stripe Checkout was cancelled.");
  error.name = "AbortError";
  (error as any).code = "ABORT_ERR";
  throw error;
}

function waitForStripeRequest<T>(request: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return request;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    request.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function paymentError(code: string, message: string, hint: string, retryable: boolean) {
  const error: Error & { code?: string; hint?: string; retryable?: boolean } = new Error(message);
  error.code = code;
  error.hint = hint;
  error.retryable = retryable;
  return error;
}
