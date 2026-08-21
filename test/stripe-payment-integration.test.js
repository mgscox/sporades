import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";
import { createStripePaymentIntegration } from "sporades/server/stripe";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabledConfig = {
  enabled: true,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://payments.example.test",
  callbackPath: "/stripe/webhook",
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
};

function checkoutInput(intent = "intent-protocol-1") {
  return {
    mode: "payment",
    priceId: "price_server_owned",
    quantity: 1,
    successPath: "/payments/success",
    cancelPath: "/payments/cancelled",
    idempotencyKey: `capsule:checkout:user-1:${intent}`,
    businessReference: intent,
  };
}

function portalInput(intent = "intent-portal-1") {
  return {
    customerId: "cus_server_owned",
    returnPath: "/account/billing",
    idempotencyKey: `capsule:portal:user-1:${intent}`,
  };
}

async function withStripeFake(handler, run) {
  const server = createServer(handler);
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

test("Sporades pins the official server Stripe SDK to the tested Ticket 02 range", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.stripe, "^22.5.0");
  assert.deepEqual(packageJson.exports["./server/stripe"], {
    types: "./src/types/stripe.d.ts",
    default: "./dist/stripe-payment-integration.js",
  });
  assert.equal(typeof Stripe, "function");
});

test("the server-only Stripe integration exposes only narrow disabled payment operations", async () => {
  const integration = createStripePaymentIntegration({ enabled: false });

  assert.deepEqual(Object.keys(integration).sort(), [
    "createCheckoutSession",
    "createCustomerPortalSession",
    "verifyWebhookEvent",
  ]);

  const expected = {
    ok: false,
    error: {
      code: "STRIPE_PAYMENTS_DISABLED",
      message: "Stripe payments are disabled.",
      hint: "Configure server-owned Prices and Sealed Server env, then enable payments.stripe in sporades.json.",
    },
  };
  assert.deepEqual(await integration.createCheckoutSession({}), expected);
  assert.deepEqual(await integration.createCustomerPortalSession({}), expected);
  assert.deepEqual(await integration.verifyWebhookEvent({}), expected);
  assert.equal("request" in integration, false);
  assert.equal("client" in integration, false);
});

test("the integration grants no authority when activation options are incomplete", () => {
  assert.throws(
    () => createStripePaymentIntegration({ enabled: true }),
    (error) => {
      assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
      assert.match(error.message, /configuration/i);
      assert.match(error.hint, /payments\.stripe/i);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /sk_|whsec_|price_|cus_/i);
      return true;
    },
  );
});

test("Stripe webhook verification preserves exact bytes and returns one bounded verified event", async () => {
  const secret = "whsec_protocol_fixture";
  const occurredAtSeconds = Math.floor(Date.now() / 1000);
  const compact = JSON.stringify({
    id: "evt_protocol_exact_1",
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: occurredAtSeconds,
    data: { object: { id: "cs_test_exact_1", object: "checkout.session", customer: "cus_exact_1" } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: "req_exact_1", idempotency_key: null },
    type: "checkout.session.completed",
  });
  const reordered = `{ "type": "checkout.session.completed", "request": { "id": "req_exact_1", "idempotency_key": null }, "pending_webhooks": 1, "livemode": false, "data": { "object": { "customer": "cus_exact_1", "object": "checkout.session", "id": "cs_test_exact_1" } }, "created": ${occurredAtSeconds}, "api_version": "2026-07-29.dahlia", "object": "event", "id": "evt_protocol_exact_1" }`;
  assert.deepEqual(JSON.parse(compact), JSON.parse(reordered));
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: compact, secret, timestamp: occurredAtSeconds });
  const integration = createStripePaymentIntegration({
    enabled: true,
    config: enabledConfig,
    env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: secret },
  });

  const event = await integration.verifyWebhookEvent({
    bodyBytes: new TextEncoder().encode(compact),
    signature,
  });

  assert.deepEqual(event, {
    provider: "stripe",
    providerEventId: "evt_protocol_exact_1",
    type: "checkout.session.completed",
    occurredAt: new Date(occurredAtSeconds * 1000).toISOString(),
    livemode: false,
    objectId: "cs_test_exact_1",
    raw: JSON.parse(compact),
  });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.raw), true);
  assert.equal(Object.isFrozen(event.raw.data.object), true);

  await assert.rejects(
    integration.verifyWebhookEvent({ bodyBytes: new TextEncoder().encode(reordered), signature }),
    (error) => {
      assert.equal(error.code, "STRIPE_WEBHOOK_REJECTED");
      assert.equal(error.retryable, false);
      assert.deepEqual(Object.keys(error).sort(), ["code", "hint", "retryable"]);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /signature|whsec_|expected|payload|json|evt_protocol/i);
      return true;
    },
  );
});

test("Stripe webhook verification opaquely rejects unsafe request shapes", async () => {
  const secret = "whsec_protocol_fixture";
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_protocol_invalid_1", object: "event", created: now, data: { object: { object: "customer" } }, livemode: false, type: "customer.updated" });
  const validSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now });
  const staleSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now - 301 });
  const oversizedPayload = "x".repeat(60 * 1024 + 1);
  const malformedEvent = JSON.stringify({ id: "evt_protocol_invalid_shape", object: "not-an-event", created: now, data: { object: {} }, livemode: false, type: "customer.updated" });
  const integration = createStripePaymentIntegration({ enabled: true, config: enabledConfig, env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: secret } });

  for (const input of [
    { bodyBytes: new TextEncoder().encode(payload) },
    { bodyBytes: new TextEncoder().encode(payload), signature: "malformed" },
    { bodyBytes: new TextEncoder().encode(payload), signature: validSignature.replace(/v1=[^,]+/, "v1=wrong") },
    { bodyBytes: new TextEncoder().encode(payload), signature: staleSignature },
    { bodyBytes: new TextEncoder().encode("not-json"), signature: Stripe.webhooks.generateTestHeaderString({ payload: "not-json", secret, timestamp: now }) },
    { bodyBytes: new TextEncoder().encode(oversizedPayload), signature: Stripe.webhooks.generateTestHeaderString({ payload: oversizedPayload, secret, timestamp: now }) },
    { bodyBytes: new TextEncoder().encode(malformedEvent), signature: Stripe.webhooks.generateTestHeaderString({ payload: malformedEvent, secret, timestamp: now }) },
    { bodyBytes: new TextEncoder().encode(payload), signature: validSignature, unexpected: true },
  ]) {
    await assert.rejects(integration.verifyWebhookEvent(input), (error) => {
      assert.equal(error.code, "STRIPE_WEBHOOK_REJECTED");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /signature|whsec_|expected|payload|json|evt_protocol|malformed/i);
      return true;
    });
  }

  const wrongSecretIntegration = createStripePaymentIntegration({
    enabled: true,
    config: enabledConfig,
    env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_wrong_protocol_fixture" },
  });
  await assert.rejects(
    wrongSecretIntegration.verifyWebhookEvent({ bodyBytes: new TextEncoder().encode(payload), signature: validSignature }),
    (error) => error.code === "STRIPE_WEBHOOK_REJECTED" && error.retryable === false,
  );
});

test("one-time Checkout sends only server-owned authority and returns a narrow validated redirect", async () => {
  const requests = [];
  await withStripeFake(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: new URLSearchParams(body) });
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_protocol" });
    response.end(JSON.stringify({
      id: "cs_test_checkout_123",
      object: "checkout.session",
      livemode: false,
      mode: "payment",
      url: "https://checkout.stripe.com/c/pay/cs_test_checkout_123#fixture",
    }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: {
        STRIPE_SECRET_KEY: "sk_test_protocol_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture",
      },
      apiBaseUrl,
    });
    assert.deepEqual(await integration.createCheckoutSession({
      mode: "payment",
      priceId: "price_server_owned",
      quantity: 2,
      successPath: "/payments/success",
      cancelPath: "/payments/cancelled",
      idempotencyKey: "capsule:checkout:user-1:intent-1",
      businessReference: "intent-1",
    }), {
      ok: true,
      sessionId: "cs_test_checkout_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_checkout_123#fixture",
    });
  });

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/checkout/sessions");
  assert.equal(request.headers.authorization, "Bearer sk_test_protocol_fixture");
  assert.equal(request.headers["idempotency-key"], "capsule:checkout:user-1:intent-1");
  assert.equal(request.headers["stripe-version"], "2026-07-29.dahlia");
  assert.equal(request.body.get("mode"), "payment");
  assert.equal(request.body.get("line_items[0][price]"), "price_server_owned");
  assert.equal(request.body.get("line_items[0][quantity]"), "2");
  assert.equal(request.body.get("success_url"), "https://payments.example.test/payments/success");
  assert.equal(request.body.get("cancel_url"), "https://payments.example.test/payments/cancelled");
  assert.equal(request.body.get("client_reference_id"), "intent-1");
});

test("subscription Checkout uses the same narrow operation with explicit server-owned mode", async () => {
  let providerRequest;
  await withStripeFake(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    providerRequest = { url: request.url, body: new URLSearchParams(body) };
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_subscription" });
    response.end(JSON.stringify({
      id: "cs_test_subscription_123",
      object: "checkout.session",
      livemode: false,
      mode: "subscription",
      url: "https://checkout.stripe.com/c/pay/cs_test_subscription_123#fixture",
    }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    assert.deepEqual(await integration.createCheckoutSession({
      mode: "subscription",
      priceId: "price_recurring_server_owned",
      quantity: 3,
      successPath: "/payments/success",
      cancelPath: "/payments/cancelled",
      idempotencyKey: "capsule:checkout:user-1:intent-subscription-1",
      businessReference: "intent-subscription-1",
    }), {
      ok: true,
      sessionId: "cs_test_subscription_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_subscription_123#fixture",
    });
  });

  assert.equal(providerRequest.url, "/v1/checkout/sessions");
  assert.equal(providerRequest.body.get("mode"), "subscription");
  assert.equal(providerRequest.body.get("line_items[0][price]"), "price_recurring_server_owned");
  assert.equal(providerRequest.body.get("line_items[0][quantity]"), "3");
  assert.equal(providerRequest.body.get("customer"), null);
  assert.equal(providerRequest.body.get("metadata"), null);
});

test("Customer Portal sends one server-resolved Customer and returns a narrow validated redirect", async () => {
  let providerRequest;
  await withStripeFake(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    providerRequest = { method: request.method, url: request.url, headers: request.headers, body: new URLSearchParams(body) };
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_portal" });
    response.end(JSON.stringify({
      id: "bps_test_portal_123",
      object: "billing_portal.session",
      customer: "cus_server_owned",
      livemode: false,
      return_url: "https://payments.example.test/account/billing",
      url: "https://billing.stripe.com/p/session/test_portal_token_123",
    }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    assert.deepEqual(await integration.createCustomerPortalSession(portalInput()), {
      ok: true,
      sessionId: "bps_test_portal_123",
      url: "https://billing.stripe.com/p/session/test_portal_token_123",
    });
  });

  assert.equal(providerRequest.method, "POST");
  assert.equal(providerRequest.url, "/v1/billing_portal/sessions");
  assert.equal(providerRequest.headers["idempotency-key"], "capsule:portal:user-1:intent-portal-1");
  assert.equal(providerRequest.body.get("customer"), "cus_server_owned");
  assert.equal(providerRequest.body.get("return_url"), "https://payments.example.test/account/billing");
  assert.equal(providerRequest.body.get("configuration"), null);
  assert.equal(providerRequest.body.get("flow_data"), null);
  assert.equal(providerRequest.body.get("on_behalf_of"), null);
});

test("Customer Portal rejects browser-shaped authority and untrusted return locations before provider access", async () => {
  let requests = 0;
  await withStripeFake((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    for (const input of [
      { ...portalInput(), customerId: "attacker-selected" },
      { ...portalInput(), returnPath: "https://attacker.example/billing" },
      { ...portalInput(), returnPath: "//attacker.example/billing" },
      { ...portalInput(), idempotencyKey: "short" },
      { ...portalInput(), configuration: "bpc_attacker" },
    ]) {
      await assert.rejects(integration.createCustomerPortalSession(input), (error) => {
        assert.match(error.code, /^STRIPE_PORTAL_(?:INPUT|RETURN_PATH)_INVALID$/);
        assert.equal(error.retryable, false);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /attacker|bpc_/i);
        return true;
      });
    }
  });
  assert.equal(requests, 0);
});

test("Customer Portal redacts permanent and transient provider failures", async () => {
  for (const [fixture, code, retryable] of [["rejected", "STRIPE_PORTAL_REJECTED", false], ["provider-500", "STRIPE_PORTAL_UNAVAILABLE", true], ["timeout", "STRIPE_PORTAL_UNAVAILABLE", true]]) {
    await withStripeFake(async (_request, response) => {
      if (fixture === "timeout") await new Promise((resolve) => setTimeout(resolve, 1_100));
      const status = fixture === "rejected" ? 400 : fixture === "provider-500" ? 500 : 200;
      response.writeHead(status, { "content-type": "application/json", "request-id": "req_portal_secret" });
      response.end(JSON.stringify({ error: { message: "cus_secret_fixture sk_test_protocol_fixture" } }));
    }, async (apiBaseUrl) => {
      const integration = createStripePaymentIntegration({
        enabled: true,
        config: { ...enabledConfig, requestTimeoutMs: fixture === "timeout" ? 1_000 : enabledConfig.requestTimeoutMs },
        env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
        apiBaseUrl,
      });
      await assert.rejects(integration.createCustomerPortalSession(portalInput(`intent-${fixture}`)), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /cus_secret|sk_test_|req_portal_secret/);
        return true;
      });
    });
  }
});

test("Customer Portal cancellation and malformed provider authority fail safely", async () => {
  await withStripeFake(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "bps_cancelled", customer: "cus_server_owned", livemode: false, return_url: "https://payments.example.test/account/billing", url: "https://billing.stripe.com/p/session/test_cancelled" }));
  }, async (apiBaseUrl) => {
    const controller = new AbortController();
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
      signal: controller.signal,
    });
    const pending = integration.createCustomerPortalSession(portalInput("intent-cancelled"));
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  });

  for (const responseFixture of [
    { id: "bps_wrong_customer", customer: "cus_other", livemode: false, return_url: "https://payments.example.test/account/billing", url: "https://billing.stripe.com/p/session/test_wrong_customer" },
    { id: "bps_wrong_mode", customer: "cus_server_owned", livemode: true, return_url: "https://payments.example.test/account/billing", url: "https://billing.stripe.com/p/session/test_wrong_mode" },
    { id: "bps_wrong_return", customer: "cus_server_owned", livemode: false, return_url: "https://attacker.example/", url: "https://billing.stripe.com/p/session/test_wrong_return" },
    { id: "bps_wrong_host", customer: "cus_server_owned", livemode: false, return_url: "https://payments.example.test/account/billing", url: "https://billing.stripe.example/p/session/test_wrong_host" },
    { id: "bps_wrong_path", customer: "cus_server_owned", livemode: false, return_url: "https://payments.example.test/account/billing", url: "https://billing.stripe.com/account/test_wrong_path" },
  ]) {
    await withStripeFake(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseFixture));
    }, async (apiBaseUrl) => {
      const integration = createStripePaymentIntegration({
        enabled: true,
        config: enabledConfig,
        env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
        apiBaseUrl,
      });
      await assert.rejects(integration.createCustomerPortalSession(portalInput(responseFixture.id)), (error) => {
        assert.equal(error.code, "STRIPE_PORTAL_RESPONSE_INVALID");
        assert.equal(error.retryable, false);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /cus_other|attacker|wrong_/);
        return true;
      });
    });
  }
});

test("mismatched recurring Price mode is a safe permanent rejection", async () => {
  await withStripeFake(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const params = new URLSearchParams(body);
    assert.equal(params.get("mode"), "payment");
    assert.equal(params.get("line_items[0][price]"), "price_recurring_server_owned");
    response.writeHead(400, { "content-type": "application/json", "request-id": "req_mode_mismatch" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Recurring Price requires subscription mode: price_recurring_server_owned" } }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    await assert.rejects(integration.createCheckoutSession({
      ...checkoutInput("intent-mode-mismatch"),
      priceId: "price_recurring_server_owned",
    }), (error) => {
      assert.equal(error.code, "STRIPE_CHECKOUT_REJECTED");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /mode_mismatch|price_recurring_server_owned/);
      return true;
    });
  });
});

test("a provider response cannot silently change subscription Checkout into one-time mode", async () => {
  await withStripeFake(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "cs_test_wrong_mode",
      object: "checkout.session",
      livemode: false,
      mode: "payment",
      url: "https://checkout.stripe.com/c/pay/cs_test_wrong_mode",
    }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    await assert.rejects(integration.createCheckoutSession({
      ...checkoutInput("intent-response-mode"),
      mode: "subscription",
      priceId: "price_recurring_server_owned",
    }), (error) => {
      assert.equal(error.code, "STRIPE_CHECKOUT_RESPONSE_INVALID");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /wrong_mode/);
      return true;
    });
  });
});

test("permanent Stripe rejection becomes bounded redacted non-retryable failure", async () => {
  await withStripeFake(async (_request, response) => {
    response.writeHead(400, { "content-type": "application/json", "request-id": "req_rejected" });
    response.end(JSON.stringify({ error: {
      type: "invalid_request_error",
      code: "resource_missing",
      message: "No such price: price_secret_fixture; sk_test_protocol_fixture",
    } }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: {
        STRIPE_SECRET_KEY: "sk_test_protocol_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture",
      },
      apiBaseUrl,
    });
    await assert.rejects(
      integration.createCheckoutSession({
        mode: "payment",
        priceId: "price_server_owned",
        quantity: 1,
        successPath: "/payments/success",
        cancelPath: "/payments/cancelled",
        idempotencyKey: "capsule:checkout:user-1:intent-rejected",
        businessReference: "intent-rejected",
      }),
      (error) => {
        assert.equal(error.code, "STRIPE_CHECKOUT_REJECTED");
        assert.equal(error.retryable, false);
        assert.match(error.message, /rejected/i);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /price_secret_fixture|sk_test_|req_rejected/);
        return true;
      },
    );
  });
});

test("transient provider failure and timeout remain safely retryable", async () => {
  for (const fixture of ["provider-500", "timeout"]) {
    await withStripeFake(async (_request, response) => {
      if (fixture === "provider-500") {
        response.writeHead(500, { "content-type": "application/json", "request-id": "req_transient_secret" });
        response.end(JSON.stringify({ error: { message: "sk_test_protocol_fixture price_secret_fixture" } }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "cs_test_too_late", object: "checkout.session", livemode: false, mode: "payment", url: "https://checkout.stripe.com/c/pay/cs_test_too_late" }));
    }, async (apiBaseUrl) => {
      const integration = createStripePaymentIntegration({
        enabled: true,
        config: { ...enabledConfig, requestTimeoutMs: 1_000 },
        env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
        apiBaseUrl,
      });
      await assert.rejects(integration.createCheckoutSession(checkoutInput(`intent-${fixture}`)), (error) => {
        assert.equal(error.code, "STRIPE_CHECKOUT_UNAVAILABLE");
        assert.equal(error.retryable, true);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /protocol_fixture|price_secret_fixture|req_transient_secret/);
        return true;
      });
    });
  }
});

test("Checkout cancellation stops waiting and unexpected redirect authority fails closed", async () => {
  await withStripeFake(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cs_test_cancelled", object: "checkout.session", livemode: false, mode: "subscription", url: "https://checkout.stripe.com/c/pay/cs_test_cancelled" }));
  }, async (apiBaseUrl) => {
    const controller = new AbortController();
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
      signal: controller.signal,
    });
    const pending = integration.createCheckoutSession({ ...checkoutInput("intent-cancelled"), mode: "subscription", priceId: "price_recurring_server_owned" });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  });

  for (const [reference, url] of [
    ["intent-wrong-host", "https://checkout.stripe.example/c/pay/cs_test_wrong_host"],
    ["intent-wrong-path", "https://checkout.stripe.com/account/cs_test_wrong_path"],
  ]) {
    await withStripeFake(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `cs_test_${reference.slice("intent-".length).replaceAll("-", "_")}`, object: "checkout.session", livemode: false, mode: "payment", url }));
    }, async (apiBaseUrl) => {
      const integration = createStripePaymentIntegration({
        enabled: true,
        config: enabledConfig,
        env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
        apiBaseUrl,
      });
      await assert.rejects(integration.createCheckoutSession(checkoutInput(reference)), (error) => {
        assert.equal(error.code, "STRIPE_CHECKOUT_RESPONSE_INVALID");
        assert.equal(error.retryable, false);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /stripe\.example|wrong_host|wrong_path/);
        return true;
      });
    });
  }
});
