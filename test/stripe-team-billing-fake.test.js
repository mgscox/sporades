import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import Stripe from "stripe";
import { createStripeTeamBillingFake } from "sporades/testing/stripe";
import { createStripeTeamBillingProvider } from "../dist/stripe-team-billing-provider.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { inspectRuntimeJobs, openDevDatabase, routeEndpoint, runCurrentUserJobWorker } from "../dist/server-runtime-source.js";

const secret = "whsec_fake_contract";
const catalogue = {
  products: [
    { id: "prod_team", prices: [{ id: "price_team", recurring: "month" }] },
    { id: "prod_studio", prices: [{ id: "price_studio", recurring: "year" }] },
  ],
  portalConfigurations: [{ id: "bpc_team", products: [
    { product: "prod_team", prices: ["price_team"] }, { product: "prod_studio", prices: ["price_studio"] },
  ] }],
};
const config = { enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://billing.example.test", callbackPath: "/stripe/webhook", apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 100 };
const input = { operationId: "11111111-1111-4111-8111-111111111111", teamId: "22222222-2222-4222-8222-222222222222",
  productKey: "team", mode: "subscription", priceId: "price_team", quantity: 2, successPath: "/billing/success", cancelPath: "/billing/cancel",
  idempotencyKey: "fake-checkout-stable-key", businessReference: "11111111-1111-4111-8111-111111111111", providerExpiresAt: 2_000_000_000 };
const portalConfigInput = { configurationId: "bpc_team", mode: "sandbox", expectedProducts: [
  { productId: "prod_studio", priceIds: ["price_studio"] }, { productId: "prod_team", priceIds: ["price_team"] },
] };
const env = { STRIPE_SECRET_KEY: "sk_test_fake_contract", STRIPE_WEBHOOK_SECRET: secret };
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
function sdk(fake, key = env.STRIPE_SECRET_KEY) {
  const url = new URL(fake.origin);
  return new Stripe(key, { host: url.hostname, port: url.port, protocol: "http", apiVersion: config.apiVersion, timeout: 100, maxNetworkRetries: 0, telemetry: false });
}
async function fixture(t, options = {}) {
  const callback = createServer((_req, res) => { res.writeHead(200).end('{}'); });
  const origin = await listen(callback);
  const fake = await createStripeTeamBillingFake({ webhookSecret: secret, webhookTarget: `${origin}/stripe/webhook`, catalogue, delivery: "manual", requestTimeoutMs: 100, ...options });
  t.after(async () => { await fake.close(); await stop(callback); });
  const provider = createStripeTeamBillingProvider({ config, env, apiBaseUrl: fake.origin });
  const stripe = sdk(fake);
  return { fake, provider, stripe };
}
async function paid(f) {
  const checkout = await f.provider.create(input);
  const session = await f.fake.checkout.complete(checkout.sessionId);
  const subscription = f.fake.subscriptions.get(session.subscription);
  return { session, subscription, item: subscription.items.data[0] };
}
function updateInput(subscription, item, overrides = {}) {
  return { mode: "sandbox", customerId: subscription.customer, subscriptionId: subscription.id, subscriptionItemId: item.id,
    sourcePriceId: item.price.id, targetPriceId: "price_studio", targetProductId: "prod_studio", targetQuantity: 5,
    prorationDate: Math.floor(Date.now() / 1000), idempotencyKey: "fake-plan-transition-key", operationKind: "plan-transition", ...overrides };
}
const erasure = (overrides = {}) => ({ mode: "sandbox", checkoutSessionIds: [], subscriptionIds: [], idempotencyKey: "fake-quiescence-key", ...overrides });
const unavailable = (error) => error.code === "TEAM_BILLING_PROVIDER_UNAVAILABLE" && error.retryable;

test("the real provider attests Checkout, Portal, plans, seats and provider-safe erasure against the shipped export", async (t) => {
  const f = await fixture(t, { pageSize: 1 }); const { fake, provider, stripe } = f;
  assert.deepEqual(await provider.retrievePortalConfiguration(portalConfigInput), { ok: true });
  const { session, subscription, item } = await paid(f);
  assert.equal((await stripe.customers.retrieve(session.customer)).object, "customer");
  assert.equal((await provider.createPortal({ customerId: session.customer, configurationId: "bpc_team", returnPath: "/billing", idempotencyKey: "fake-portal-key" })).ok, true);
  assert.deepEqual(await provider.updateManagedSubscription(updateInput(subscription, item)), { ok: true, outcome: "acknowledged" });
  assert.equal(fake.subscriptions.get(subscription.id).items.data[0].price.id, "price_studio");
  await provider.updateManagedSubscription(updateInput(subscription, item, { sourcePriceId: "price_studio", targetQuantity: 7, operationKind: "seat-convergence", idempotencyKey: "fake-seat-key" }));
  assert.equal(fake.subscriptions.get(subscription.id).items.data[0].quantity, 7);
  // A second Checkout reuses a real existing Customer and forces discovery pagination.
  const second = await provider.create({ ...input, customerId: session.customer, idempotencyKey: "fake-second-checkout-key" });
  await fake.checkout.complete(second.sessionId);
  assert.equal(fake.customers.subscriptions(session.customer).length, 2);
  const result = await provider.quiesceTeamBilling(erasure({ customerId: session.customer, checkoutSessionIds: [session.id, second.sessionId] }));
  assert.equal(result.subscriptions.length, 2);
  assert.ok(result.subscriptions.every((entry) => entry.state === "cancelled"));
  assert.ok(fake.requests().some((entry) => entry.parameters.starting_after));
  const deletes = fake.requests().filter((entry) => entry.method === "DELETE");
  assert.equal(deletes.length, 2); assert.ok(deletes.every((entry) => !entry.replay));
  const missing = await provider.quiesceTeamBilling(erasure({ checkoutSessionIds: ["cs_test_missing"], subscriptionIds: ["sub_missing"] }));
  assert.deepEqual(missing.checkouts, [{ id: "cs_test_missing", state: "safely-closed" }]);
  assert.deepEqual(missing.subscriptions, [{ id: "sub_missing", state: "safely-closed" }]);
});

test("POST idempotency survives overlapping requests and lost replies; keys are scoped and parameter checked", async (t) => {
  const { fake, provider, stripe } = await fixture(t);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => provider.create(input)));
  assert.equal(new Set(concurrent.map((entry) => entry.sessionId)).size, 1);
  assert.equal(fake.state().checkouts.length, 1);
  assert.equal(fake.requests().filter((entry) => entry.replay).length, 7);
  await assert.rejects(provider.create({ ...input, quantity: 3 }), (error) => error.code === "TEAM_BILLING_PROVIDER_REJECTED");
  fake.faults.inject({ operation: "checkout.sessions.create", status: 503, when: "after" });
  const lost = { ...input, idempotencyKey: "lost-checkout-key" };
  await assert.rejects(provider.create(lost), unavailable);
  const recovered = await provider.create(lost);
  assert.equal(fake.state().checkouts.length, 2);
  assert.equal(recovered.sessionId, fake.state().checkouts[1].id);
  const originalRequest = fake.requests()[0].parameters;
  const differentKey = sdk(fake, "sk_test_another_fixture");
  const rawParams = { ...originalRequest, line_items: Object.values(originalRequest.line_items) };
  const other = await differentKey.checkout.sessions.create(rawParams, { idempotencyKey: input.idempotencyKey });
  assert.notEqual(other.id, concurrent[0].sessionId);
  const replay = await stripe.checkout.sessions.create(rawParams, { idempotencyKey: input.idempotencyKey });
  assert.equal(replay.lastResponse.headers["idempotent-replayed"], "true");
  await assert.rejects(stripe.checkout.sessions.create({ ...rawParams, quantity: 8 }, { idempotencyKey: input.idempotencyKey }), (error) => error.type === "StripeIdempotencyError");
  assert.doesNotMatch(JSON.stringify([fake.requests(), fake.state()]), /sk_test_|Bearer/);
});

test("faulted provider calls retry through real SDK reads and reconciliation", async (t) => {
  const operations = ["checkout.sessions.create", "checkout.sessions.retrieve", "checkout.sessions.expire", "billingPortal.configurations.retrieve",
    "billingPortal.sessions.create", "subscriptions.retrieve", "subscriptions.update", "subscriptions.list", "subscriptions.cancel"];
  for (const operation of operations) for (const status of [409, 429, 500, 503, "timeout"]) {
    await t.test(`${operation} ${status}`, async (t) => {
      const f = await fixture(t); const { fake, provider } = f;
      let call;
      if (operation === "checkout.sessions.create") call = () => provider.create(input);
      else if (operation === "billingPortal.configurations.retrieve") call = () => provider.retrievePortalConfiguration(portalConfigInput);
      else if (operation.startsWith("checkout.sessions.")) {
        const checkout = await provider.create(input);
        call = () => provider.quiesceTeamBilling(erasure({ checkoutSessionIds: [checkout.sessionId] }));
      } else {
        const { subscription, item } = await paid(f);
        if (operation === "billingPortal.sessions.create") call = () => provider.createPortal({ customerId: subscription.customer, configurationId: "bpc_team", returnPath: "/billing", idempotencyKey: "fault-portal-key" });
        else if (["subscriptions.retrieve", "subscriptions.update"].includes(operation)) call = () => provider.updateManagedSubscription(updateInput(subscription, item));
        else call = () => provider.quiesceTeamBilling(erasure({ customerId: subscription.customer, subscriptionIds: [subscription.id] }));
      }
      fake.faults.inject({ operation, status });
      await assert.rejects(call(), unavailable);
      assert.equal((await call()).ok, true);
      assert.ok(fake.requests().filter((entry) => entry.operation === operation).length >= 2);
    });
  }
});

test("lost DELETE acknowledgement is reconciled by retrieve/list, never idempotent DELETE replay", async (t) => {
  const f = await fixture(t); const { fake, provider, stripe } = f;
  const { subscription } = await paid(f);
  fake.faults.inject({ operation: "subscriptions.cancel", status: 503, when: "after" });
  const input = erasure({ customerId: subscription.customer, subscriptionIds: [subscription.id] });
  await assert.rejects(provider.quiesceTeamBilling(input), unavailable);
  assert.equal(fake.subscriptions.get(subscription.id).status, "canceled");
  assert.equal((await provider.quiesceTeamBilling(input)).outcome, "quiesced");
  assert.equal(fake.requests().filter((entry) => entry.method === "DELETE").length, 1);
  const read = await stripe.subscriptions.retrieve(subscription.id, {}, { idempotencyKey: "ignored-read-key" });
  assert.equal(read.status, "canceled");
  assert.ok(fake.requests().every((entry) => !entry.replay));
});

test("Checkout expiration/completion races, lost expiry replies and recovery use exact provider state", async (t) => {
  const { fake, provider } = await fixture(t);
  const checkout = await provider.create(input);
  fake.faults.inject({ operation: "checkout.sessions.expire", status: "completeDuringExpire" });
  const result = await provider.quiesceTeamBilling(erasure({ checkoutSessionIds: [checkout.sessionId] }));
  assert.equal(result.checkouts[0].state, "complete");
  assert.equal(result.subscriptions[0].state, "cancelled");
  fake.faults.inject({ operation: "checkout.sessions.create", status: "timeout", when: "after" });
  const recovery = { ...input, idempotencyKey: "checkout-recovery-key" };
  await assert.rejects(provider.create(recovery), unavailable);
  fake.faults.inject({ operation: "checkout.sessions.expire", status: 500, when: "after" });
  await assert.rejects(provider.quiesceTeamBilling(erasure({ checkoutRecoveries: [recovery] })), unavailable);
  assert.equal((await provider.quiesceTeamBilling(erasure({ checkoutRecoveries: [recovery] }))).checkouts[0].state, "expired");
  assert.equal(fake.state().checkouts.length, 2);
});

test("pending payment, lifecycle controls, immutable snapshots and a forward-only clock", async (t) => {
  const f = await fixture(t); const { fake, provider } = f; const { subscription, item } = await paid(f);
  fake.faults.inject({ operation: "subscriptions.update", status: "paymentActionRequired" });
  assert.equal((await provider.updateManagedSubscription(updateInput(subscription, item))).outcome, "payment-action-required");
  await fake.subscriptions.setQuantity(subscription.id, 9);
  await fake.portal.switchPrice(subscription.id, "price_team");
  await fake.subscriptions.setStatus(subscription.id, "past_due");
  await fake.subscriptions.setStatus(subscription.id, "unpaid");
  await fake.subscriptions.setStatus(subscription.id, "active");
  const invoice = await fake.subscriptions.failPayment(subscription.id);
  assert.equal(invoice.lines.data[0].parent.subscription_item_details.subscription_item, item.id);
  assert.equal(invoice.lines.data[0].pricing.price_details.price, "price_team");
  await fake.subscriptions.renew(subscription.id);
  const renewed = fake.subscriptions.get(subscription.id);
  assert.equal(renewed.items.data[0].current_period_start, item.current_period_end);
  await fake.portal.cancelAtPeriodEnd(subscription.id);
  await fake.portal.resume(subscription.id);
  assert.equal(fake.subscriptions.get(subscription.id).cancel_at_period_end, false);
  await fake.portal.cancelAtPeriodEnd(subscription.id);
  await fake.clock.advance(renewed.items.data[0].current_period_end - fake.state().now);
  assert.equal(fake.subscriptions.get(subscription.id).status, "canceled");
  await assert.rejects(fake.subscriptions.setStatus(subscription.id, "active"));
  await assert.rejects(fake.clock.advance(-1));
  const open = await provider.create({ ...input, providerExpiresAt: fake.state().now + 10, idempotencyKey: "clock-expiry-key" });
  await fake.clock.advance(10);
  assert.equal(fake.state().checkouts.find((entry) => entry.id === open.sessionId).status, "expired");
  const events = fake.events.pending();
  for (const id of new Set(events.map((entry) => entry.data.object.id))) {
    const timestamps = events.filter((entry) => entry.data.object.id === id).map((entry) => entry.created);
    assert.ok(timestamps.every((timestamp, index) => !index || timestamp > timestamps[index - 1]));
  }
  events[0].data.object.status = "corrupted";
  assert.notEqual(fake.events.pending()[0].data.object.status, "corrupted");
  fake.reset(); assert.equal(fake.state().subscriptions.length, 0); assert.equal(fake.requests().length, 0);
  assert.equal((await provider.retrievePortalConfiguration(portalConfigInput)).ok, true);
});

test("pending seat changes need successful payment; expiration and cancellation discard the requested changes", async (t) => {
  for (const resolution of ["complete", "expire", "cancel"]) await t.test(resolution, async (t) => {
    const f = await fixture(t); const { fake, provider, stripe } = f;
    const { subscription, item } = await paid(f);
    const update = updateInput(subscription, item, { targetPriceId: "price_team", targetProductId: "prod_team", operationKind: "seat-convergence" });
    fake.faults.inject({ operation: "subscriptions.update", status: "paymentActionRequired" });
    assert.equal((await provider.updateManagedSubscription(update)).outcome, "payment-action-required");
    assert.equal((await stripe.subscriptions.retrieve(subscription.id)).items.data[0].quantity, 2);
    if (resolution === "complete") {
      await fake.subscriptions.setStatus(subscription.id, "active");
      assert.equal(fake.subscriptions.get(subscription.id).items.data[0].quantity, 2, "status alone does not resolve payment");
      await fake.subscriptions.completePayment(subscription.id);
    } else if (resolution === "expire") await fake.clock.advance(3600);
    else await stripe.subscriptions.cancel(subscription.id);
    const resolved = await stripe.subscriptions.retrieve(subscription.id);
    assert.equal(resolved.pending_update, null);
    assert.equal(resolved.items.data[0].quantity, resolution === "complete" ? 5 : 2);
    await assert.rejects(fake.subscriptions.completePayment(subscription.id));
    assert.equal((await provider.updateManagedSubscription(update)).outcome, "payment-action-required", "replay preserves the original pending result");
    assert.deepEqual((await stripe.subscriptions.retrieve(subscription.id)).items, resolved.items);
  });
});

test("literal loopback, sandbox-only authentication, exact API version and unsupported calls fail closed", async (t) => {
  for (const webhookTarget of ["https://stripe.com/webhook", "http://localhost:5218/webhook", "http://127.1:5218/", "http://127.0.0.1:5218@evil.test/", "http://127.0.0.1/"]) {
    await assert.rejects(createStripeTeamBillingFake({ webhookTarget, webhookSecret: secret, catalogue }));
  }
  const { fake, stripe } = await fixture(t);
  assert.equal(new URL(fake.origin).hostname, "127.0.0.1"); assert.equal(new URL(fake.controlOrigin).hostname, "127.0.0.1");
  for (const key of ["sk_live_fixture", "rk_live_fixture", "rk_test_fixture", "bad_fixture"]) {
    await assert.rejects(sdk(fake, key).customers.retrieve("cus_missing"), (error) => error.statusCode === 401);
  }
  assert.equal(fake.requests().length, 0);
  const wrongVersion = await fetch(`${fake.origin}/v1/subscriptions/sub_unknown`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": "2025-01-01" } });
  assert.equal(wrongVersion.status, 400);
  await assert.rejects(stripe.paymentIntents.create({ amount: 100, currency: "gbp" }), (error) => error.code === "sporades_fake_unsupported");
  assert.equal(fake.requests().at(-1).operation, "unsupported");
  const f = { fake, provider: createStripeTeamBillingProvider({ config, env, apiBaseUrl: fake.origin }) };
  await f.provider.create(input);
  const params = fake.requests().at(-1).parameters;
  await assert.rejects(stripe.checkout.sessions.create({ ...params, mode: "payment", line_items: Object.values(params.line_items) }), (error) => error.code === "sporades_fake_unsupported");
  await assert.rejects(stripe.checkout.sessions.create({ ...params, line_items: [...Object.values(params.line_items), ...Object.values(params.line_items)] }), (error) => error.code === "sporades_fake_unsupported");
  const control = await fetch(`${fake.origin}/__control/state`, { method: "POST", headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  assert.equal(control.status, 400);
  const blockedBrowser = await fetch(`${fake.controlOrigin}/__control/reset`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: '{"args":[]}' });
  assert.equal(blockedBrowser.status, 400);
});

test("endpoint and event parity fails when the real provider or convergence adds a call", async () => {
  const [provider, convergence, fake] = await Promise.all([
    readFile(new URL("../src/stripe-team-billing-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/team-billing-convergence.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/testing/stripe.ts", import.meta.url), "utf8"),
  ]);
  const calls = new Set([...provider.matchAll(/await stripe\.([\w.]+)\(/g)].map((entry) => entry[1]));
  const routes = new Set([...fake.matchAll(/\["(?:POST|GET|DELETE)", .*?, "([\w.]+)"\]/g)].map((entry) => entry[1]));
  assert.equal(calls.size, 9);
  assert.deepEqual([...routes].filter((entry) => entry !== "customers.retrieve").sort(), [...calls].sort());
  const supported = convergence.match(/const SUPPORTED = new Set\(\[([\s\S]*?)\]\)/)[1];
  const events = fake.match(/const EVENTS = \[([\s\S]*?)\]/)[1];
  assert.deepEqual([...supported.matchAll(/"([\w.]+)"/g)].map((entry) => entry[1]).sort(), [...events.matchAll(/"([\w.]+)"/g)].map((entry) => entry[1]).sort());
});

async function scratch(t) {
  const root = path.resolve(".sporades/stripe-fake-tests"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "case-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function settled(database) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await runCurrentUserJobWorker(database);
    const jobs = await inspectRuntimeJobs(database.adapter);
    if (jobs.every((entry) => entry.status === "succeeded")) return;
    assert.ok(jobs.every((entry) => !["failed", "delayed"].includes(entry.status)), JSON.stringify(jobs));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Stripe event jobs did not settle.");
}

test("real callback verification and atomic convergence accept the fake's events, reject forged signatures, deduplicate and quarantine", async (t) => {
  const dir = await scratch(t);
  const capsule = { name: "stripe-fake-callback", schema: {}, teamBilling: {
    catalogue: {
      team: { quantity: { kind: "fixed", value: 2 }, stripe: { sandbox: { priceId: "price_team", productId: "prod_team" }, live: { priceId: "price_live_team", productId: "prod_live_team" } } },
      studio: { quantity: { kind: "fixed", value: 5 }, stripe: { sandbox: { priceId: "price_studio", productId: "prod_studio" }, live: { priceId: "price_live_studio", productId: "prod_live_studio" } } },
    }, authorize: async () => ({ allow: true }),
  } };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", env, { name: capsule.name, payments: { stripe: { ...config, requestTimeoutMs: 1000 } } }, capsule,
    { createStripeCallbackEndpoint, createStripeTeamBillingProvider });
  const callback = createServer(async (req, res) => {
    try { if (!await routeEndpoint(database, req, res)) res.writeHead(404).end(); }
    catch { res.writeHead(500).end(); }
  });
  const callbackOrigin = await listen(callback);
  const fake = await createStripeTeamBillingFake({ catalogue, webhookSecret: secret, webhookTarget: `${callbackOrigin}/stripe/webhook`, delivery: "manual" });
  t.after(async () => { await fake.close(); await stop(callback); await database.close(); });
  database.stripeApiBaseUrl = fake.origin;
  await database.init();
  const timestamp = new Date().toISOString();
  database.adapter.prepare("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('fake-admin', ?, 'Admin', NULL, NULL, 1, 0, 'email')").run(timestamp);
  database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Fake Team', ?, 'fake-admin')").run(input.teamId, timestamp);
  database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'fake-admin', 'admin', ?)").run(input.teamId, timestamp);
  database.adapter.prepare("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [idempotencyKey], [createdAt], [updatedAt], [mode], [quantity]) VALUES (?, ?, ?, 'fake-admin', 'checkout', 'team', 'ready', 'fake-checkout-operation', ?, ?, 'sandbox', 2)").run(input.operationId, input.operationId, input.teamId, timestamp, timestamp);
  const provider = createStripeTeamBillingProvider({ config, env, apiBaseUrl: fake.origin });
  const { session, subscription, item } = await paid({ fake, provider });
  const [checkout, created] = fake.events.pending();
  assert.equal((await fake.events.deliver(created.id, { badSignature: true }))[0].status, 400);
  assert.equal((await fake.events.deliver(created.id, { staleTimestamp: true }))[0].status, 400);
  assert.equal((await inspectRuntimeJobs(database.adapter)).length, 0);
  // Deliberately reverse arrival: subscription metadata can correlate before Checkout admission.
  assert.deepEqual((await fake.events.deliverInOrder([created.id, checkout.id])).map((entry) => entry.status), [200, 200]);
  await settled(database);
  const projection = () => database.adapter.prepare("SELECT [state], [quantity], [productKey], [cancelAtPeriodEnd] FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionId] = ?").get(subscription.id);
  assert.deepEqual({ ...projection() }, { state: "active", quantity: 2, productKey: "team", cancelAtPeriodEnd: 0 });
  const admittedCount = (await inspectRuntimeJobs(database.adapter)).length;
  await fake.events.redeliver(created.id);
  await fake.events.redeliver(created.id, { mutatePayloadSameId: { ...subscription, status: "canceled" } });
  await settled(database);
  assert.equal((await inspectRuntimeJobs(database.adapter)).length, admittedCount);
  assert.equal(projection().state, "active");
  const retained = database.adapter.prepare("SELECT [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.stripe-event'").all().map((row) => JSON.parse(row.payload));
  assert.equal(retained.find((event) => event.providerEventId === created.id).raw.data.object.status, "active");
  await fake.clock.advance(3600);
  fake.faults.inject({ operation: "subscriptions.update", status: "paymentActionRequired" });
  const update = updateInput(subscription, item);
  assert.deepEqual(await provider.updateManagedSubscription(update), { ok: true, outcome: "payment-action-required" });
  const stripe = sdk(fake);
  const pending = await stripe.subscriptions.retrieve(subscription.id);
  assert.deepEqual(pending.items.data, subscription.items.data);
  assert.equal(pending.pending_update.subscription_items[0].price.id, "price_studio");
  assert.equal(pending.pending_update.subscription_items[0].quantity, 5);
  const eventCount = fake.state().events.length;
  const request = fake.requests().find((entry) => entry.operation === "subscriptions.update").parameters;
  const replay = () => stripe.subscriptions.update(subscription.id, { ...request, items: Object.values(request.items) }, { idempotencyKey: update.idempotencyKey });
  const pendingReplay = await replay();
  assert.equal(pendingReplay.lastResponse.headers["idempotent-replayed"], "true");
  assert.deepEqual(pendingReplay.items, pending.items);
  assert.deepEqual(pendingReplay.pending_update, pending.pending_update);
  assert.deepEqual(await provider.updateManagedSubscription(update), { ok: true, outcome: "payment-action-required" });
  assert.equal(fake.state().events.length, eventCount, "pending replay must not emit another event");
  assert.deepEqual((await fake.events.deliver()).map((entry) => entry.status), [200]);
  await settled(database);
  assert.deepEqual({ ...projection() }, { state: "active", quantity: 2, productKey: "team", cancelAtPeriodEnd: 0 });
  await fake.subscriptions.completePayment(subscription.id);
  await fake.events.deliver(); await settled(database);
  assert.equal(projection().productKey, "studio"); assert.equal(projection().quantity, 5);
  const resolved = await stripe.subscriptions.retrieve(subscription.id);
  assert.equal(resolved.pending_update, null);
  assert.equal(resolved.items.data[0].price.id, "price_studio");
  assert.equal(resolved.items.data[0].quantity, 5);
  assert.deepEqual((await replay()).pending_update, pending.pending_update, "POST replay retains its original pending response even after payment");
  assert.deepEqual(await provider.updateManagedSubscription(update), { ok: true, outcome: "payment-action-required" });
  assert.equal(fake.events.pending().length, 0, "replay must not overwrite resolved state or emit evidence");
  assert.deepEqual((await stripe.subscriptions.retrieve(subscription.id)).items, resolved.items);
  await fake.subscriptions.failPayment(subscription.id); await fake.events.deliver(); await settled(database);
  assert.equal(projection().state, "past-due");
  await fake.subscriptions.setStatus(subscription.id, "active"); await fake.events.deliver(); await settled(database);
  assert.equal(projection().state, "active");
  await fake.portal.cancelAtPeriodEnd(subscription.id); await fake.events.deliver(); await settled(database);
  assert.equal(projection().cancelAtPeriodEnd, 1);
  await fake.portal.resume(subscription.id); await fake.events.deliver(); await settled(database);
  assert.equal(projection().cancelAtPeriodEnd, 0);
  await fake.subscriptions.renew(subscription.id); await fake.events.deliver(); await settled(database);
  await provider.quiesceTeamBilling(erasure({ customerId: session.customer, subscriptionIds: [subscription.id] }));
  await fake.events.deliver(); await settled(database);
  assert.equal(projection().state, "cancelled");
  const malformed = { ...fake.subscriptions.get(subscription.id), items: { object: "list", has_more: true, data: [] } };
  const fresh = await fake.events.emit("customer.subscription.updated", malformed);
  await fake.events.deliver(); await settled(database);
  const observation = database.adapter.prepare("SELECT [outcome] FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?").get(fresh.id);
  assert.equal(observation.outcome, "quarantined");
  const unknown = await fake.events.emit("unknown.fake.event", { id: "obj_unknown" }); await fake.events.deliver(); await settled(database);
  assert.ok((await inspectRuntimeJobs(database.adapter)).every((entry) => entry.status === "succeeded"));
  assert.equal(fake.events.deliveries().find((entry) => entry.eventId === unknown.id).status, 200);
});

test("auto delivery signs committed state and never follows a webhook redirect", async (t) => {
  const bodies = [];
  const target = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    bodies.push(Stripe.webhooks.constructEvent(body, req.headers["stripe-signature"], secret));
    res.writeHead(302, { location: "https://stripe.com/forbidden-network" }).end();
  });
  const origin = await listen(target);
  const fake = await createStripeTeamBillingFake({ catalogue, webhookSecret: secret, webhookTarget: `${origin}/webhook` });
  t.after(async () => { await fake.close(); await stop(target); });
  const provider = createStripeTeamBillingProvider({ config, env, apiBaseUrl: fake.origin });
  await paid({ fake, provider });
  assert.equal(bodies.length, 2); assert.equal(fake.events.deliveries().length, 2);
  assert.ok(fake.events.deliveries().every((entry) => entry.status === null));
  assert.equal(fake.events.pending().length, 2);
});

test("packaged CLI prints isolated origins, accepts only stdin secrets, and shares the JSON control contract", async (t) => {
  const dir = await scratch(t); const cataloguePath = path.join(dir, "catalogue.json");
  await writeFile(cataloguePath, JSON.stringify(catalogue));
  const child = spawn(process.execPath, ["bin/sporades.js", "stripe-fake", "--json", "--port", "0", "--delivery", "manual", "--catalogue", cataloguePath,
    "--webhook-target", "http://127.0.0.1:5218/stripe/webhook", "--webhook-secret-stdin"],
    { env: { ...process.env, SPORADES_CONFIG_DIR: path.join(dir, "cli-config") }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } });
  let output = ""; let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk; });
  const started = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0])); });
    child.once("exit", () => reject(new Error(`Fake exited before startup: ${errors} ${output}`)));
  });
  child.stdin.end(`${secret}\n`);
  const { data } = await started;
  assert.notEqual(data.origin, data.controlOrigin); assert.doesNotMatch(output, /whsec_/);
  async function control(operation, ...args) {
    const response = await fetch(`${data.controlOrigin}/__control/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) });
    assert.equal(response.status, 200); return (await response.json()).data;
  }
  const provider = createStripeTeamBillingProvider({ config, env, apiBaseUrl: data.origin });
  const checkout = await provider.create(input);
  const complete = await control("checkout.complete", checkout.sessionId);
  assert.equal((await control("events.pending")).length, 2);
  assert.equal((await control("events.deliveries")).length, 0, "manual CLI mode queues transitions for controlled delivery");
  assert.equal((await control("subscriptions.get", complete.subscription)).status, "active");
  await control("subscriptions.setQuantity", complete.subscription, 4);
  assert.equal((await control("state")).subscriptions[0].items.data[0].quantity, 4);
  const subscription = await control("subscriptions.get", complete.subscription);
  await control("faults.inject", { operation: "subscriptions.update", status: "paymentActionRequired" });
  assert.equal((await provider.updateManagedSubscription(updateInput(subscription, subscription.items.data[0]))).outcome, "payment-action-required");
  assert.equal((await control("subscriptions.get", complete.subscription)).items.data[0].quantity, 4);
  assert.equal((await control("subscriptions.completePayment", complete.subscription)).items.data[0].quantity, 5);
  await control("faults.inject", { operation: "subscriptions.retrieve", status: 429 });
  await assert.rejects(sdk(data).subscriptions.retrieve(complete.subscription), (error) => error.statusCode === 429);
  await control("faults.clear"); await control("reset");
  assert.equal((await control("state")).subscriptions.length, 0);
  child.kill("SIGTERM"); assert.deepEqual(await exited, [0, null]);
});

test("canonical and generated testing declarations compile the same consumer contract", async (t) => {
  const dir = await scratch(t); const probe = path.join(dir, "consumer.mts");
  await writeFile(probe, `
import { createStripeTeamBillingFake, type StripeFakeFault, type StripeTeamBillingFakeOptions } from "sporades/testing/stripe";
import { createStripeTeamBillingFake as generatedFactory } from ${JSON.stringify(path.resolve("dist/testing/stripe.js"))};
const generated: typeof createStripeTeamBillingFake = generatedFactory;
const canonical: typeof generatedFactory = createStripeTeamBillingFake;
const options: StripeTeamBillingFakeOptions = { catalogue: { products: [], portalConfigurations: [] }, webhookSecret: "whsec_types", webhookTarget: "http://127.0.0.1:5218/webhook", delivery: "manual" };
const fake = await generated(options);
await fake.checkout.complete("cs_test_types");
await fake.events.deliver(undefined, { badSignature: true });
fake.faults.inject({ operation: "subscriptions.update", status: "paymentActionRequired", count: 1, when: "after" });
await fake.subscriptions.setQuantity("sub_types", 3);
await fake.subscriptions.completePayment("sub_types");
// @ts-expect-error Live mode is not a fixture option.
const live: StripeTeamBillingFakeOptions = { ...options, livemode: true };
// @ts-expect-error Unknown endpoint is not a provider operation.
const unknown: StripeFakeFault = { operation: "paymentIntents.create", status: 500 };
// @ts-expect-error Stripe's canceled status uses one l.
await fake.subscriptions.setStatus("sub_types", "cancelled");
void [canonical, live, unknown];
await fake.close();
`);
  const child = spawn(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", probe], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit"); assert.equal(code, 0, output);
});

test("lost managed and Portal acknowledgements replay the committed result; GET and DELETE never cache by key", async (t) => {
  const f = await fixture(t); const { fake, provider, stripe } = f;
  const { subscription, item } = await paid(f);
  const readKey = { idempotencyKey: "read-idempotency-ignored" };
  assert.equal((await stripe.subscriptions.retrieve(subscription.id, {}, readKey)).status, "active");
  await fake.subscriptions.setStatus(subscription.id, "past_due");
  assert.equal((await stripe.subscriptions.retrieve(subscription.id, {}, readKey)).status, "past_due");
  await fake.subscriptions.setStatus(subscription.id, "active");
  fake.faults.inject({ operation: "subscriptions.update", status: 503, when: "after" });
  const update = updateInput(subscription, item);
  await assert.rejects(provider.updateManagedSubscription(update), unavailable);
  assert.equal(fake.subscriptions.get(subscription.id).items.data[0].quantity, 5);
  const updateEvents = fake.events.pending().length;
  assert.equal((await provider.updateManagedSubscription(update)).outcome, "acknowledged");
  assert.equal(fake.events.pending().length, updateEvents, "idempotent replay must not emit a second mutation event");
  fake.faults.inject({ operation: "billingPortal.sessions.create", status: "timeout", when: "after" });
  const portal = { customerId: subscription.customer, configurationId: "bpc_team", returnPath: "/billing", idempotencyKey: "lost-portal-key" };
  await assert.rejects(provider.createPortal(portal), unavailable);
  const recovered = await provider.createPortal(portal);
  assert.equal(fake.state().portalSessions.length, 1);
  assert.equal(recovered.sessionId, fake.state().portalSessions[0].id);
  const deleteKey = { idempotencyKey: "delete-key-is-not-cached" };
  const canceled = await stripe.subscriptions.cancel(subscription.id, {}, deleteKey);
  assert.equal(canceled.status, "canceled");
  await assert.rejects(stripe.subscriptions.cancel(subscription.id, {}, deleteKey), (error) => error.statusCode === 400);
  assert.ok(fake.requests().filter((entry) => entry.method === "GET" || entry.method === "DELETE").every((entry) => !entry.replay));
  fake.faults.inject({ operation: "subscriptions.retrieve", status: 403, count: 2 });
  await assert.rejects(provider.updateManagedSubscription(update), (error) => error.code === "TEAM_BILLING_PROVIDER_REJECTED" && !error.retryable);
  await assert.rejects(provider.updateManagedSubscription(update), (error) => error.code === "TEAM_BILLING_PROVIDER_REJECTED" && !error.retryable);
  fake.faults.clear();
});
