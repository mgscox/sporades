import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";
import { createStripePaymentIntegration } from "sporades/server/stripe";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("the Ticket 02 integration grants no authority when premature activation is requested", () => {
  assert.throws(
    () => createStripePaymentIntegration({ enabled: true }),
    (error) => {
      assert.equal(error.code, "STRIPE_PAYMENTS_NOT_CONFIGURED");
      assert.equal(error.message, "Stripe payments are not fully configured.");
      assert.match(error.hint, /Sealed Server env.*server-owned Prices/i);
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /sk_|whsec_|price_|cus_/i);
      return true;
    },
  );
});
