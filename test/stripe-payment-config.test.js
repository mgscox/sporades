import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePaymentsConfig, validateProjectConfigShape } from "../dist/cli/project-config.js";

test("Stripe payment configuration is optional and admits only the dormant Ticket 02 shape", () => {
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
    [{ stripe: {} }, /Set `payments\.stripe\.enabled` to false/],
    [{ stripe: { enabled: false, request: true } }, /Configure only `payments\.stripe\.enabled`/],
    [{ stripe: { enabled: true } }, /Sealed Server env.*server-owned Prices/i],
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
