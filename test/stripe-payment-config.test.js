import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePaymentsConfig, validateProjectConfigShape } from "../dist/cli/project-config.js";
import { openDevDatabase } from "../dist/server-runtime-source.js";
import { validateStripePaymentsRuntimeConfig } from "../dist/stripe-payment-config.js";

const enabledStripeConfig = {
  enabled: true,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://payments.example.test",
  callbackPath: "/__sporades/stripe/webhook",
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
};

test("Stripe payment configuration is optional and preserves the exact dormant shape", () => {
  assert.equal(validatePaymentsConfig(undefined), undefined);
  assert.deepEqual(validatePaymentsConfig({ stripe: { enabled: false } }), { stripe: { enabled: false } });
  assert.doesNotThrow(() => validateProjectConfigShape({ name: "legacy-capsule" }));
  assert.doesNotThrow(() => validateProjectConfigShape({ name: "blank-capsule", payments: { stripe: { enabled: false } } }));
});

test("Stripe payment configuration fails safely before premature activation or unknown authority", () => {
  const cases = [
    [null, /Set `payments` to an object/],
    [{}, /Configure `payments\.stripe`/],
    [{ cardProcessor: { enabled: false } }, /Configure only `payments\.stripe`/],
    [{ stripe: true }, /Set `payments\.stripe` to an object/],
    [{ stripe: {} }, /Set `payments\.stripe\.enabled` to true or false/],
    [{ stripe: { enabled: false, request: true } }, /Configure only `payments\.stripe\.enabled` while Stripe payments are disabled/],
    [{ stripe: { enabled: true } }, /Set `payments\.stripe\.secretKeyEnv` before enabling Stripe payments/],
  ];

  for (const [value, hint] of cases) {
    assert.throws(
      () => validatePaymentsConfig(value),
      (error) => {
        assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
        assert.match(error.hint, hint);
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /sk_|whsec_|price_|cus_/i);
        return true;
      },
    );
  }
});

test("complete Stripe activation resolves only named Sealed Server env credentials", () => {
  assert.deepEqual(validatePaymentsConfig({ stripe: enabledStripeConfig }), { stripe: enabledStripeConfig });
  assert.deepEqual(
    validateStripePaymentsRuntimeConfig(
      { stripe: enabledStripeConfig },
      {
        STRIPE_SECRET_KEY: "sk_test_protocol_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture",
        UNRELATED_SECRET: "must-not-travel",
      },
    ),
    { stripe: enabledStripeConfig },
  );

  for (const env of [
    {},
    { STRIPE_SECRET_KEY: "sk_test_protocol_fixture" },
    { STRIPE_SECRET_KEY: "sk_live_wrong_mode", STRIPE_WEBHOOK_SECRET: "whsec_protocol_fixture" },
  ]) {
    assert.throws(
      () => validateStripePaymentsRuntimeConfig({ stripe: enabledStripeConfig }, env),
      (error) => {
        assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
        assert.doesNotMatch(`${error.message}\n${error.hint}`, /protocol_fixture|wrong_mode/);
        return true;
      },
    );
  }
});

test("Stripe return authority admits hosted HTTPS and explicit loopback HTTP origins only", () => {
  for (const publicOrigin of ["https://payments.example.test", "http://localhost:3210", "http://127.0.0.1:3210", "http://[::1]:3210"]) {
    assert.doesNotThrow(() => validatePaymentsConfig({ stripe: { ...enabledStripeConfig, publicOrigin } }), publicOrigin);
  }
  for (const publicOrigin of [
    "http://payments.example.test",
    "https://payments.example.test/path",
    "https://payments.example.test?tenant=other",
    "https://user:secret@payments.example.test",
    "ftp://payments.example.test",
  ]) {
    assert.throws(() => validatePaymentsConfig({ stripe: { ...enabledStripeConfig, publicOrigin } }), (error) => {
      assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
      assert.doesNotMatch(`${error.message}\n${error.hint}`, /user:secret|tenant=other/);
      return true;
    }, publicOrigin);
  }
});

test("runtime publication fails closed before opening an incompletely activated Capsule", async () => {
  await assert.rejects(
    openDevDatabase("unused.db", "", {}, { name: "payments", payments: { stripe: enabledStripeConfig } }, { schema: {} }),
    (error) => {
      assert.equal(error.code, "INVALID_STRIPE_PAYMENTS_CONFIG");
      assert.match(error.message, /secret key is unavailable/i);
      return true;
    },
  );
});
