import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createWebSocketHub, openDevDatabase } from "../dist/server-runtime-source.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";

const enabledStripe = livemode => ({
  enabled: true,
  livemode,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://payments.example.test",
  callbackPath: "/stripe/webhook",
  apiVersion: "2026-08-26.dahlia",
  requestTimeoutMs: 10_000,
});

async function withPaymentsRuntime(payments, run) {
  const root = path.join(process.cwd(), ".sporades", "payments-tests");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "capsule-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {
    STRIPE_SECRET_KEY: payments?.stripe.livemode ? "sk_live_private_fixture" : "sk_test_private_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_private_fixture",
  }, { name: "payments-state", payments }, {}, { createStripeCallbackEndpoint });
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/__sporades/ws?connectionToken=${hub.createConnectionToken()}`);
  try {
    await once(socket, "open");
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ id: "activation", type: "auth.get" }));
    await run(JSON.parse((await reply)[0].data));
  } finally {
    socket.close();
    hub.disconnectAll();
    await new Promise(resolve => server.close(resolve));
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the runtime reports dormant payments for existing Capsules with no payment configuration", async () => {
  await withPaymentsRuntime(undefined, message => {
    assert.equal(message.error, null);
    assert.deepEqual(message.data.payments, { stripe: { enabled: false, livemode: null } });
  });
});

test("the runtime reports explicitly disabled billing as dormant", async () => {
  await withPaymentsRuntime({ stripe: { enabled: false } }, message => {
    assert.deepEqual(message.data.payments, { stripe: { enabled: false, livemode: null } });
  });
});

for (const livemode of [false, true]) {
  test(`the runtime exposes only activation booleans for ${livemode ? "live" : "test"}-mode Stripe`, async () => {
    await withPaymentsRuntime({ stripe: enabledStripe(livemode) }, message => {
      assert.equal(message.error, null);
      assert.deepEqual(message.data.payments, { stripe: { enabled: true, livemode } });
      assert.doesNotMatch(JSON.stringify(message), /sk_test_|sk_live_|whsec_|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|payments\.example|callbackPath|apiVersion|price_|cus_|prod_/);
    });
  });
}
