import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase } from "../dist/server-runtime-source.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { createStripeTeamBillingProvider } from "../dist/stripe-team-billing-provider.js";
import { createStripeTeamBillingFake } from "sporades/testing/stripe";
import { startTeamBillingCheckout, performTeamBillingCheckout } from "../dist/team-billing-runtime.js";
import { prepareTeamBillingErasure, performTeamBillingErasure } from "../dist/team-billing-erasure.js";

async function fixture(t, taxEnabled) {
  const dir = await mkdtemp(path.join(tmpdir(), "billing-tax-replay-"));
  const teamId = randomUUID();
  const auth = { userId: "tax-admin", isAuthenticated: true, isGuest: false, provider: "email" };
  const env = { STRIPE_SECRET_KEY: "sk_test_tax_replay", STRIPE_WEBHOOK_SECRET: "whsec_tax_replay" };
  const config = { enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://billing.example.test", callbackPath: "/stripe/webhook", apiVersion: "2026-08-26.dahlia",
    livemode: false, requestTimeoutMs: 1000, tax: { enabled: taxEnabled } };
  const capsule = { name: "tax-replay", schema: {}, teamBilling: {
    checkout: { successPath: "/success", cancelPath: "/cancel" },
    catalogue: { team: { quantity: { kind: "fixed", value: 1 }, stripe: {
      sandbox: { priceId: "price_team", productId: "prod_team" }, live: { priceId: "price_live_team", productId: "prod_live_team" },
    } } }, authorize: () => ({ allow: true }),
  } };
  const callback = createServer((_req, res) => res.writeHead(200).end());
  callback.listen(0, "127.0.0.1"); await once(callback, "listening");
  const fake = await createStripeTeamBillingFake({ catalogue: { products: [{ id: "prod_team", prices: [{ id: "price_team", recurring: "month" }] }], portalConfigurations: [] },
    webhookSecret: env.STRIPE_WEBHOOK_SECRET, webhookTarget: `http://127.0.0.1:${callback.address().port}/stripe/webhook`, delivery: "manual" });
  const open = async () => {
    const db = await openDevDatabase(path.join(dir, "data.db"), "", env, { name: capsule.name, payments: { stripe: config } }, capsule,
      { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
    db.stripeApiBaseUrl = fake.origin;
    db.scheduleTeamBillingJobDispatch = () => {};
    return db;
  };
  let database = await open();
  t.after(async () => { await database.close(); await fake.close(); callback.closeAllConnections(); await new Promise(r => callback.close(r)); await rm(dir, { recursive: true, force: true }); });
  const timestamp = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, 'Admin', 1, 0, 'email')").run(auth.userId, timestamp);
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Tax Team', ?, ?)").run(teamId, timestamp, auth.userId);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)").run(teamId, auth.userId, timestamp);
  const requestId = randomUUID();
  await startTeamBillingCheckout(database, auth, teamId, requestId, "team");
  const operation = database.adapter.prepare("SELECT [id] FROM [sporades_team_billing_operations] WHERE [requestId] = ?").get(requestId);
  return { get database() { return database; }, fake, auth, teamId, requestId, operationId: operation.id,
    restart: async enabled => { await database.close(); config.tax = { enabled }; database = await open(); } };
}

for (const issuedTax of [true, false]) for (const recovery of ["retry", "erasure"]) {
  test(`lost Checkout acknowledgement survives tax ${issuedTax} to ${!issuedTax} restart during ${recovery}`, async t => {
    const f = await fixture(t, issuedTax);
    f.fake.faults.inject({ operation: "checkout.sessions.create", status: 500, when: "after" });
    await assert.rejects(performTeamBillingCheckout(f.database, {}, { operationId: f.operationId }), error => error.retryable === true);
    const session = f.fake.state().checkouts[0];
    assert.equal(f.fake.state().checkouts.length, 1);
    await f.restart(!issuedTax);
    if (recovery === "retry") {
      await performTeamBillingCheckout(f.database, {}, { operationId: f.operationId });
      const result = await startTeamBillingCheckout(f.database, f.auth, f.teamId, f.requestId, "team");
      assert.equal(result.state, "ready");
      assert.ok(result.url.includes(session.id));
    } else {
      const requestId = randomUUID();
      await prepareTeamBillingErasure(f.database, f.auth, f.teamId, requestId);
      const state = f.database.adapter.prepare("SELECT [operationId], [activeJobGenerationId] FROM [sporades_team_billing_erasure_state]").get();
      assert.deepEqual(await performTeamBillingErasure(f.database, {}, { operationId: state.operationId, generationId: state.activeJobGenerationId }), { providerQuiesced: true });
      assert.equal(f.fake.state().checkouts[0].status, "expired");
    }
    const writes = f.fake.requests().filter(r => r.operation === "checkout.sessions.create");
    assert.deepEqual(writes.at(-1).parameters, writes[0].parameters);
    assert.equal(f.fake.state().checkouts.length, 1);
  });
}

for (const recovery of ["retry", "erasure"]) {
  test(`pre-tax operation migration preserves its taxless ${recovery} envelope`, async t => {
    const f = await fixture(t, true);
    // Model the persisted schema and dispatched operation from the released runtime.
    f.database.adapter.exec("ALTER TABLE [sporades_team_billing_operations] DROP COLUMN [taxEnabled]");
    f.database.adapter.prepare("UPDATE [sporades_team_billing_operations] SET [status] = 'retrying', [attemptedAt] = ? WHERE [id] = ?")
      .run(new Date().toISOString(), f.operationId);
    const op = f.database.adapter.prepare("SELECT * FROM [sporades_team_billing_operations] WHERE [id] = ?").get(f.operationId);
    const { default: Stripe } = await import("stripe");
    const origin = new URL(f.fake.origin);
    const stripe = new Stripe("sk_test_tax_replay", { host: origin.hostname, port: origin.port, protocol: "http", apiVersion: "2026-08-26.dahlia", maxNetworkRetries: 0 });
    const original = await stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price: "price_team", quantity: 1 }],
      success_url: "https://billing.example.test/success", cancel_url: "https://billing.example.test/cancel",
      client_reference_id: f.operationId, expires_at: op.providerExpiresAt,
      metadata: { sporades_team_billing_operation: f.operationId }, subscription_data: { metadata: { sporades_team_billing_operation: f.operationId } },
    }, { idempotencyKey: op.idempotencyKey });
    await f.restart(true);
    if (recovery === "retry") {
      await performTeamBillingCheckout(f.database, {}, { operationId: f.operationId });
      const result = await startTeamBillingCheckout(f.database, f.auth, f.teamId, f.requestId, "team");
      assert.equal(result.state, "ready");
      assert.ok(result.url.includes(original.id));
    } else {
      await prepareTeamBillingErasure(f.database, f.auth, f.teamId, randomUUID());
      const state = f.database.adapter.prepare("SELECT [operationId], [activeJobGenerationId] FROM [sporades_team_billing_erasure_state]").get();
      assert.deepEqual(await performTeamBillingErasure(f.database, {}, { operationId: state.operationId, generationId: state.activeJobGenerationId }), { providerQuiesced: true });
      assert.equal(f.fake.state().checkouts[0].status, "expired");
    }
    const writes = f.fake.requests().filter(r => r.operation === "checkout.sessions.create");
    assert.equal(writes.at(-1).parameters.automatic_tax, undefined);
    assert.deepEqual(writes.at(-1).parameters, writes[0].parameters);
    assert.equal(f.fake.state().checkouts.length, 1);
  });
}

for (const recovery of ["retry", "erasure"]) {
  test(`queued pre-tax operation keeps taxless intent through its first lost reply and ${recovery}`, async t => {
    const f = await fixture(t, true);
    f.database.adapter.exec("ALTER TABLE [sporades_team_billing_operations] DROP COLUMN [taxEnabled]");
    await f.restart(true);
    f.fake.faults.inject({ operation: "checkout.sessions.create", status: 500, when: "after" });
    await assert.rejects(performTeamBillingCheckout(f.database, {}, { operationId: f.operationId }), error => error.retryable === true);
    const original = f.fake.state().checkouts[0];
    assert.equal(f.fake.requests().filter(r => r.operation === "checkout.sessions.create")[0].parameters.automatic_tax, undefined);
    await f.restart(false);
    if (recovery === "retry") {
      await performTeamBillingCheckout(f.database, {}, { operationId: f.operationId });
      const result = await startTeamBillingCheckout(f.database, f.auth, f.teamId, f.requestId, "team");
      assert.equal(result.state, "ready");
      assert.ok(result.url.includes(original.id));
    } else {
      await prepareTeamBillingErasure(f.database, f.auth, f.teamId, randomUUID());
      const state = f.database.adapter.prepare("SELECT [operationId], [activeJobGenerationId] FROM [sporades_team_billing_erasure_state]").get();
      assert.deepEqual(await performTeamBillingErasure(f.database, {}, { operationId: state.operationId, generationId: state.activeJobGenerationId }), { providerQuiesced: true });
      assert.equal(f.fake.state().checkouts[0].status, "expired");
    }
    const writes = f.fake.requests().filter(r => r.operation === "checkout.sessions.create");
    assert.deepEqual(writes.at(-1).parameters, writes[0].parameters);
    assert.equal(f.fake.state().checkouts.length, 1);
  });
}
