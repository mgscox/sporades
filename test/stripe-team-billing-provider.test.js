import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createStripeTeamBillingProvider } from "../dist/stripe-team-billing-provider.js";

const config = {
  enabled: true,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://billing.example.test",
  callbackPath: "/stripe/webhook",
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
};

const input = {
  operationId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  productKey: "agency",
  mode: "subscription",
  priceId: "price_test_agency",
  quantity: 999_999,
  successPath: "/settings/billing/success",
  cancelPath: "/settings/billing/cancelled",
  idempotencyKey: "sporades:team-checkout:stable-provider-key",
  businessReference: "11111111-1111-4111-8111-111111111111",
  providerExpiresAt: 2_000_000_000,
  customerId: "cus_existing_team",
};

const portalConfigurationInput = {
  configurationId: "bpc_team_billing_test",
  mode: "sandbox",
  expectedProducts: [
    { productId: "prod_agency", priceIds: ["price_test_agency_monthly"] },
    { productId: "prod_studio", priceIds: ["price_test_studio_monthly", "price_test_studio_yearly"] },
  ],
};

const portalInput = {
  customerId: "cus_existing_team",
  configurationId: "bpc_team_billing_test",
  returnPath: "/settings/billing",
  idempotencyKey: "sporades:team-portal:stable-provider-key",
};

test("the internal Team Billing provider sends one exact subscription Checkout envelope", async () => {
  let observed;
  await withProvider(async (request, response) => {
    const body = await readBody(request);
    observed = { url: request.url, headers: request.headers, params: new URLSearchParams(body) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "cs_test_team_provider_1",
      object: "checkout.session",
      mode: "subscription",
      livemode: false,
      client_reference_id: input.operationId,
      customer: input.customerId,
      expires_at: input.providerExpiresAt,
      url: "https://checkout.stripe.com/c/pay/cs_test_team_provider_1#fixture",
    }));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({
      config,
      env: { STRIPE_SECRET_KEY: "sk_test_team_provider" },
      apiBaseUrl,
    });
    assert.deepEqual(await provider.create(input), {
      ok: true,
      sessionId: "cs_test_team_provider_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_team_provider_1#fixture",
    });
  });
  assert.equal(observed.url, "/v1/checkout/sessions");
  assert.equal(observed.headers["idempotency-key"], input.idempotencyKey);
  assert.equal(observed.params.get("mode"), "subscription");
  assert.equal(observed.params.get("line_items[0][price]"), input.priceId);
  assert.equal(observed.params.get("line_items[0][quantity]"), "999999");
  assert.equal(observed.params.get("customer"), input.customerId);
  assert.equal(observed.params.get("client_reference_id"), input.operationId);
  assert.equal(observed.params.get("metadata[sporades_team_billing_operation]"), input.operationId);
  assert.equal(observed.params.get("subscription_data[metadata][sporades_team_billing_operation]"), input.operationId);
  assert.equal(observed.params.get("expires_at"), String(input.providerExpiresAt));
  assert.equal(observed.params.get("success_url"), "https://billing.example.test/settings/billing/success");
  assert.equal(observed.params.get("cancel_url"), "https://billing.example.test/settings/billing/cancelled");
});

test("the internal Team Billing provider attests one explicit Portal configuration before creating a session", async () => {
  const observed = [];
  await withProvider(async (request, response) => {
    const body = await readBody(request);
    observed.push({ url: request.url, headers: request.headers, params: new URLSearchParams(body) });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === `/v1/billing_portal/configurations/${portalConfigurationInput.configurationId}`) {
      response.end(JSON.stringify(validPortalConfiguration()));
      return;
    }
    response.end(JSON.stringify({
      id: "bps_test_team_portal_1",
      object: "billing_portal.session",
      configuration: portalInput.configurationId,
      customer: portalInput.customerId,
      livemode: false,
      return_url: "https://billing.example.test/settings/billing",
      url: "https://billing.stripe.com/p/session/bps_test_team_portal_1#fixture",
    }));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({
      config,
      env: { STRIPE_SECRET_KEY: "sk_test_team_provider" },
      apiBaseUrl,
    });
    assert.deepEqual(await provider.retrievePortalConfiguration(portalConfigurationInput), { ok: true });
    assert.deepEqual(await provider.createPortal(portalInput), {
      ok: true,
      sessionId: "bps_test_team_portal_1",
      url: "https://billing.stripe.com/p/session/bps_test_team_portal_1#fixture",
    });
  });

  assert.equal(observed[0].url, `/v1/billing_portal/configurations/${portalConfigurationInput.configurationId}`);
  assert.equal(observed[1].url, "/v1/billing_portal/sessions");
  assert.equal(observed[1].headers["idempotency-key"], portalInput.idempotencyKey);
  assert.equal(observed[1].params.get("customer"), portalInput.customerId);
  assert.equal(observed[1].params.get("configuration"), portalInput.configurationId);
  assert.equal(observed[1].params.get("return_url"), "https://billing.example.test/settings/billing");
});

test("Portal configuration attestation rejects mutable defaults and every catalogue drift", async () => {
  const invalidConfigurations = [
    { active: false },
    { livemode: true },
    { features: { payment_method_update: { enabled: false } } },
    { features: { invoice_history: { enabled: false } } },
    { features: { subscription_cancel: { mode: "immediately" } } },
    { features: { subscription_update: { default_allowed_updates: ["price", "quantity"] } } },
    { features: { subscription_update: { products: [{ product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: true } }, { product: "prod_studio", prices: ["price_test_studio_monthly", "price_test_studio_yearly"], adjustable_quantity: { enabled: false } }] } } },
    { features: { subscription_update: { products: [{ product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } }] } } },
    { features: { subscription_update: { products: [{ product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } }, { product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } }, { product: "prod_studio", prices: ["price_test_studio_monthly", "price_test_studio_yearly"], adjustable_quantity: { enabled: false } }] } } },
    { features: { subscription_update: { products: [{ product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } }, { product: "prod_studio", prices: ["price_test_studio_monthly", "price_test_extra"], adjustable_quantity: { enabled: false } }] } } },
    { features: { subscription_update: { products: [{ product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } }, { product: "prod_studio", prices: ["price_test_studio_monthly", "price_test_studio_monthly", "price_test_studio_yearly"], adjustable_quantity: { enabled: false } }] } } },
  ];
  for (const override of invalidConfigurations) {
    await withProvider((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(mergePortalConfiguration(validPortalConfiguration(), override)));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.retrievePortalConfiguration(portalConfigurationInput), rejectedProviderFailure);
    });
  }
});

test("Portal session creation rejects mismatched provider correlation and unsafe continuations", async () => {
  for (const override of [
    { customer: "cus_another_team" },
    { configuration: "bpc_mutable_default" },
    { livemode: true },
    { return_url: "https://elsewhere.example/settings/billing" },
    { id: "portal_invalid" },
    { url: "https://example.test/p/session/bps_test_team_portal_1" },
  ]) {
    await withProvider((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "bps_test_team_portal_1",
        object: "billing_portal.session",
        configuration: portalInput.configurationId,
        customer: portalInput.customerId,
        livemode: false,
        return_url: "https://billing.example.test/settings/billing",
        url: "https://billing.stripe.com/p/session/bps_test_team_portal_1#fixture",
        ...override,
      }));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.createPortal(portalInput), rejectedProviderFailure);
    });
  }
});

function validPortalConfiguration() {
  return {
    id: portalConfigurationInput.configurationId,
    object: "billing_portal.configuration",
    active: true,
    livemode: false,
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        products: [
          { product: "prod_agency", prices: ["price_test_agency_monthly"], adjustable_quantity: { enabled: false } },
          { product: "prod_studio", prices: ["price_test_studio_monthly", "price_test_studio_yearly"], adjustable_quantity: { enabled: false } },
        ],
      },
    },
  };
}

function mergePortalConfiguration(base, override) {
  return {
    ...base,
    ...override,
    features: {
      ...base.features,
      ...override.features,
      subscription_cancel: { ...base.features.subscription_cancel, ...override.features?.subscription_cancel },
      subscription_update: { ...base.features.subscription_update, ...override.features?.subscription_update },
    },
  };
}

function rejectedProviderFailure(error) {
  return error?.code === "TEAM_BILLING_PROVIDER_REJECTED" && error?.retryable === false;
}

async function withProvider(handler, run) {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
