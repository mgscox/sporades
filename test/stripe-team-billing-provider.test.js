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

const managedSubscriptionInput = {
  mode: "sandbox",
  customerId: "cus_existing_team",
  subscriptionId: "sub_managed_team",
  subscriptionItemId: "si_managed_team",
  sourcePriceId: "price_test_agency_monthly",
  targetPriceId: "price_test_studio_monthly",
  targetProductId: "prod_studio",
  targetQuantity: 17,
  prorationDate: 2_000_000_123,
  idempotencyKey: "sporades:team-subscription-update:stable-provider-key",
  operationKind: "plan-transition",
};

const erasureInput = {
  mode: "sandbox",
  customerId: "cus_existing_team",
  checkoutSessionIds: ["cs_test_erasure_complete", "cs_test_erasure_open", "cs_test_erasure_open_race"],
  subscriptionIds: ["sub_erasure_known"],
  idempotencyKey: "sporades:team-erasure:stable-provider-key",
};

test("provider-safe erasure expires open Checkouts and immediately cancels known and newly discovered Subscriptions", async () => {
  const observed = [];
  let listPass = 0;
  let racingCheckoutRetrieves = 0;
  await withProvider(async (request, response) => {
    observed.push({ method: request.method, url: request.url, idempotencyKey: request.headers["idempotency-key"] });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_open" && request.method === "GET") {
      response.end(JSON.stringify(validErasureCheckout("cs_test_erasure_open", "open"))); return;
    }
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_open/expire") {
      response.end(JSON.stringify(validErasureCheckout("cs_test_erasure_open", "expired"))); return;
    }
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_open_race" && request.method === "GET") {
      racingCheckoutRetrieves += 1;
      response.end(JSON.stringify(racingCheckoutRetrieves === 1
        ? validErasureCheckout("cs_test_erasure_open_race", "open")
        : { ...validErasureCheckout("cs_test_erasure_open_race", "complete"),
          customer: erasureInput.customerId, subscription: "sub_erasure_from_expire_race" })); return;
    }
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_open_race/expire") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: {
        type: "invalid_request_error",
        message: "Only Checkout Sessions with a status in [\"open\"] can be expired. This Checkout Session has a status of `complete`.",
      } })); return;
    }
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_complete") {
      response.end(JSON.stringify({ ...validErasureCheckout("cs_test_erasure_complete", "complete"),
        customer: erasureInput.customerId, subscription: "sub_erasure_from_checkout" })); return;
    }
    if (request.url?.startsWith("/v1/subscriptions?")) {
      listPass += 1;
      const status = listPass === 1 ? "active" : "canceled";
      response.end(JSON.stringify({ object: "list", has_more: false, data: [
        validErasureSubscription("sub_erasure_known", status),
        validErasureSubscription("sub_erasure_from_checkout", "canceled"),
        validErasureSubscription("sub_erasure_from_expire_race", "canceled"),
        validErasureSubscription("sub_erasure_discovered", status),
      ] })); return;
    }
    if (request.method === "DELETE" && request.url?.startsWith("/v1/subscriptions/")) {
      response.end(JSON.stringify(validErasureSubscription(request.url.split("/").at(-1), "canceled"))); return;
    }
    response.writeHead(500).end();
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    const result = await provider.quiesceTeamBilling(erasureInput);
    assert.deepEqual(result.checkouts, [
      { id: "cs_test_erasure_complete", state: "complete" },
      { id: "cs_test_erasure_open", state: "expired" },
      { id: "cs_test_erasure_open_race", state: "complete" },
    ]);
    assert.deepEqual(result.subscriptions, [
      { id: "sub_erasure_discovered", state: "cancelled" },
      { id: "sub_erasure_from_checkout", state: "cancelled" },
      { id: "sub_erasure_from_expire_race", state: "cancelled" },
      { id: "sub_erasure_known", state: "cancelled" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "quiesced");
  });
  const cancellations = observed.filter((entry) => entry.method === "DELETE");
  assert.deepEqual(cancellations.map((entry) => entry.url).sort(), [
    "/v1/subscriptions/sub_erasure_discovered", "/v1/subscriptions/sub_erasure_known",
  ]);
  assert.ok(cancellations.every((entry) => /^sporades-team-billing-cancel-[a-f0-9]{64}$/.test(entry.idempotencyKey)));
  assert.equal(racingCheckoutRetrieves, 2, "the exact non-expireable response is resolved by fresh provider evidence");
});

test("provider-safe erasure treats exact 404 resources as safely closed without inventing provider state", async () => {
  await withProvider(async (_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: "raw provider detail" } }));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    const result = await provider.quiesceTeamBilling({
      mode: "sandbox", checkoutSessionIds: ["cs_test_erasure_missing"], subscriptionIds: ["sub_erasure_missing"],
      idempotencyKey: erasureInput.idempotencyKey,
    });
    assert.deepEqual(result.checkouts, [{ id: "cs_test_erasure_missing", state: "safely-closed" }]);
    assert.deepEqual(result.subscriptions, [{ id: "sub_erasure_missing", state: "safely-closed" }]);
    assert.equal(JSON.stringify(result).includes("raw provider detail"), false);
  });
});

test("provider-safe erasure does not reclassify a different invalid-request response as a completion race", async () => {
  let retrieves = 0;
  await withProvider(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      retrieves += 1;
      response.end(JSON.stringify(validErasureCheckout("cs_test_erasure_wrong_error", "open"))); return;
    }
    response.writeHead(400);
    response.end(JSON.stringify({ error: {
      type: "invalid_request_error",
      message: "Only Checkout Sessions with a status in [\"open\"] can be expired. This request was rejected for another reason.",
    } }));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    await assert.rejects(provider.quiesceTeamBilling({
      mode: "sandbox", checkoutSessionIds: ["cs_test_erasure_wrong_error"], subscriptionIds: [],
      idempotencyKey: erasureInput.idempotencyKey,
    }), (error) => error?.code === "TEAM_BILLING_PROVIDER_REJECTED" && error?.retryable === false);
  });
  assert.equal(retrieves, 1, "only the exact non-expireable response permits a verification re-read");
});

test("provider-safe erasure replays a lost Checkout response with the original exact idempotent request", async () => {
  let created;
  await withProvider(async (request, response) => {
    const body = await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/checkout/sessions" && request.method === "POST") {
      created = { key: request.headers["idempotency-key"], params: new URLSearchParams(body) };
      response.end(JSON.stringify({
        ...validErasureCheckout("cs_test_erasure_recovered", "expired"),
        mode: "subscription", client_reference_id: input.operationId,
        expires_at: input.providerExpiresAt,
        url: "https://checkout.stripe.com/c/pay/cs_test_erasure_recovered#fixture",
      })); return;
    }
    if (request.url === "/v1/checkout/sessions/cs_test_erasure_recovered") {
      response.end(JSON.stringify(validErasureCheckout("cs_test_erasure_recovered", "expired"))); return;
    }
    if (request.url?.startsWith("/v1/subscriptions?")) {
      response.end(JSON.stringify({ object: "list", has_more: false, data: [] })); return;
    }
    response.writeHead(500).end();
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    const result = await provider.quiesceTeamBilling({
      mode: "sandbox", customerId: input.customerId, checkoutSessionIds: [], subscriptionIds: [],
      checkoutRecoveries: [input], idempotencyKey: erasureInput.idempotencyKey,
    });
    assert.deepEqual(result.checkouts, [{ id: "cs_test_erasure_recovered", state: "expired" }]);
  });
  assert.equal(created.key, input.idempotencyKey);
  assert.equal(created.params.get("line_items[0][price]"), input.priceId);
  assert.equal(created.params.get("line_items[0][quantity]"), String(input.quantity));
  assert.equal(created.params.get("client_reference_id"), input.operationId);
  assert.equal(created.params.get("expires_at"), String(input.providerExpiresAt));
});

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

test("managed subscription updates attest current state and send one stable atomic Price and quantity change", async () => {
  const observed = [];
  await withProvider(async (request, response) => {
    const body = await readBody(request);
    observed.push({ method: request.method, url: request.url, headers: request.headers, params: new URLSearchParams(body) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET"
      ? validManagedSubscription({ priceId: managedSubscriptionInput.sourcePriceId, productId: "prod_agency", quantity: 14 })
      : validManagedSubscription()));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    assert.deepEqual(await provider.updateManagedSubscription(managedSubscriptionInput), { ok: true, outcome: "acknowledged" });
  });

  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: `/v1/subscriptions/${managedSubscriptionInput.subscriptionId}` },
    { method: "POST", url: `/v1/subscriptions/${managedSubscriptionInput.subscriptionId}` },
  ]);
  assert.equal(observed[1].headers["idempotency-key"], managedSubscriptionInput.idempotencyKey);
  assert.equal(observed[1].params.get("items[0][id]"), managedSubscriptionInput.subscriptionItemId);
  assert.equal(observed[1].params.get("items[0][price]"), managedSubscriptionInput.targetPriceId);
  assert.equal(observed[1].params.get("items[0][quantity]"), "17");
  assert.equal(observed[1].params.get("proration_behavior"), "create_prorations");
  assert.equal(observed[1].params.get("proration_date"), String(managedSubscriptionInput.prorationDate));
  assert.equal(observed[1].params.get("payment_behavior"), "pending_if_incomplete");
});

test("managed subscription updates surface a bounded payment-action result without provider identifiers", async () => {
  for (const paymentState of [
    { pendingUpdate: { expires_at: 2_000_086_523 } },
    { status: "past_due" },
  ]) {
    await withProvider(async (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.method === "GET"
        ? validManagedSubscription({ priceId: managedSubscriptionInput.targetPriceId })
        : validManagedSubscription(paymentState)));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      const result = await provider.updateManagedSubscription(managedSubscriptionInput);
      assert.deepEqual(result, { ok: true, outcome: "payment-action-required" });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(JSON.stringify(result).includes("sub_managed_team"), false);
    });
  }
});

test("managed subscription updates enforce the exact mode and operation envelope while allowing a declaration without Product", async () => {
  for (const override of [
    { mode: "live" },
    { operationKind: "portal-change" },
    { prorationDate: 2_000_000_123.5 },
    { unexpected: true },
  ]) {
    let requestCount = 0;
    await withProvider((_request, response) => {
      requestCount += 1;
      response.writeHead(500).end();
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.updateManagedSubscription({ ...managedSubscriptionInput, ...override }), rejectedProviderFailure);
    });
    assert.equal(requestCount, 0);
  }

  const { targetProductId: _omittedProduct, ...withoutProduct } = managedSubscriptionInput;
  await withProvider(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(validManagedSubscription()));
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    assert.deepEqual(await provider.updateManagedSubscription({
      ...withoutProduct,
      operationKind: "seat-convergence",
      sourcePriceId: withoutProduct.targetPriceId,
    }), { ok: true, outcome: "acknowledged" });
  });
});

test("managed subscription updates reject incomplete lists and every correlation or catalogue drift", async () => {
  const invalidRetrieved = [
    { items: { has_more: true } },
    { items: { data: [validManagedItem(), validManagedItem({ id: "si_another" })] } },
    { customer: "cus_another_team" },
    { livemode: true },
    { id: "sub_another_team" },
    { items: { data: [validManagedItem({ id: "si_another" })] } },
    { items: { data: [validManagedItem({ subscription: "sub_another_team" })] } },
    { items: { data: [validManagedItem({ priceId: "price_unknown" })] } },
    { items: { data: [validManagedItem({ productId: "product_unknown" })] } },
    { items: { data: [validManagedItem({ usageType: "metered" })] } },
  ];
  for (const override of invalidRetrieved) {
    let requestCount = 0;
    await withProvider((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(mergeManagedSubscription(validManagedSubscription({ priceId: managedSubscriptionInput.sourcePriceId, productId: "prod_agency" }), override)));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.updateManagedSubscription(managedSubscriptionInput), rejectedProviderFailure);
    });
    assert.equal(requestCount, 1);
  }

  for (const override of [
    { customer: "cus_another_team" },
    { items: { has_more: true } },
    { items: { data: [validManagedItem({ priceId: managedSubscriptionInput.sourcePriceId })] } },
    { items: { data: [validManagedItem({ quantity: 16 })] } },
    { items: { data: [validManagedItem({ productId: "prod_unknown" })] } },
  ]) {
    await withProvider(async (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.method === "GET"
        ? validManagedSubscription({ priceId: managedSubscriptionInput.sourcePriceId, productId: "prod_agency" })
        : mergeManagedSubscription(validManagedSubscription(), override)));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.updateManagedSubscription(managedSubscriptionInput), rejectedProviderFailure);
    });
  }
});

test("managed subscription updates classify retryable provider failures without retaining raw errors", async () => {
  for (const [status, retryable] of [[400, false], [408, true], [409, true], [429, true], [500, true]]) {
    await withProvider((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `raw-secret-provider-message-${status}`, type: "fixture" } }));
    }, async (apiBaseUrl) => {
      const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
      await assert.rejects(provider.updateManagedSubscription(managedSubscriptionInput), (error) => {
        assert.equal(error?.retryable, retryable);
        assert.equal(error?.code, retryable ? "TEAM_BILLING_PROVIDER_UNAVAILABLE" : "TEAM_BILLING_PROVIDER_REJECTED");
        assert.equal(String(error?.message).includes("raw-secret"), false);
        assert.equal(String(error?.message).includes(managedSubscriptionInput.subscriptionId), false);
        return true;
      });
    });
  }

  await withProvider((request) => {
    request.socket.destroy();
  }, async (apiBaseUrl) => {
    const provider = createStripeTeamBillingProvider({ config, env: { STRIPE_SECRET_KEY: "sk_test_team_provider" }, apiBaseUrl });
    await assert.rejects(provider.updateManagedSubscription(managedSubscriptionInput), (error) => {
      assert.equal(error?.code, "TEAM_BILLING_PROVIDER_UNAVAILABLE");
      assert.equal(error?.retryable, true);
      assert.equal(String(error?.message).includes(managedSubscriptionInput.subscriptionId), false);
      return true;
    });
  });
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

function validErasureCheckout(id, status) {
  return { id, object: "checkout.session", mode: "subscription", livemode: false, status };
}

function validErasureSubscription(id, status) {
  return { id, object: "subscription", customer: erasureInput.customerId, livemode: false, status };
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

function validManagedItem({
  id = managedSubscriptionInput.subscriptionItemId,
  subscription = managedSubscriptionInput.subscriptionId,
  priceId = managedSubscriptionInput.targetPriceId,
  productId = managedSubscriptionInput.targetProductId,
  quantity = managedSubscriptionInput.targetQuantity,
  usageType = "licensed",
} = {}) {
  return {
    id,
    object: "subscription_item",
    subscription,
    quantity,
    price: {
      id: priceId,
      object: "price",
      active: true,
      livemode: false,
      product: productId,
      recurring: { interval: "month", usage_type: usageType },
    },
  };
}

function validManagedSubscription({
  priceId = managedSubscriptionInput.targetPriceId,
  productId = managedSubscriptionInput.targetProductId,
  quantity = managedSubscriptionInput.targetQuantity,
  pendingUpdate = null,
  status = "active",
} = {}) {
  return {
    id: managedSubscriptionInput.subscriptionId,
    object: "subscription",
    customer: managedSubscriptionInput.customerId,
    livemode: false,
    status,
    pending_update: pendingUpdate,
    items: {
      object: "list",
      has_more: false,
      data: [validManagedItem({ priceId, productId, quantity })],
    },
  };
}

function mergeManagedSubscription(base, override) {
  return {
    ...base,
    ...override,
    items: override.items ? { ...base.items, ...override.items } : base.items,
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
