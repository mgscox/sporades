import Stripe from "stripe";

type LooseRecord = Record<string, any>;

/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export function createStripeTeamBillingProvider(options: LooseRecord) {
  const config = options.config;
  const secretKey = options.env?.[config?.secretKeyEnv];
  if (!config?.enabled || typeof secretKey !== "string") throw providerFailure(false);
  const provider = loopbackProvider(options.apiBaseUrl);
  const stripe = new Stripe(secretKey, {
    apiVersion: config.apiVersion,
    timeout: config.requestTimeoutMs,
    maxNetworkRetries: 0,
    telemetry: false,
    ...(provider ?? {}),
  });
  return Object.freeze({
    async create(input: LooseRecord) {
      validateInput(input);
      throwIfAborted(options.signal);
      let session: LooseRecord;
      try {
        session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: input.priceId, quantity: input.quantity }],
          success_url: new URL(input.successPath, config.publicOrigin).toString(),
          cancel_url: new URL(input.cancelPath, config.publicOrigin).toString(),
          client_reference_id: input.businessReference,
          expires_at: input.providerExpiresAt,
          metadata: { sporades_team_billing_operation: input.operationId },
          subscription_data: { metadata: { sporades_team_billing_operation: input.operationId } },
          ...(input.customerId ? { customer: input.customerId } : {}),
        }, { idempotencyKey: input.idempotencyKey });
      } catch (error: any) {
        if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
        const status = Number(error?.statusCode);
        throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
      }
      throwIfAborted(options.signal);
      if (session.mode !== "subscription" || session.livemode !== config.livemode
        || session.client_reference_id !== input.businessReference || session.expires_at !== input.providerExpiresAt
        || !validSessionId(session.id) || !validUrl(session.url, session.id)
        || (input.customerId && session.customer !== input.customerId)) throw providerFailure(false);
      return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
    },
    async retrievePortalConfiguration(input: LooseRecord) {
      validatePortalConfigurationInput(input);
      throwIfAborted(options.signal);
      let portalConfiguration: LooseRecord;
      try {
        portalConfiguration = await stripe.billingPortal.configurations.retrieve(input.configurationId);
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      attestPortalConfiguration(portalConfiguration, input, config.livemode);
      return Object.freeze({ ok: true });
    },
    async createPortal(input: LooseRecord) {
      validatePortalInput(input);
      throwIfAborted(options.signal);
      const returnUrl = new URL(input.returnPath, config.publicOrigin).toString();
      let session: LooseRecord;
      try {
        session = await stripe.billingPortal.sessions.create({
          customer: input.customerId,
          configuration: input.configurationId,
          return_url: returnUrl,
        }, { idempotencyKey: input.idempotencyKey });
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      if (session.object !== "billing_portal.session" || session.customer !== input.customerId
        || session.configuration !== input.configurationId || session.livemode !== config.livemode
        || session.return_url !== returnUrl || !validPortalSessionId(session.id) || !validPortalUrl(session.url)) {
        throw providerFailure(false);
      }
      return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
    },
    async updateManagedSubscription(input: LooseRecord) {
      validateManagedSubscriptionInput(input, config.livemode);
      throwIfAborted(options.signal);
      let current: LooseRecord;
      try {
        current = await stripe.subscriptions.retrieve(input.subscriptionId);
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      attestManagedSubscription(current, input, new Set([input.sourcePriceId, input.targetPriceId]), false);

      let updated: LooseRecord;
      try {
        updated = await stripe.subscriptions.update(input.subscriptionId, {
          items: [{
            id: input.subscriptionItemId,
            price: input.targetPriceId,
            quantity: input.targetQuantity,
          }],
          proration_behavior: "create_prorations",
          proration_date: input.prorationDate,
          payment_behavior: "pending_if_incomplete",
        }, { idempotencyKey: input.idempotencyKey });
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      attestManagedSubscription(updated, input, new Set([input.targetPriceId]), true);
      const paymentActionRequired = updated.pending_update != null
        || ["incomplete", "past_due", "unpaid"].includes(updated.status);
      return Object.freeze({
        ok: true,
        outcome: paymentActionRequired ? "payment-action-required" : "acknowledged",
      });
    },
  });
}

function validateManagedSubscriptionInput(input: LooseRecord, livemode: boolean) {
  const required = ["customerId", "idempotencyKey", "mode", "operationKind", "prorationDate", "sourcePriceId", "subscriptionId", "subscriptionItemId", "targetPriceId", "targetQuantity"];
  const keys = Object.keys(input ?? {}).filter((key) => key !== "targetProductId").sort();
  if (!input || typeof input !== "object" || Array.isArray(input)
    || keys.join("\0") !== required.join("\0")
    || !["sandbox", "live"].includes(input.mode) || (input.mode === "live") !== livemode
    || !["plan-transition", "seat-convergence"].includes(input.operationKind)
    || !validCustomerId(input.customerId) || !validSubscriptionId(input.subscriptionId)
    || !validSubscriptionItemId(input.subscriptionItemId)
    || !validPriceId(input.sourcePriceId) || !validPriceId(input.targetPriceId)
    || (input.targetProductId !== undefined && !validProductId(input.targetProductId))
    || !Number.isInteger(input.targetQuantity) || input.targetQuantity < 1 || input.targetQuantity > 999_999
    || !Number.isSafeInteger(input.prorationDate) || input.prorationDate < 1
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)) throw providerFailure(false);
}

function attestManagedSubscription(
  subscription: LooseRecord,
  input: LooseRecord,
  acceptedPriceIds: Set<string>,
  requireTarget: boolean,
) {
  const items = subscription?.items;
  if (subscription?.object !== "subscription" || subscription.id !== input.subscriptionId
    || subscription.customer !== input.customerId || subscription.livemode !== (input.mode === "live")
    || items?.object !== "list" || items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) {
    throw providerFailure(false);
  }
  const item = items.data[0];
  const price = item?.price;
  if (item?.object !== "subscription_item" || item.id !== input.subscriptionItemId
    || item.subscription !== input.subscriptionId || !acceptedPriceIds.has(price?.id)
    || price?.object !== "price" || price.livemode !== (input.mode === "live")
    || !validProductId(price?.product) || price?.recurring?.usage_type !== "licensed"
    || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999_999
    || (requireTarget && price.id !== input.targetPriceId)
    || (requireTarget && item.quantity !== input.targetQuantity)
    || (requireTarget && input.targetProductId !== undefined && price.product !== input.targetProductId)) {
    throw providerFailure(false);
  }
}

function validCustomerId(value: any) {
  return typeof value === "string" && /^cus_[A-Za-z0-9_]{1,120}$/.test(value);
}

function validSubscriptionId(value: any) {
  return typeof value === "string" && /^sub_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validSubscriptionItemId(value: any) {
  return typeof value === "string" && /^si_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPriceId(value: any) {
  return typeof value === "string" && /^price_[A-Za-z0-9_]{1,249}$/.test(value);
}

function validProductId(value: any) {
  return typeof value === "string" && /^prod_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validatePortalConfigurationInput(input: LooseRecord) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join("\0") !== ["configurationId", "expectedProducts", "mode"].join("\0")
    || !validPortalConfigurationId(input.configurationId) || !["sandbox", "live"].includes(input.mode)
    || !Array.isArray(input.expectedProducts) || input.expectedProducts.length < 1) throw providerFailure(false);

  let previousProductId = "";
  const seenPrices = new Set<string>();
  for (const product of input.expectedProducts) {
    if (!product || typeof product !== "object" || Array.isArray(product)
      || Object.keys(product).sort().join("\0") !== "priceIds\0productId"
      || typeof product.productId !== "string" || !/^prod_[A-Za-z0-9_]{1,240}$/.test(product.productId)
      || product.productId <= previousProductId || !Array.isArray(product.priceIds) || product.priceIds.length < 1) throw providerFailure(false);
    previousProductId = product.productId;
    let previousPriceId = "";
    for (const priceId of product.priceIds) {
      if (typeof priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(priceId)
        || priceId <= previousPriceId || seenPrices.has(priceId)) throw providerFailure(false);
      previousPriceId = priceId;
      seenPrices.add(priceId);
    }
  }
}

function validatePortalInput(input: LooseRecord) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join("\0") !== ["configurationId", "customerId", "idempotencyKey", "returnPath"].join("\0")
    || !validPortalConfigurationId(input.configurationId)
    || typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)
    || !validReturnPath(input.returnPath)
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)) throw providerFailure(false);
}

function attestPortalConfiguration(portalConfiguration: LooseRecord, input: LooseRecord, livemode: boolean) {
  const subscriptionUpdate = portalConfiguration?.features?.subscription_update;
  if (portalConfiguration?.object !== "billing_portal.configuration"
    || portalConfiguration.id !== input.configurationId || portalConfiguration.active !== true
    || portalConfiguration.livemode !== livemode || (input.mode === "live") !== livemode
    || portalConfiguration.features?.payment_method_update?.enabled !== true
    || portalConfiguration.features?.invoice_history?.enabled !== true
    || portalConfiguration.features?.subscription_cancel?.enabled !== true
    || portalConfiguration.features?.subscription_cancel?.mode !== "at_period_end"
    || subscriptionUpdate?.enabled !== true
    || !sameExactStringList(subscriptionUpdate.default_allowed_updates, ["price"])
    || !sameExactPortalProducts(subscriptionUpdate.products, input.expectedProducts)) throw providerFailure(false);
}

function sameExactPortalProducts(actual: any, expected: any[]) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized: Array<{ productId: string; priceIds: string[] }> = [];
  const seenProducts = new Set<string>();
  const seenPrices = new Set<string>();
  for (const product of actual) {
    if (!product || typeof product !== "object" || Array.isArray(product)
      || typeof product.product !== "string" || seenProducts.has(product.product)
      || product.adjustable_quantity?.enabled !== false || !Array.isArray(product.prices) || product.prices.length < 1) return false;
    seenProducts.add(product.product);
    const priceIds: string[] = [];
    for (const priceId of product.prices) {
      if (typeof priceId !== "string" || seenPrices.has(priceId) || priceIds.includes(priceId)) return false;
      priceIds.push(priceId);
      seenPrices.add(priceId);
    }
    priceIds.sort();
    normalized.push({ productId: product.product, priceIds });
  }
  normalized.sort((left, right) => left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0);
  return JSON.stringify(normalized) === JSON.stringify(expected);
}

function sameExactStringList(actual: any, expected: string[]) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validPortalConfigurationId(value: any) {
  return typeof value === "string" && /^bpc_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPortalSessionId(value: any) {
  return typeof value === "string" && /^bps_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPortalUrl(value: any) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "billing.stripe.com"
      && /^\/p\/session\/[A-Za-z0-9_-]{8,1024}$/.test(url.pathname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function throwProviderOperationFailure(error: any): never {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
  const status = Number(error?.statusCode);
  throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
}

function validateInput(input: LooseRecord) {
  const required = ["businessReference", "cancelPath", "idempotencyKey", "mode", "operationId", "priceId", "productKey", "providerExpiresAt", "quantity", "successPath", "teamId"];
  const keys = Object.keys(input ?? {}).filter((key) => key !== "customerId").sort();
  if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== required.sort().join("\0")
    || input.mode !== "subscription" || !validUuid(input.operationId) || input.businessReference !== input.operationId
    || !validUuid(input.teamId) || typeof input.productKey !== "string"
    || typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(input.priceId)
    || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999_999
    || !Number.isInteger(input.providerExpiresAt)
    || !validReturnPath(input.successPath) || !validReturnPath(input.cancelPath)
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)
    || (input.customerId !== undefined && (typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)))) throw providerFailure(false);
}

function validReturnPath(value: any) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
    || value.includes("\\") || value.includes("?") || value.includes("#") || /\s/.test(value)) return false;
  try { return new URL(value, "https://sporades.invalid").pathname === value; } catch { return false; }
}

function validUuid(value: any) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSessionId(value: any) {
  return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validUrl(value: any, sessionId: string) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
      && (url.pathname === `/c/pay/${sessionId}` || url.pathname === `/pay/${sessionId}`)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function loopbackProvider(value: any) {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw providerFailure(false); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw providerFailure(false);
  return { protocol: url.protocol.slice(0, -1) as "http" | "https", host: url.hostname, port: url.port };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error: any = new Error("Team Checkout provider operation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function providerFailure(retryable: boolean) {
  const error: any = new Error("Team Checkout provider operation failed.");
  error.code = retryable ? "TEAM_BILLING_PROVIDER_UNAVAILABLE" : "TEAM_BILLING_PROVIDER_REJECTED";
  error.retryable = retryable;
  return error;
}
