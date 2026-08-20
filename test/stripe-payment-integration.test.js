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
  callbackPath: "/__sporades/stripe/webhook",
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
};

function checkoutInput(intent = "intent-protocol-1") {
  return {
    priceId: "price_server_owned",
    quantity: 1,
    successPath: "/payments/success",
    cancelPath: "/payments/cancelled",
    idempotencyKey: `capsule:checkout:user-1:${intent}`,
    businessReference: intent,
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
    response.end(JSON.stringify({ id: "cs_test_cancelled", object: "checkout.session", livemode: false, mode: "payment", url: "https://checkout.stripe.com/c/pay/cs_test_cancelled" }));
  }, async (apiBaseUrl) => {
    const controller = new AbortController();
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
      signal: controller.signal,
    });
    const pending = integration.createCheckoutSession(checkoutInput("intent-cancelled"));
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  });

  await withStripeFake(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cs_test_wrong_host", object: "checkout.session", livemode: false, mode: "payment", url: "https://checkout.stripe.example/c/pay/cs_test_wrong_host" }));
  }, async (apiBaseUrl) => {
    const integration = createStripePaymentIntegration({
      enabled: true,
      config: enabledConfig,
      env: { STRIPE_SECRET_KEY: "sk_test_protocol_fixture", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
      apiBaseUrl,
    });
    await assert.rejects(integration.createCheckoutSession(checkoutInput("intent-wrong-host")), (error) => {
      assert.equal(error.code, "STRIPE_CHECKOUT_RESPONSE_INVALID");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /stripe\.example|cs_test_wrong_host/);
      return true;
    });
  });
});
