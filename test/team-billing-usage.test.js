import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { String as Text, table, mutation } from "../dist/server.js";
import { openDevDatabase, createWebSocketHub, routeEndpoint, runCurrentUserJobWorker, inspectRuntimeJobs, runMutation } from "../dist/server-runtime-source.js";
import { normalizeTeamBillingDefinition, startTeamBillingCheckout, readCurrentUserTeamBilling } from "../dist/team-billing-runtime.js";
import { repairTeamBillingDesiredState, requestTeamBillingPlanTransition } from "../dist/team-billing-management.js";
import { createStripeTeamBillingFake } from "sporades/testing/stripe";
import { createStripeTeamBillingProvider } from "../dist/stripe-team-billing-provider.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";


const stripe = { sandbox: { priceId: "price_venues" }, live: { priceId: "price_live_venues" } };
const authorize = () => ({ allow: true });
const usage = () => ({ maxVenues: 0 });
const declaration = quantity => ({ catalogue: { multi: { quantity, stripe } }, authorize, usage });

test("usage quantity declares an exact meter and bounded optional floor and ceiling", () => {
  const quantity = { kind: "usage", meter: "maxVenues", minimum: 6, maximum: 12 };
  const normalized = normalizeTeamBillingDefinition(declaration(quantity));
  assert.deepEqual(normalized.catalogue.multi.quantity, quantity);
  assert.ok(Object.isFrozen(normalized.catalogue.multi.quantity));
  assert.equal(normalized.usage, usage);
  assert.deepEqual(normalizeTeamBillingDefinition(declaration({ kind: "usage", meter: "maxVenues" })).catalogue.multi.quantity,
    { kind: "usage", meter: "maxVenues" });
  for (const invalid of [
    { kind: "usage" }, { kind: "usage", meter: "" }, { kind: "usage", meter: "x".repeat(65) },
    ...[0, -1, 1.5, "6", 1_000_000].map(minimum => ({ ...quantity, minimum })),
    ...[0, -1, 1.5, "12", 1_000_000, 5].map(maximum => ({ ...quantity, maximum })),
    { ...quantity, extra: true },
  ]) assert.throws(() => normalizeTeamBillingDefinition(declaration(invalid)), error => error.code === "INVALID_TEAM_BILLING_DECLARATION");
  assert.throws(() => normalizeTeamBillingDefinition({ ...declaration(quantity), usage: undefined }), error => error.code === "INVALID_TEAM_BILLING_DECLARATION");
});


async function fixture(t, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-billing-usage-"));
  const state = { capturedDb: null, invalidUsage: null, reads: [], beforeUsage: null };
  const capsule = { name: "usage-billing", schema: {
    venues: table({ teamId: Text(), name: Text() }).acl({ read: () => false, insert: () => true, delete: () => true }),
  }, teamBilling: {
    ...declaration({ kind: "usage", meter: "maxVenues", minimum: 6, maximum: 8 }),
    catalogue: { ...declaration({ kind: "usage", meter: "maxVenues", minimum: 6, maximum: 8 }).catalogue,
      solo: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_solo" }, live: { priceId: "price_live_solo" } } },
    },
    checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" },
    usage: async (ctx, { teamId }) => {
      state.capturedDb = ctx.db;
      assert.ok(Object.isFrozen(ctx));
      assert.equal(ctx.db.venues.insert, undefined);
      await state.beforeUsage?.(ctx);
      const venues = await ctx.db.venues.where("teamId", teamId).all();
      state.reads.push(venues.length);
      return state.invalidUsage ?? { maxVenues: venues.length };
    },
  }, mutations: {
    add: mutation(async (ctx, teamId, fail = false) => {
      await ctx.teams.lockLifecycle(teamId);
      await ctx.db.venues.insert({ teamId, name: "venue" });
      if (fail) throw new Error("rollback venue");
      return { added: true };
    }),
    addPrivileged: mutation((ctx, teamId) => ctx.privileged.run({ operation: "usage.create", targetResourceKind: "venue" }, async privileged => {
      await privileged.teams.lockLifecycle(teamId);
      await privileged.db.venues.insert({ teamId, name: "privileged venue" });
      return { added: true };
    })),
    remove: mutation(async (ctx, teamId, id) => {
      await ctx.teams.lockLifecycle(teamId);
      await ctx.db.venues.delete(id);
      return { removed: true };
    }),
  } };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {
    STRIPE_SECRET_KEY: "sk_test_usage", STRIPE_WEBHOOK_SECRET: "whsec_usage",
  }, { name: capsule.name, auth: { providers: { email: true } }, payments: { stripe: {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://usage.example.test", callbackPath: "/stripe/webhook", apiVersion: "2026-08-26.dahlia", requestTimeoutMs: 1000, livemode: false,
  } } }, capsule, { createStripeTeamBillingProvider, createStripeCallbackEndpoint });
  const hub = createWebSocketHub(() => database);
  const server = createServer(async (req, res) => {
    if (!await routeEndpoint(database, req, res)) res.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const fake = await createStripeTeamBillingFake({ catalogue: { products: [
    { id: "prod_venues", prices: [{ id: "price_venues", recurring: "month" }] },
    { id: "prod_solo", prices: [{ id: "price_solo", recurring: "month" }] },
  ], portalConfigurations: [] }, webhookSecret: "whsec_usage", webhookTarget: `http://127.0.0.1:${server.address().port}/stripe/webhook`, delivery: "manual" });
  database.stripeApiBaseUrl = fake.origin;
  await database.init();
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
  await once(ws, "open");
  let sequence = 0;
  const send = message => new Promise((resolve, reject) => {
    const id = `usage-${sequence++}`;
    const timer = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error(`Timeout: ${message.type}`)); }, 10000);
    const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener("message", listener); resolve(result); } };
    ws.addEventListener("message", listener); ws.send(JSON.stringify({ ...message, id }));
  });
  t.after(async () => { hub.disconnectAll(); await fake.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); });
  const signed = await send({ type: "auth.signUp", provider: "email", credentials: { email: "usage@example.test", password: "password-123", name: "Admin" } });
  assert.equal(signed.error, null, JSON.stringify(signed));
  const created = await send({ type: "teams.create", name: "Venues" });
  assert.equal(created.error, null);
  const teamId = created.data.team.id;
  const change = (name, ...args) => send({ type: "mutation.run", name, args: [teamId, ...args] });
  const settle = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await runCurrentUserJobWorker(database);
      const jobs = (await inspectRuntimeJobs(database.adapter)).filter(job => !job.handler.includes("expiry"));
      assert.ok(jobs.every(job => !["failed", "delayed"].includes(job.status)), JSON.stringify(jobs));
      if (jobs.every(job => job.status === "succeeded")) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("billing Jobs did not settle");
  };
  const truth = () => readCurrentUserTeamBilling(database, signed.data.auth, teamId);
  await run({ database, capsule, fake, change, settle, truth, teamId, auth: signed.data.auth, state, token: signed.data.sessionToken });
}

test("usage Checkout reads exact cross-owner counts with the declared minimum", async t => {
  await fixture(t, async ({ database, fake, change, settle, teamId, auth, state }) => {
    for (let index = 0; index < 7; index++) assert.equal((await change("add")).error, null);
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    assert.equal(fake.state().checkouts[0].line_items.data[0].quantity, 7);
    assert.ok(state.reads.includes(7));
    await assert.rejects(async () => state.capturedDb.venues.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
  });
});

test("venue writes atomically sync 6 to 7 and back, enforce maximum, and repair verified drift", async t => {
  await fixture(t, async ({ database, fake, change, settle, truth, teamId, auth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    assert.equal(fake.state().checkouts[0].line_items.data[0].quantity, 6);
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 6);
    for (let index = 0; index < 7; index++) assert.equal((await change("add")).error, null);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    const update = fake.requests().filter(request => request.operation === "subscriptions.update").at(-1).parameters;
    assert.equal(update.proration_behavior, "create_prorations");
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 7);
    const venue = database.adapter.prepare("SELECT [id] FROM [venues] LIMIT 1").get();
    assert.equal((await change("remove", venue.id)).error, null);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 6);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 6);
    const belowFloorVenue = database.adapter.prepare("SELECT [id] FROM [venues] LIMIT 1").get();
    const writesBefore = fake.requests().filter(request => request.operation === "subscriptions.update").length;
    assert.equal((await change("remove", belowFloorVenue.id)).error, null);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 6);
    assert.equal(fake.requests().filter(request => request.operation === "subscriptions.update").length, writesBefore);
    assert.equal((await change("add")).error, null);
    const before = database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [venues]").get().count;
    assert.ok((await change("add", true)).error);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [venues]").get().count, before);
    assert.equal((await change("add")).error, null);
    assert.equal((await change("add")).error, null);
    assert.ok((await change("add")).error, "ninth venue exceeds maximum eight");
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [venues]").get().count, 8);
    await settle(); await fake.events.deliver(); await settle();
    await fake.subscriptions.setQuantity(session.subscription, 7);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).state, "pending", "verified drift stages repair without granting the desired quantity");
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 8);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 8);
  });
});


test("invalid or missing exact usage refuses Checkout without provider writes", async t => {
  await fixture(t, async ({ database, fake, teamId, auth, state }) => {
    for (const invalid of [{}, { maxVenues: -1 }, { maxVenues: 1.5 }, { maxVenues: "7" }, { maxVenues: 1_000_000 }]) {
      state.invalidUsage = invalid;
      await assert.rejects(() => startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi"),
        error => error.code === "TEAM_BILLING_USAGE_UNAVAILABLE");
    }
    assert.equal(fake.requests().length, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_operations]").get().count, 0);
  });
});

test("managed fixed-to-usage transitions use the live count and can switch back to fixed", async t => {
  await fixture(t, async ({ database, fake, change, settle, truth, teamId, auth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "solo");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    for (let index = 0; index < 7; index++) assert.equal((await change("add")).error, null);
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 1);
    await requestTeamBillingPlanTransition(database, auth, teamId, randomUUID(), "multi");
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).productKey, "multi");
    await requestTeamBillingPlanTransition(database, auth, teamId, randomUUID(), "solo");
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 1);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).productKey, "solo");
  });
});


test("an abort during the final usage count rolls back resource and billing intent", async t => {
  await fixture(t, async ({ database, fake, settle, teamId, auth, state, token }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let calls = 0;
    state.beforeUsage = async () => { if (++calls === 2) { enter(); await held; } };
    const controller = new AbortController();
    const response = runMutation(database, auth, "add", [teamId], { sessionToken: token, signal: controller.signal });
    await entered;
    controller.abort(); release();
    assert.ok((await response).error);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [venues]").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_desired_state]").get().count, 0);
  });
});

test("below-floor verified usage drift stays quarantined and repairs the exact known item", async t => {
  await fixture(t, async ({ database, fake, settle, teamId, auth, truth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    await fake.subscriptions.setQuantity(session.subscription, 5);
    const drift = fake.events.pending().at(-1);
    await fake.events.deliver(); await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 6);
    assert.equal((await truth()).state, "pending");
    assert.equal(database.adapter.prepare("SELECT [outcome] FROM [sporades_team_billing_observations] WHERE [providerEventId] = ?").get(drift.id).outcome, "quarantined");
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 6);
  });
});


test("startup repair reconstructs missing usage intent from exact resources", async t => {
  await fixture(t, async ({ database, fake, settle, teamId, auth, truth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    // Simulate legacy resource writes that omitted the lifecycle staging boundary.
    for (let index = 0; index < 7; index++) database.adapter.prepare(
      "INSERT INTO [venues] ([id], [teamId], [name], [createdAt], [updatedAt]) VALUES (?, ?, 'legacy venue', ?, ?)",
    ).run(randomUUID(), teamId, new Date().toISOString(), new Date().toISOString());
    assert.equal((await repairTeamBillingDesiredState(database)).queued, 1);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 7);
  });
});

for (const driftQuantity of [5, 6]) test(`acknowledged usage intent repairs later drift to ${driftQuantity} with a fresh provider write`, async t => {
  await fixture(t, async ({ database, fake, change, settle, teamId, auth, truth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    for (let index = 0; index < 7; index++) assert.equal((await change("add")).error, null);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    const initial = fake.requests().filter(request => request.operation === "subscriptions.update").at(-1);
    await fake.subscriptions.setQuantity(session.subscription, driftQuantity);
    const drift = fake.events.pending().at(-1);
    await fake.events.deliver(drift.id); await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    const repair = fake.requests().filter(request => request.operation === "subscriptions.update").at(-1);
    assert.notEqual(repair.idempotencyKey, initial.idempotencyKey, "new provider drift must not replay the previous acknowledgement");
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 7);
  });
});


test("Privileged resource writes stage usage after callback expiry and outer commit", async t => {
  await fixture(t, async ({ database, fake, change, settle, teamId, auth, truth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "multi");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    for (let index = 0; index < 7; index++) assert.equal((await change("addPrivileged")).error, null);
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).quantity, 7);
  });
});

test("cross-policy acknowledged usage transition repairs below-floor drift before first target evidence", async t => {
  await fixture(t, async ({ database, fake, change, settle, teamId, auth, truth }) => {
    await startTeamBillingCheckout(database, auth, teamId, randomUUID(), "solo");
    await settle();
    const session = await fake.checkout.complete(fake.state().checkouts[0].id);
    await fake.events.deliver(); await settle();
    for (let index = 0; index < 7; index++) assert.equal((await change("add")).error, null);
    await requestTeamBillingPlanTransition(database, auth, teamId, randomUUID(), "multi");
    await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    const initial = fake.requests().filter(request => request.operation === "subscriptions.update").at(-1);
    await fake.subscriptions.setQuantity(session.subscription, 5);
    const drift = fake.events.pending().at(-1);
    await fake.events.deliver(drift.id); await settle();
    assert.equal(fake.subscriptions.get(session.subscription).items.data[0].quantity, 7);
    const repair = fake.requests().filter(request => request.operation === "subscriptions.update").at(-1);
    assert.notEqual(repair.idempotencyKey, initial.idempotencyKey);
    await fake.events.deliver(); await settle();
    assert.equal((await truth()).productKey, "multi");
    assert.equal((await truth()).quantity, 7);
  });
});
