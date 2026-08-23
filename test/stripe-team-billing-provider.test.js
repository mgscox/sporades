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
  quantity: 7,
  successPath: "/settings/billing/success",
  cancelPath: "/settings/billing/cancelled",
  idempotencyKey: "sporades:team-checkout:stable-provider-key",
  businessReference: "11111111-1111-4111-8111-111111111111",
  providerExpiresAt: 2_000_000_000,
  customerId: "cus_existing_team",
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
  assert.equal(observed.params.get("line_items[0][quantity]"), "7");
  assert.equal(observed.params.get("customer"), input.customerId);
  assert.equal(observed.params.get("client_reference_id"), input.operationId);
  assert.equal(observed.params.get("metadata[sporades_team_billing_operation]"), input.operationId);
  assert.equal(observed.params.get("subscription_data[metadata][sporades_team_billing_operation]"), input.operationId);
  assert.equal(observed.params.get("expires_at"), String(input.providerExpiresAt));
  assert.equal(observed.params.get("success_url"), "https://billing.example.test/settings/billing/success");
  assert.equal(observed.params.get("cancel_url"), "https://billing.example.test/settings/billing/cancelled");
});

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
