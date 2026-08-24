import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createControllableRuntimeClock, createPostgresDatabaseAdapter, openDevDatabase, recoverExpiredJobLeases, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { mutation, query } from "../dist/server.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { teamBillingErasureKey } from "../dist/team-billing-runtime.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, withPostgresAdapter } from "./support/database-adapter-engines.js";

const sourceMode = process.execArgv.includes("--experimental-strip-types");
const erasure = await import(sourceMode
  ? "../src/team-billing-erasure.ts" : "../dist/team-billing-erasure.js");

const {
  createCurrentUserTeamBillingErasureApi,
  performTeamBillingErasure,
  prepareTeamBillingErasure,
  repairTeamBillingErasureStateAtStartup,
  settleExhaustedTeamBillingErasureJob,
} = erasure;

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const retryRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const auth = { userId: "erasure-admin", isAuthenticated: true, isGuest: false, provider: "test" };

test("provider-quiesced erasure returns only local deletion authorization and leaves a provider-free tombstone", async () => {
  const fixture = openFixture();
  try {
    const pending = await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    assert.deepEqual(pending, { state: "pending", teamId, requestId, requestedAt: "2026-08-24T10:00:00.000Z" });
    assert.equal(fixture.providerCalls.length, 0, "admission never performs provider I/O");
    assert.equal(fixture.enqueued.length, 1);
    assert.deepEqual(await prepareTeamBillingErasure(fixture.database, auth, teamId, retryRequestId), {
      state: "pending", teamId, requestId: retryRequestId, requestedAt: "2026-08-24T10:00:00.000Z",
    }, "a refreshed client can safely observe the same provider intent with a fresh command identity");
    assert.equal(fixture.enqueued.length, 1, "retry observation does not enqueue duplicate provider work");

    assert.deepEqual(await performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload), { providerQuiesced: true });
    assert.deepEqual(fixture.providerCalls[0], {
      mode: "sandbox",
      customerId: "cus_erasure",
      checkoutSessionIds: ["cs_test_erasure"],
      subscriptionIds: ["sub_erasure"],
      idempotencyKey: fixture.providerCalls[0].idempotencyKey,
    });
    assert.match(fixture.providerCalls[0].idempotencyKey, /^sporades-team-billing-erasure-/);

    assert.deepEqual(await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId), {
      state: "authorized", teamId, requestId,
    });
    assert.equal(fixture.count("sporades_team_billing_customers"), 0);
    assert.equal(fixture.count("sporades_team_billing_subscriptions"), 0);
    assert.equal(fixture.count("sporades_team_billing_operations"), 0);
    assert.equal(fixture.count("sporades_team_billing_erasure_state"), 0);
    const tombstone = fixture.sqlite.prepare("SELECT * FROM [sporades_team_billing_erasure_tombstones]").get();
    assert.deepEqual(Object.keys(tombstone).sort(), ["createdAt", "erasureKey", "evidenceDigest", "providerQuiescedAt"]);
    assert.ok(!JSON.stringify(tombstone).includes(teamId));
    assert.ok(!JSON.stringify(tombstone).includes("cus_erasure"));
    assert.ok(!JSON.stringify(tombstone).includes("sub_erasure"));
    const objectTombstones = fixture.sqlite.prepare("SELECT * FROM [sporades_team_billing_erasure_object_tombstones] ORDER BY [kind]").all();
    assert.equal(objectTombstones.length, 2);
    assert.equal(JSON.stringify(objectTombstones).includes("cs_test_erasure"), false);
    assert.equal(JSON.stringify(objectTombstones).includes("sub_erasure"), false);
  } finally {
    fixture.sqlite.close();
  }
});

test("erasure retries stable provider intent, accepts newly discovered closed objects, and admits local deletion only afterward", async () => {
  const fixture = openFixture();
  try {
    const pending = await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    const localContext = { signal: new AbortController().signal };
    const localApi = createCurrentUserTeamBillingErasureApi(
      { ...fixture.database, __transactionActive: true }, auth,
      () => localContext,
      (candidate) => candidate === localContext,
    );
    await assert.rejects(localApi.admitLocalErasure(teamId), (error) => error?.code === "TEAM_BILLING_ERASURE_UNAVAILABLE");

    fixture.controls.error = Object.assign(new Error("provider outage"), { code: "TEAM_BILLING_PROVIDER_UNAVAILABLE", retryable: true });
    await assert.rejects(performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload), /provider outage/);
    assert.equal(fixture.sqlite.prepare("SELECT [status] FROM [sporades_team_billing_erasure_state]").get().status, "queued");
    fixture.controls.error = null;
    fixture.controls.outcome = {
      ok: true, outcome: "quiesced", providerObservedAt: "2026-08-24T10:00:00.000Z",
      checkouts: [{ id: "cs_test_erasure", state: "safely-closed" }],
      subscriptions: [
        { id: "sub_discovered_late", state: "cancelled" },
        { id: "sub_erasure", state: "safely-closed" },
      ],
    };
    assert.deepEqual(await performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload), { providerQuiesced: true });
    assert.equal(fixture.providerCalls.length, 2);
    assert.equal(fixture.providerCalls[0].idempotencyKey, fixture.providerCalls[1].idempotencyKey);
    assert.deepEqual(await localApi.admitLocalErasure(teamId), { allowed: true });
    assert.deepEqual(await prepareTeamBillingErasure(fixture.database, auth, teamId, pending.requestId), {
      state: "authorized", teamId, requestId,
    });
  } finally { fixture.sqlite.close(); }
});

test("local erasure admission is revoked for detached, rolled-back, aborted, and settled transaction contexts", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    await performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload);
    const abortController = new AbortController();
    const context = { signal: abortController.signal };
    let current = context;
    let active = true;
    const api = createCurrentUserTeamBillingErasureApi(
      { ...fixture.database, __transactionActive: true }, auth,
      () => current,
      (candidate) => active && candidate === current,
    );

    assert.deepEqual(await api.admitLocalErasure(teamId), { allowed: true });

    fixture.controls.authorityGate = deferred();
    const detached = api.admitLocalErasure(teamId);
    await fixture.controls.authorityGate.started;
    active = false;
    fixture.controls.authorityGate.resolve();
    await assert.rejects(detached, inactiveErasureAdmission);

    active = true;
    fixture.controls.authorityGate = null;
    abortController.abort();
    await assert.rejects(api.admitLocalErasure(teamId), inactiveErasureAdmission);

    const rollbackContext = { signal: new AbortController().signal };
    current = rollbackContext;
    const rollbackApi = createCurrentUserTeamBillingErasureApi(
      { ...fixture.database, __transactionActive: true }, auth,
      () => current,
      (candidate) => active && candidate === rollbackContext,
    );
    active = false;
    await assert.rejects(rollbackApi.admitLocalErasure(teamId), inactiveErasureAdmission);

    current = null;
    await assert.rejects(rollbackApi.admitLocalErasure(teamId), inactiveErasureAdmission);
  } finally { fixture.sqlite.close(); }
});

test("the real mutation transaction owns and revokes local erasure admission", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-erasure-admission-"));
  let retainedApi;
  let detachedAdmission;
  const capsule = {
    name: "team-erasure-admission",
    schema: {},
    teamBilling: testTeamBillingDefinition(),
    mutations: {
      admit: mutation(async (ctx, exactTeamId) => {
        retainedApi = ctx.teamBilling;
        return ctx.teamBilling.admitLocalErasure(exactTeamId);
      }),
      detach: mutation((ctx, exactTeamId) => {
        retainedApi = ctx.teamBilling;
        detachedAdmission = ctx.teamBilling.admitLocalErasure(exactTeamId);
        return { detached: true };
      }),
      rollback: mutation(async (ctx, exactTeamId) => {
        retainedApi = ctx.teamBilling;
        await ctx.teamBilling.admitLocalErasure(exactTeamId);
        throw new Error("rollback local deletion");
      }),
    },
  };
  const serverEnv = { STRIPE_SECRET_KEY: "sk_test_erasure_admission", STRIPE_WEBHOOK_SECRET: "whsec_erasure_admission" };
  const payments = testPaymentsConfig();
  let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, {
      name: capsule.name, auth: { providers: { anonymous: true } }, payments,
    }, capsule, { serviceEnv: serverEnv, createStripeCallbackEndpoint });
    const createdAt = "2026-08-24T10:00:00.000Z";
    await database.adapter.prepare("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('erasure-admin', ?, 'Admin', NULL, NULL, 1, 0, 'test')").run(createdAt);
    await database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Admission erasure', ?, 'erasure-admin')").run(teamId, createdAt);
    await database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)").run(teamId, createdAt);
    await database.adapter.prepare("INSERT INTO [sporades_team_billing_erasure_tombstones] ([erasureKey], [evidenceDigest], [providerQuiescedAt], [createdAt]) VALUES (?, ?, ?, ?)")
      .run(teamBillingErasureKey(database, teamId), "a".repeat(64), createdAt, createdAt);

    assert.deepEqual(await runMutation(database, auth, "admit", [teamId]), {
      ok: true, data: { allowed: true }, error: null,
    });
    await assert.rejects(retainedApi.admitLocalErasure(teamId), inactiveErasureAdmission);

    assert.equal((await runMutation(database, auth, "rollback", [teamId])).error.message, "rollback local deletion");
    await assert.rejects(retainedApi.admitLocalErasure(teamId), inactiveErasureAdmission);

    assert.deepEqual(await runMutation(database, auth, "detach", [teamId]), {
      ok: true, data: { detached: true }, error: null,
    });
    await assert.rejects(detachedAdmission, inactiveErasureAdmission);
  } finally {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Capsule mutation policy reads only the provider-free projection for a current Team member", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-member-read-"));
  const memberAuth = { userId: "billing-member", isAuthenticated: true, isGuest: false, provider: "test" };
  const capsule = {
    name: "team-billing-member-read",
    schema: {},
    teamBilling: testTeamBillingDefinition(),
    mutations: { billing: mutation(async (ctx, exactTeamId) => await ctx.teamBilling.get(exactTeamId)) },
  };
  let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
      name: capsule.name, auth: { providers: { anonymous: true } },
    }, capsule);
    const createdAt = "2026-08-24T10:00:00.000Z";
    await database.adapter.prepare("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('billing-member', ?, 'Member', NULL, NULL, 1, 0, 'test')").run(createdAt);
    await database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Billing read', ?, 'billing-member')").run(teamId, createdAt);
    await database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'billing-member', 'member', ?)").run(teamId, createdAt);

    assert.deepEqual(await runMutation(database, memberAuth, "billing", [teamId]), {
      ok: true, data: { state: "inactive", teamId }, error: null,
    });
    assert.equal((await runMutation(database, memberAuth, "billing", [requestId])).error.code, "TEAM_BILLING_DENIED");
  } finally {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Capsule query projection access is revoked when the query settles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-query-read-"));
  let retainedApi;
  const capsule = {
    name: "team-billing-query-read",
    schema: {}, teamBilling: testTeamBillingDefinition(),
    queries: { billing: query(async (ctx, exactTeamId) => {
      retainedApi = ctx.teamBilling;
      return await ctx.teamBilling.get(exactTeamId);
    }) },
  };
  let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: capsule.name }, capsule);
    const now = "2026-08-24T10:00:00.000Z";
    await database.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Query read', ?, 'erasure-admin')").run(teamId, now);
    await database.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)").run(teamId, now);
    assert.deepEqual(await runQuery(database, auth, "billing", [teamId]), { data: { state: "inactive", teamId }, error: null });
    await assert.rejects(retainedApi.get(teamId), inactiveErasureAdmission);
  } finally {
    await database?.close(); await rm(dir, { recursive: true, force: true });
  }
});

test("erasure refuses incomplete or malformed provider evidence without authorizing deletion", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    fixture.controls.outcome = {
      ok: true, outcome: "quiesced", providerObservedAt: "2026-08-24T10:00:00.000Z",
      checkouts: [{ id: "cs_test_erasure", state: "expired" }], subscriptions: [],
    };
    await assert.rejects(performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload),
      (error) => error?.code === "TEAM_BILLING_ERASURE_UNAVAILABLE");
    assert.equal(fixture.count("sporades_team_billing_erasure_tombstones"), 0);
    assert.equal(fixture.count("sporades_team_billing_subscriptions"), 1);
  } finally { fixture.sqlite.close(); }
});

test("background erasure rechecks current Team authority before provider I/O", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    fixture.controls.authority = false;
    await assert.rejects(performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload),
      (error) => error?.code === "TEAM_BILLING_DENIED");
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.count("sporades_team_billing_erasure_tombstones"), 0);
  } finally { fixture.sqlite.close(); }
});

test("erasure recovers an attempted Checkout from its exact immutable provider request", async () => {
  const fixture = openFixture();
  try {
    fixture.sqlite.prepare(
      "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode], [quantity], [providerPriceId], [providerExpiresAt], [attemptedAt]) " +
      "VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', ?, 'erasure-admin', 'checkout', 'agency', 'retrying', NULL, 'checkout-lost-stable-key', NULL, ?, ?, 'sandbox', 2, 'price_erasure', 2000000000, ?)",
    ).run(teamId, "2026-08-24T10:00:00.000Z", "2026-08-24T10:00:00.000Z", "2026-08-24T10:00:00.000Z");
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    fixture.controls.outcome = {
      ok: true, outcome: "quiesced", providerObservedAt: "2026-08-24T10:00:00.000Z",
      checkouts: [
        { id: "cs_test_erasure", state: "expired" },
        { id: "cs_test_recovered_lost", state: "expired" },
      ],
      subscriptions: [{ id: "sub_erasure", state: "cancelled" }],
    };
    await performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload);
    assert.deepEqual(fixture.providerCalls[0].checkoutRecoveries, [{
      operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      teamId,
      productKey: "agency",
      mode: "subscription",
      priceId: "price_erasure",
      quantity: 2,
      successPath: "/billing/success",
      cancelPath: "/billing/cancelled",
      idempotencyKey: "checkout-lost-stable-key",
      businessReference: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      providerExpiresAt: 2_000_000_000,
      customerId: "cus_erasure",
    }]);
  } finally { fixture.sqlite.close(); }
});

test("restart repair creates a fresh fenced Job generation without changing provider intent", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    const stale = fixture.enqueued[0].payload;
    assert.deepEqual(await repairTeamBillingErasureStateAtStartup(fixture.database), { queued: 1 });
    const fresh = fixture.enqueued[1].payload;
    assert.notEqual(fresh.generationId, stale.generationId);
    assert.equal(fresh.operationId, stale.operationId);
    assert.deepEqual(await settleExhaustedTeamBillingErasureJob(fixture.database, stale, "JOB_LEASE_EXPIRED"), { settled: false });
    assert.deepEqual(await performTeamBillingErasure(fixture.database, {}, stale), { superseded: true });
    await performTeamBillingErasure(fixture.database, {}, fresh);
    assert.equal(fixture.providerCalls.length, 1);
    assert.match(fixture.providerCalls[0].idempotencyKey, /^sporades-team-billing-erasure-/);
  } finally { fixture.sqlite.close(); }
});

test("erasure exhaustion retains a fresh delayed generation behind a live provider claim", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    const stale = fixture.enqueued[0].payload;
    const claimExpiresAt = "2026-08-24T10:05:00.000Z";
    fixture.sqlite.prepare(
      "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, 'foreign-owner', ?, ?)",
    ).run(teamId, claimExpiresAt, fixture.controls.instant);

    assert.deepEqual(await settleExhaustedTeamBillingErasureJob(
      fixture.database, stale, "TEAM_BILLING_PROVIDER_LANE_BUSY",
    ), { settled: false, busy: true, replacementScheduled: true, availableAt: claimExpiresAt });
    const fresh = fixture.enqueued[1];
    assert.notEqual(fresh.payload.generationId, stale.generationId);
    assert.equal(fresh.availableAt, claimExpiresAt);
    assert.equal(fixture.sqlite.prepare("SELECT [status] FROM [sporades_team_billing_erasure_state]").get().status, "queued");
    assert.deepEqual(await performTeamBillingErasure(fixture.database, {}, stale), { superseded: true });
  } finally { fixture.sqlite.close(); }
});

test("a stale erasure provider result cannot settle state or remove a newer provider claimant", async () => {
  const fixture = openFixture();
  try {
    await prepareTeamBillingErasure(fixture.database, auth, teamId, requestId);
    fixture.controls.providerGate = deferred();
    const staleCall = performTeamBillingErasure(fixture.database, {}, fixture.enqueued[0].payload);
    await fixture.controls.providerGate.started;
    const staleLane = fixture.sqlite.prepare(
      "SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
    ).get(teamId);
    fixture.controls.instant = new Date(Date.parse(staleLane.claimExpiresAt) + 1).toISOString();
    const newerExpiry = new Date(Date.parse(fixture.controls.instant) + 5 * 60_000).toISOString();
    fixture.sqlite.prepare(
      "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = 'newer-owner', [claimExpiresAt] = ?, [updatedAt] = ? WHERE [teamId] = ? AND [claimToken] = ?",
    ).run(newerExpiry, fixture.controls.instant, teamId, staleLane.claimToken);
    fixture.controls.providerGate.resolve();

    assert.deepEqual(await staleCall, { superseded: true });
    assert.equal(fixture.count("sporades_team_billing_erasure_tombstones"), 0);
    assert.equal(fixture.sqlite.prepare(
      "SELECT [claimToken] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
    ).get(teamId).claimToken, "newer-owner");
    assert.equal(fixture.count("sporades_team_billing_erasure_state"), 1);
  } finally { fixture.sqlite.close(); }
});

test("real runtime exhaustion and lease recovery wake fresh erasure generations at provider-lane expiry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-erasure-lane-recovery-"));
  const clock = createControllableRuntimeClock("2026-08-24T10:00:00.000Z");
  const providerCalls = [];
  const serverEnv = { STRIPE_SECRET_KEY: "sk_test_erasure_lane", STRIPE_WEBHOOK_SECRET: "whsec_erasure_lane" };
  const payments = testPaymentsConfig();
  const capsule = { name: "team-erasure-lane-recovery", schema: {}, teamBilling: testTeamBillingDefinition() };
  let database;
  try {
    database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, {
      name: capsule.name, auth: { providers: { anonymous: true } }, payments,
    }, capsule, {
      clock, serviceEnv: serverEnv, createStripeCallbackEndpoint,
      createStripeTeamBillingProvider: () => ({
        async quiesceTeamBilling(input) {
          providerCalls.push(input);
          return {
            ok: true, outcome: "quiesced", providerObservedAt: clock.now().toISOString(),
            checkouts: input.checkoutSessionIds.map((id) => ({ id, state: "expired" })),
            subscriptions: input.subscriptionIds.map((id) => ({ id, state: "cancelled" })),
          };
        },
      }),
    });
    await database.init();
    await seedRuntimeErasureTarget(database, teamId, "cus_erasure_lane_normal", "sub_erasure_lane_normal", "cs_test_erasure_lane_normal", clock.now().toISOString());
    await prepareTeamBillingErasure(database, auth, teamId, requestId);
    await database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [attempts] = 5 WHERE [handler] = '_sporades.team-billing-erasure'",
    ).run();
    const normalExpiry = new Date(clock.now().getTime() + 5 * 60_000).toISOString();
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, 'crashed-normal-owner', ?, ?)",
    ).run(teamId, normalExpiry, clock.now().toISOString());

    await clock.runDueTimers();
    const normalSuccessor = await database.adapter.prepare(
      "SELECT [status], [availableAt], [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-erasure' AND [availableAt] = ?",
    ).get(normalExpiry);
    assert.equal(normalSuccessor.status, "delayed");
    assert.equal(providerCalls.length, 0);
    clock.setInstant(new Date(Date.parse(normalExpiry) + 1));
    await clock.runDueTimers();
    assert.equal(providerCalls.length, 1, "normal exhaustion successor converges without another restart");

    const leaseTeamId = "abababab-abab-4bab-8bab-abababababab";
    const leaseRequestId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    await seedRuntimeErasureTarget(database, leaseTeamId, "cus_erasure_lane_lease", "sub_erasure_lane_lease", "cs_test_erasure_lane_lease", clock.now().toISOString());
    await prepareTeamBillingErasure(database, auth, leaseTeamId, leaseRequestId);
    const leaseJob = await database.adapter.prepare(
      "SELECT [id], [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-erasure' AND [status] = 'queued' ORDER BY [createdAt] DESC, [id] DESC LIMIT 1",
    ).get();
    const expiredLease = new Date(clock.now().getTime() - 1).toISOString();
    await database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 6, [leaseExpiresAt] = ?, [claimToken] = 'crashed-lease-job' WHERE [id] = ?",
    ).run(expiredLease, leaseJob.id);
    const leaseLaneExpiry = new Date(clock.now().getTime() + 5 * 60_000).toISOString();
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, 'crashed-lease-owner', ?, ?)",
    ).run(leaseTeamId, leaseLaneExpiry, clock.now().toISOString());

    await recoverExpiredJobLeases(database);
    const leaseSuccessor = await database.adapter.prepare(
      "SELECT [status], [availableAt], [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-erasure' AND [availableAt] = ?",
    ).get(leaseLaneExpiry);
    assert.equal(leaseSuccessor.status, "delayed");
    assert.notDeepEqual(JSON.parse(leaseSuccessor.payload), JSON.parse(leaseJob.payload));
    assert.equal(providerCalls.length, 1);
    clock.setInstant(new Date(Date.parse(leaseLaneExpiry) + 1));
    await clock.runDueTimers();
    assert.equal(providerCalls.length, 2, "lease recovery successor converges without another restart");
  } finally {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two PostgreSQL runtimes fence a stale erasure call after a newer claimant acquires the expired lane", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (firstAdapter) => {
    await firstAdapter.ensureTeamsStorage();
    await firstAdapter.ensureTeamBillingStorage();
    const secondAdapter = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    const firstGate = deferred();
    const secondGate = deferred();
    const enqueued = [];
    let instant = new Date("2026-08-24T10:00:00.000Z");
    try {
      const sql = firstAdapter.dialect.sql;
      const createdAt = instant.toISOString();
      await firstAdapter.prepare(sql(
        "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Postgres erasure lane', ?, 'erasure-admin')",
      )).run(teamId, createdAt);
      await firstAdapter.prepare(sql(
        "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)",
      )).run(teamId, createdAt);
      await firstAdapter.prepare(sql(
        "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_erasure_pg_lane', ?, ?)",
      )).run(teamId, createdAt, createdAt);
      await firstAdapter.prepare(sql(
        "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('pg-erasure-subscription', ?, 'sandbox', 'sub_erasure_pg_lane', 'price_erasure_admission', NULL, 'agency', 1, 'active', 0, ?, ?, 0)",
      )).run(teamId, createdAt, createdAt);
      await firstAdapter.prepare(sql(
        "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode]) VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', ?, 'erasure-admin', 'checkout', 'agency', 'ready', 'cs_test_erasure_pg_lane', 'checkout-erasure-pg-lane', NULL, ?, ?, 'sandbox')",
      )).run(teamId, createdAt, createdAt);
      const makeDatabase = (adapter, gate) => ({
        adapter, capsuleIdentity: "postgres-erasure-lane", clock: { now: () => new Date(instant) },
        paymentsConfig: { stripe: { livemode: false } }, teamBillingDefinition: testTeamBillingDefinition(),
        runTeamBillingAuthority: async () => ({ allow: true }), readTeamBillingActorAuth: async () => auth,
        enqueueTeamBillingErasureJob: async (_transaction, payload, key, availableAt) => enqueued.push({ payload, key, availableAt }),
        scheduleTeamBillingJobDispatch() {},
        quiesceTeamBillingProvider: async () => {
          gate.markStarted();
          await gate.promise;
          return {
            ok: true, outcome: "quiesced", providerObservedAt: instant.toISOString(),
            checkouts: [{ id: "cs_test_erasure_pg_lane", state: "expired" }],
            subscriptions: [{ id: "sub_erasure_pg_lane", state: "cancelled" }],
          };
        },
      });
      const first = makeDatabase(firstAdapter, firstGate);
      const second = makeDatabase(secondAdapter, secondGate);
      await prepareTeamBillingErasure(first, auth, teamId, requestId);
      const payload = enqueued[0].payload;
      const staleCall = performTeamBillingErasure(first, {}, payload);
      await firstGate.started;
      const firstLane = await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
      )).get(teamId);
      instant = new Date(Date.parse(firstLane.claimExpiresAt) + 1);
      const currentCall = performTeamBillingErasure(second, {}, payload);
      await secondGate.started;

      firstGate.resolve();
      assert.deepEqual(await staleCall, { superseded: true });
      assert.ok((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [claimToken] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
      )).get(teamId)).claimToken, "stale settlement cannot remove the newer runtime's claim");
      assert.equal(Number((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_erasure_tombstones]",
      )).get()).count), 0);

      secondGate.resolve();
      assert.deepEqual(await currentCall, { providerQuiesced: true });
      assert.equal(Number((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_erasure_tombstones]",
      )).get()).count), 1);
    } finally {
      firstGate.resolve?.();
      secondGate.resolve?.();
      await secondAdapter.close();
    }
  });
});

test("a real runtime restart replaces retained erasure work and converges without another request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-erasure-restart-"));
  const databasePath = path.join(dir, "data.db");
  const providerCalls = [];
  const serverEnv = { STRIPE_SECRET_KEY: "sk_test_erasure_restart", STRIPE_WEBHOOK_SECRET: "whsec_erasure_restart" };
  const payments = { stripe: {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://erasure.example.test", callbackPath: "/stripe/webhook",
    apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
  } };
  const capsule = { name: "team-erasure-restart", schema: {}, teamBilling: {
    catalogue: { agency: { quantity: { kind: "fixed", value: 1 }, stripe: {
      sandbox: { priceId: "price_erasure_restart", productId: "prod_erasure_restart" },
      live: { priceId: "price_live_erasure_restart", productId: "prod_live_erasure_restart" },
    } } },
    checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled", continuationTtlSeconds: 600 },
    authorize: async () => ({ allow: true }),
  } };
  const options = {
    serviceEnv: serverEnv, createStripeCallbackEndpoint,
    createStripeTeamBillingProvider: () => ({
      async quiesceTeamBilling(input) {
        providerCalls.push(input);
        return {
          ok: true, outcome: "quiesced", providerObservedAt: "2026-08-24T10:00:00.000Z",
          checkouts: [{ id: "cs_test_erasure_restart", state: "expired" }],
          subscriptions: [{ id: "sub_erasure_restart", state: "cancelled" }],
        };
      },
    }),
  };
  let first;
  let restarted;
  try {
    first = await openDevDatabase(databasePath, "", serverEnv, {
      name: capsule.name, auth: { providers: { anonymous: true } }, payments,
    }, capsule, options);
    const createdAt = "2026-08-24T10:00:00.000Z";
    await first.adapter.prepare("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('erasure-admin', ?, 'Admin', NULL, NULL, 1, 0, 'test')").run(createdAt);
    await first.adapter.prepare("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Restart erasure', ?, 'erasure-admin')").run(teamId, createdAt);
    await first.adapter.prepare("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)").run(teamId, createdAt);
    await first.adapter.prepare("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_erasure_restart', ?, ?)").run(teamId, createdAt, createdAt);
    await first.adapter.prepare("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('restart-subscription', ?, 'sandbox', 'sub_erasure_restart', 'price_erasure_restart', 'si_erasure_restart', 'agency', 1, 'active', 0, ?, ?, 0)").run(teamId, createdAt, createdAt);
    await first.adapter.prepare("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode]) VALUES ('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888', ?, 'erasure-admin', 'checkout', 'agency', 'ready', 'cs_test_erasure_restart', 'restart-checkout-key', NULL, ?, ?, 'sandbox')").run(teamId, createdAt, createdAt);
    await prepareTeamBillingErasure(first, auth, teamId, requestId);
    const retained = await first.adapter.prepare("SELECT [idempotencyKey] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-erasure'").all();
    assert.equal(retained.length, 1);
    await first.close(); first = null;

    restarted = await openDevDatabase(databasePath, "", serverEnv, {
      name: capsule.name, auth: { providers: { anonymous: true } }, payments,
    }, capsule, options);
    await restarted.init();
    await waitForCount(restarted, "sporades_team_billing_erasure_tombstones", 1);
    const jobs = await restarted.adapter.prepare("SELECT [idempotencyKey] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-erasure'").all();
    assert.equal(jobs.length, 2);
    assert.equal(new Set(jobs.map((row) => row.idempotencyKey)).size, 2);
    assert.equal(providerCalls.length, 1);
  } finally {
    await first?.close();
    await restarted?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForCount(database, table, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const row = await database.adapter.prepare(`SELECT COUNT(*) AS [count] FROM [${table}]`).get();
    if (Number(row.count) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`${table} did not reach ${expected}`);
}

function openFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const statement of [
    "CREATE TABLE [sporades_teams] ([id] TEXT PRIMARY KEY, [name] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_memberships] ([teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_customers] ([teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_subscriptions] ([id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, [providerPriceId] TEXT NOT NULL, [providerSubscriptionItemId] TEXT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, [cancelAtPeriodEnd] INTEGER NOT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [terminalLatch] INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE [sporades_team_billing_operations] ([id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, [kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [mode] TEXT NULL, [quantity] INTEGER NULL, [providerPriceId] TEXT NULL, [providerExpiresAt] INTEGER NULL, [attemptedAt] TEXT NULL, [providerCustomerId] TEXT NULL, [providerSubscriptionId] TEXT NULL, UNIQUE ([teamId], [requestId]))",
    "CREATE TABLE [sporades_team_billing_observations] ([id] TEXT PRIMARY KEY, [teamId] TEXT NULL)",
    "CREATE TABLE [sporades_team_billing_desired_state] ([teamId] TEXT PRIMARY KEY, [intentId] TEXT NOT NULL UNIQUE, [kind] TEXT NOT NULL, [operationId] TEXT NULL, [targetProductKey] TEXT NOT NULL, [targetQuantity] INTEGER NOT NULL, [effectiveAt] INTEGER NOT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, [providerAcknowledgedAt] TEXT NULL, [activeJobGenerationId] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_provider_lanes] ([teamId] TEXT PRIMARY KEY, [claimToken] TEXT NULL, [claimExpiresAt] TEXT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_erasure_state] ([teamId] TEXT PRIMARY KEY, [erasureKey] TEXT NOT NULL UNIQUE, [operationId] TEXT NOT NULL UNIQUE, [activeJobGenerationId] TEXT NOT NULL, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_erasure_tombstones] ([erasureKey] TEXT PRIMARY KEY, [evidenceDigest] TEXT NOT NULL, [providerQuiescedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_erasure_object_tombstones] ([objectKey] TEXT PRIMARY KEY, [kind] TEXT NOT NULL, [terminalState] TEXT NOT NULL, [providerQuiescedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL)",
  ]) sqlite.exec(statement);
  sqlite.prepare("INSERT INTO [sporades_teams] VALUES (?, 'Erasure Team')").run(teamId);
  sqlite.prepare("INSERT INTO [sporades_team_memberships] VALUES (?, 'erasure-admin', 'admin')").run(teamId);
  const now = "2026-08-24T10:00:00.000Z";
  sqlite.prepare("INSERT INTO [sporades_team_billing_customers] VALUES (?, 'sandbox', 'cus_erasure', ?, ?)").run(teamId, now, now);
  sqlite.prepare("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('subscription-row', ?, 'sandbox', 'sub_erasure', 'price_erasure', 'si_erasure', 'agency', 2, 'active', 0, ?, ?, 0)").run(teamId, now, now);
  sqlite.prepare("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode]) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ?, 'erasure-admin', 'checkout', 'agency', 'ready', 'cs_test_erasure', 'checkout-key', NULL, ?, ?, 'sandbox')").run(teamId, now, now);
  const enqueued = [];
  const providerCalls = [];
  const controls = {
    error: null,
    authority: true,
    authorityGate: null,
    providerGate: null,
    instant: now,
    outcome: {
      ok: true, outcome: "quiesced", providerObservedAt: now,
      checkouts: [{ id: "cs_test_erasure", state: "expired" }],
      subscriptions: [{ id: "sub_erasure", state: "cancelled" }],
    },
  };
  const adapter = {
    dialect: { sql: (value) => value },
    prepare: (sql) => sqlite.prepare(sql),
    withTransaction: async (callback) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = await callback(adapter); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const database = {
    adapter,
    capsuleIdentity: "erasure-capsule",
    clock: { now: () => new Date(controls.instant) },
    paymentsConfig: { stripe: { livemode: false } },
    teamBillingDefinition: { catalogue: { agency: {} }, checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" } },
    runTeamBillingAuthority: async () => {
      if (controls.authorityGate) {
        controls.authorityGate.markStarted();
        await controls.authorityGate.promise;
      }
      return { allow: controls.authority };
    },
    readTeamBillingActorAuth: async () => auth,
    enqueueTeamBillingErasureJob: async (_transaction, payload, key, availableAt) => enqueued.push({ payload, key, availableAt }),
    scheduleTeamBillingJobDispatch() {},
    quiesceTeamBillingProvider: async (_context, input) => {
      providerCalls.push(input);
      if (controls.providerGate) {
        controls.providerGate.markStarted();
        await controls.providerGate.promise;
      }
      if (controls.error) throw controls.error;
      return controls.outcome;
    },
  };
  return {
    sqlite, database, enqueued, providerCalls, controls,
    count: (table) => Number(sqlite.prepare(`SELECT COUNT(*) AS [count] FROM [${table}]`).get().count),
  };
}

function inactiveErasureAdmission(error) {
  return error?.code === "TEAM_BILLING_ERASURE_CONTEXT_INACTIVE";
}

function deferred() {
  let resolve;
  let startedResolve;
  const promise = new Promise((accept) => { resolve = accept; });
  const started = new Promise((accept) => { startedResolve = accept; });
  return { promise, started, resolve, markStarted: startedResolve };
}

function testTeamBillingDefinition() {
  return {
    catalogue: { agency: { quantity: { kind: "fixed", value: 1 }, stripe: {
      sandbox: { priceId: "price_erasure_admission", productId: "prod_erasure_admission" },
      live: { priceId: "price_live_erasure_admission", productId: "prod_live_erasure_admission" },
    } } },
    checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled", continuationTtlSeconds: 600 },
    authorize: async () => ({ allow: true }),
  };
}

function testPaymentsConfig() {
  return { stripe: {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://erasure.example.test", callbackPath: "/stripe/webhook",
    apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
  } };
}

async function seedRuntimeErasureTarget(database, exactTeamId, customerId, subscriptionId, checkoutId, createdAt) {
  const second = exactTeamId !== teamId;
  const subscriptionRowId = second ? "33333333-3333-4333-8333-333333333333" : "11111111-1111-4111-8111-111111111111";
  const checkoutOperationId = second ? "44444444-4444-4444-8444-444444444444" : "22222222-2222-4222-8222-222222222222";
  const checkoutRequestId = second ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555";
  await database.adapter.prepare(
    "INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES ('erasure-admin', ?, 'Admin', NULL, NULL, 1, 0, 'test') ON CONFLICT DO NOTHING",
  ).run(createdAt);
  await database.adapter.prepare(
    "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Lane recovery erasure', ?, 'erasure-admin')",
  ).run(exactTeamId, createdAt);
  await database.adapter.prepare(
    "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)",
  ).run(exactTeamId, createdAt);
  await database.adapter.prepare(
    "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', ?, ?, ?)",
  ).run(exactTeamId, customerId, createdAt, createdAt);
  await database.adapter.prepare(
    "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES (?, ?, 'sandbox', ?, 'price_erasure_admission', NULL, 'agency', 1, 'active', 0, ?, ?, 0)",
  ).run(subscriptionRowId, exactTeamId, subscriptionId, createdAt, createdAt);
  await database.adapter.prepare(
    "INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode]) VALUES (?, ?, ?, 'erasure-admin', 'checkout', 'agency', 'ready', ?, ?, NULL, ?, ?, 'sandbox')",
  ).run(checkoutOperationId, checkoutRequestId, exactTeamId, checkoutId, `checkout-${checkoutOperationId}`, createdAt, createdAt);
}
