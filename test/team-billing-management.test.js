import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { createStripeTeamBillingProvider } from "../dist/stripe-team-billing-provider.js";

import {
  createControllableRuntimeClock,
  createPostgresDatabaseAdapter,
  openDevDatabase,
  recoverExpiredJobLeases,
} from "../dist/server-runtime-source.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { hostedInvoiceUrls, unsafeHostedInvoiceUrls } from "./support/team-billing-invoice-urls.js";

const sourceMode = process.execArgv.includes("--experimental-strip-types");
const management = await import(sourceMode
  ? "../src/team-billing-management.ts" : "../dist/team-billing-management.js");

const {
  performTeamBillingPlanTransition,
  performTeamBillingSeatConvergence,
  repairTeamBillingDesiredState,
  requestTeamBillingPlanTransition,
  settleExhaustedTeamBillingManagementJob,
  settleVerifiedTeamBillingTarget,
  stageTeamBillingMembershipChange,
  stageTeamBillingUsageRepair,
  stageAcknowledgedTeamBillingUsageTransitionRepair,
} = management;

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actor = { userId: "admin", isAuthenticated: true, isGuest: false, provider: "test" };

test("same-policy Plan transitions require explicit opt-in and retain source authorization", async () => {
  for (const currency of [undefined, "usd"]) for (const allowSamePolicy of [undefined, false, true]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      fixture.database.teamBillingDefinition.transitions = { allowSamePolicy };
      fixture.database.teamBillingDefinition.catalogue.offered = {
        quantity: { kind: "fixed", value: 1 },
        stripe: { sandbox: { priceId: "price_offered" }, live: { priceId: "price_live_offered" } },
      };
      if (currency) {
        for (const key of ["studio", "offered"]) Object.assign(fixture.database.teamBillingDefinition.catalogue[key].stripe.sandbox,
          { currency: "gbp", unitAmount: 1900, currencyOptions: { usd: { unitAmount: 2900 } } });
        fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [currency] = ?, [unitAmount] = 2900").run(currency);
      }
      const request = () => requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("a"), "offered");
      if (!allowSamePolicy) {
        await assert.rejects(request(), { code: "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED" });
        assert.equal(fixture.desired(), undefined);
      } else {
        assert.equal((await request()).state, "pending");
        await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
        assert.equal(fixture.providerCalls[0].providerSubscriptionId, "sub_test");
        assert.equal(fixture.providerCalls[0].targetPriceId, "price_offered");
        assert.equal(fixture.lastAuthorityInput.fromProductKey, "studio");
        assert.equal(fixture.lastAuthorityInput.currency, currency);
        assert.equal(fixture.operation().currency ?? undefined, currency);
        assert.equal(fixture.providerCalls[0].currency, currency);
      }
    } finally { fixture.close(); }
  }
});

test("Plan transition guards refuse each unsafe state at admission and worker execution", async () => {
  for (const [column, value, code] of [
    ["cancelAtPeriodEnd", 1, "TEAM_BILLING_SUBSCRIPTION_CANCELLING"],
    ["state", "past-due", "TEAM_BILLING_SUBSCRIPTION_PAST_DUE"],
    ["hasSchedule", 1, "TEAM_BILLING_UNKNOWN_SCHEDULE"],
  ]) {
    for (const phase of ["request", "worker"]) {
      const fixture = openFixture({ productKey: "studio", quantity: 1 });
      try {
        if (phase === "worker") await requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("a"), "agency");
        fixture.adapter.prepare(`UPDATE [sporades_team_billing_subscriptions] SET [${column}] = ?`).run(value);
        if (phase === "request") {
          await assert.rejects(requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("a"), "agency"), { code });
          assert.equal(fixture.desired(), undefined);
        } else {
          await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
          assert.equal(fixture.operation().safeFailureCode, code);
          assert.equal(fixture.operation().status, "failed");
        }
        assert.equal(fixture.providerCalls.length, 0);
      } finally { fixture.close(); }
    }
  }
});

test("durable trial policy survives repair and configuration changes until ended evidence settles it", async () => {
  const f = openFixture({ productKey: "studio", quantity: 1 });
  try {
    f.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'trialing'").run();
    f.database.teamBillingDefinition.transitions = { allowSamePolicy: true, endTrial: true };
    await requestTeamBillingPlanTransition(f.database, actor, teamId, randomRequestId("a"), "agency");
    f.database.teamBillingDefinition.transitions.endTrial = false;
    await repairTeamBillingDesiredState(f.database);
    await performTeamBillingPlanTransition(f.database, {}, desiredPayload(f.desired()));
    const first = f.providerCalls[0];
    assert.equal(first.endTrial, true);
    // Even an exact target tuple must remain pending while verified truth is trialing.
    f.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [productKey] = 'agency', [providerPriceId] = 'price_agency', [quantity] = 1").run();
    assert.equal((await settleVerifiedTeamBillingTarget(f.database, { teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_test" })).settled, false);
    assert.equal(f.operation().status, "awaiting-observation");
    await repairTeamBillingDesiredState(f.database);
    await performTeamBillingPlanTransition(f.database, {}, desiredPayload(f.desired()));
    assert.equal(f.providerCalls[1].endTrial, true);
    assert.equal(f.providerCalls[1].idempotencyKey, first.idempotencyKey);
    f.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'active'").run();
    assert.equal((await settleVerifiedTeamBillingTarget(f.database, { teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_test" })).settled, true);
    assert.equal(f.operation().status, "completed");
  } finally { f.close(); }
});

test("revoking same-policy opt-in fences an already queued transition", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    fixture.database.teamBillingDefinition.catalogue.offered = {
      quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_offered" }, live: { priceId: "price_live_offered" } },
    };
    fixture.database.teamBillingDefinition.transitions = { allowSamePolicy: true };
    await requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("a"), "offered");
    fixture.database.teamBillingDefinition.transitions.allowSamePolicy = false;
    await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.operation().safeFailureCode, "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED");
  } finally { fixture.close(); }
});

test("trial evidence retains automatic seat convergence", async () => {
  const fixture = openFixture();
  try {
    fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'trialing'").run();
    fixture.setMembers(3);
    const staged = await stageTeamBillingMembershipChange(fixture.database, teamId);
    assert.equal(staged.staged, true);
    await performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(staged));
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(fixture.providerCalls[0].targetQuantity, 3);
  } finally { fixture.close(); }
});

test("fixed subscriptions without desired work do not require a surviving Team during repair", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    fixture.adapter.prepare("DELETE FROM [sporades_teams] WHERE [id] = ?").run(teamId);
    assert.deepEqual(await repairTeamBillingDesiredState(fixture.database), { queued: 0 });
    assert.equal(fixture.providerCalls.length, 0);
  } finally { fixture.close(); }
});

test("usage drift repair never revives an unacknowledged or denied Plan intent", async () => {
  for (const source of ["studio", "agency"]) {
    const fixture = openFixture({ productKey: source, quantity: source === "studio" ? 1 : 6 });
    try {
      fixture.database.teamBillingDefinition.catalogue.agency.quantity = { kind: "usage", meter: "maxVenues", minimum: 6 };
      fixture.database.runTeamBillingUsage = () => ({ maxVenues: 7 });
      await requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("a"), source === "studio" ? "agency" : "studio");
      const original = fixture.desired();
      const jobs = fixture.enqueued.length;
      for (const status of ["queued", "running", "failed", "attention-required"]) {
        fixture.adapter.prepare("UPDATE [sporades_team_billing_desired_state] SET [status] = ?").run(status);
        const result = source === "studio"
          ? await stageAcknowledgedTeamBillingUsageTransitionRepair(fixture.database, teamId, "agency")
          : await stageTeamBillingUsageRepair(fixture.database, teamId);
        assert.equal(result.staged, false, status);
        assert.equal(fixture.desired().intentId, original.intentId);
        assert.equal(fixture.desired().status, status);
        assert.equal(fixture.enqueued.length, jobs);
      }
    } finally { fixture.close(); }
  }
});

test("rapid Team membership changes supersede stale work while stable retries preserve provider identity", async () => {
  const fixture = openFixture();
  try {
    fixture.setMembers(3);
    const first = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_100);
    const firstDesired = fixture.desired();
    assert.equal(first.staged, true);
    assert.equal(firstDesired.targetQuantity, 3);

    const unchanged = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_999);
    assert.equal(unchanged.intentId, first.intentId);
    assert.equal(fixture.desired().effectiveAt, 1_787_952_100, "unchanged tuple retains its original proration instant");
    assert.equal(fixture.desired().idempotencyKey, firstDesired.idempotencyKey);

    fixture.setMembers(5);
    const latest = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_200);
    assert.notEqual(latest.intentId, first.intentId);
    assert.equal(fixture.desired().targetQuantity, 5);
    assert.deepEqual(await performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(first)), { superseded: true });
    assert.equal(fixture.providerCalls.length, 0, "a stale worker never reaches the provider");

    await performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(latest));
    await performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(latest));
    assert.equal(fixture.providerCalls.length, 2);
    assert.equal(fixture.providerCalls[0].idempotencyKey, fixture.providerCalls[1].idempotencyKey);
    assert.equal(fixture.providerCalls[0].effectiveAt, 1_787_952_200);
    assert.equal(fixture.desired().status, "awaiting-observation", "provider acknowledgement is not settlement");
  } finally { fixture.close(); }
});

test("verified exact evidence alone settles a desired target and provider drift requeues repair", async () => {
  const fixture = openFixture();
  try {
    fixture.setMembers(4);
    const staged = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_300);
    await performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(staged));
    assert.ok(fixture.desired());

    const drift = await settleVerifiedTeamBillingTarget(fixture.database, {
      teamId, productKey: "agency", quantity: 2, subscriptionId: "sub_test", occurredAt: "2026-08-23T12:05:00.000Z",
    });
    assert.deepEqual(drift, { settled: false, repairRequired: true });
    assert.equal(fixture.desired().status, "queued");
    assert.equal(fixture.desired().safeFailureCode, "PROVIDER_DRIFT");

    const settled = await settleVerifiedTeamBillingTarget(fixture.database, {
      teamId, productKey: "agency", quantity: 4, subscriptionId: "sub_test", occurredAt: "2026-08-23T12:06:00.000Z",
    });
    assert.deepEqual(settled, { settled: true });
    assert.equal(fixture.desired(), undefined);
  } finally { fixture.close(); }
});

test("managed fixed-to-Team transition rechecks live admin authority and exact quantity before provider I/O", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    fixture.setMembers(6);
    const requested = await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "agency",
    );
    const desired = fixture.desired();
    assert.equal(requested.state, "pending");
    assert.equal("intentId" in requested, false, "runtime intent identity stays out of the public result");
    assert.equal(desired.targetQuantity, 6);

    fixture.setRole("member");
    await assert.rejects(
      performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(desired)),
      (error) => error?.code === "TEAM_BILLING_DENIED",
    );
    assert.equal(fixture.providerCalls.length, 0);
    assert.equal(fixture.desired().status, "attention-required");

    fixture.setRole("admin");
    fixture.authority = false;
    const second = await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "agency",
    ).catch((error) => error);
    assert.equal(second.code, "TEAM_BILLING_DENIED", "the request seam also admits current authority");
  } finally { fixture.close(); }
});

test("background Plan transition rejects unlinked or guest actor reconstruction", async () => {
  for (const workerAuth of [
    { ...actor, isAuthenticated: false },
    { ...actor, isGuest: true },
  ]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      fixture.setMembers(2);
      await requestTeamBillingPlanTransition(
        fixture.database, actor, teamId, randomRequestId(workerAuth.isGuest ? "a" : "b"), "agency",
      );
      fixture.workerAuth = workerAuth;
      await assert.rejects(
        performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())),
        (error) => error?.code === "TEAM_BILLING_DENIED",
      );
      assert.equal(fixture.providerCalls.length, 0);
      assert.equal(fixture.desired().safeFailureCode, "AUTHORITY_CHANGED");
    } finally { fixture.close(); }
  }
});

test("rapid same-target Plan requests transfer desired ownership to the latest public operation", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  const newerActor = { ...actor, userId: "new-admin" };
  try {
    fixture.adapter.prepare("INSERT INTO [sporades_team_memberships] VALUES (?, 'new-admin', 'admin')").run(teamId);
    await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "11111111-1111-4111-8111-111111111111", "agency",
    );
    const firstDesired = fixture.desired();
    const firstOperation = fixture.operationForRequest("11111111-1111-4111-8111-111111111111");

    await requestTeamBillingPlanTransition(
      fixture.database, newerActor, teamId, "22222222-2222-4222-8222-222222222222", "agency",
    );
    const latestDesired = fixture.desired();
    const latestOperation = fixture.operationForRequest("22222222-2222-4222-8222-222222222222");
    assert.equal(latestDesired.intentId, firstDesired.intentId, "same target retains provider intent identity");
    assert.equal(latestDesired.idempotencyKey, firstDesired.idempotencyKey);
    assert.equal(latestDesired.effectiveAt, firstDesired.effectiveAt);
    assert.equal(latestDesired.operationId, latestOperation.id, "latest request owns settlement and worker authority");
    assert.notEqual(latestDesired.operationId, firstOperation.id);
    assert.equal(fixture.operationForRequest("11111111-1111-4111-8111-111111111111").status, "superseded");

    fixture.workerAuthByUserId = {
      [actor.userId]: { ...actor, isAuthenticated: false },
      [newerActor.userId]: newerActor,
    };
    assert.deepEqual(await performTeamBillingPlanTransition(
      fixture.database, {}, desiredPayload(latestDesired),
    ), { providerAcknowledged: true });
    assert.equal(fixture.lastAuthorityActor, newerActor.userId);
    fixture.adapter.prepare(
      "UPDATE [sporades_team_billing_subscriptions] SET [providerPriceId] = 'price_agency', [productKey] = 'agency', [quantity] = 2",
    ).run();
    assert.deepEqual(await settleVerifiedTeamBillingTarget(fixture.database, {
      teamId, productKey: "agency", quantity: 2, subscriptionId: "sub_test", occurredAt: "2026-08-23T12:20:00.000Z",
    }), { settled: true });
    assert.equal(fixture.operationForRequest("22222222-2222-4222-8222-222222222222").status, "completed");
    assert.equal(fixture.operationForRequest("11111111-1111-4111-8111-111111111111").status, "superseded");
  } finally { fixture.close(); }
});

test("provider acknowledgement accepts only the exact closed result union", async () => {
  for (const invalid of [
    undefined,
    null,
    { ok: true, outcome: "acknowledged", providerId: "must-not-cross" },
    { ok: true, outcome: "unknown" },
    { outcome: "acknowledged" },
    { ok: false, outcome: "acknowledged" },
  ]) {
    const fixture = openFixture();
    try {
      fixture.setMembers(3);
      const staged = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_100);
      fixture.providerOutcome = invalid;
      await assert.rejects(
        performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(staged)),
        (error) => error?.code === "TEAM_BILLING_PROVIDER_REJECTED",
      );
      assert.equal(fixture.desired().status, "failed");
      assert.equal(fixture.desired().providerAcknowledgedAt, null);
    } finally { fixture.close(); }
  }
});

test("a newer exact member count supersedes a plan worker before Price and quantity are updated together", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    fixture.setMembers(2);
    const requested = await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "agency",
    );
    fixture.setMembers(3);
    const firstDesired = fixture.desired();
    assert.deepEqual(await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_210),
      { staged: false }, "membership staging cannot overwrite an active Plan transition");
    assert.equal(fixture.desired().intentId, firstDesired.intentId);
    assert.deepEqual(await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(firstDesired)), { superseded: true });
    assert.equal(fixture.providerCalls.length, 0);
    const desired = fixture.desired();
    assert.equal(desired.targetQuantity, 3);
    await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(desired));
    assert.deepEqual(fixture.providerCalls[0], {
      teamId, mode: "sandbox", providerCustomerId: "cus_test", providerSubscriptionId: "sub_test", providerSubscriptionItemId: "si_test",
      sourcePriceId: "price_studio", targetPriceId: "price_agency", targetProductKey: "agency", targetQuantity: 3,
      effectiveAt: desired.effectiveAt, prorationDate: desired.effectiveAt, idempotencyKey: desired.idempotencyKey,
      operationKind: "plan-transition", resume: false,
    });
  } finally { fixture.close(); }
});

test("resume intent survives a newer member or usage count before the plan worker runs", async () => {
  for (const [quantityKind, trial] of [["team-members", false], ["usage", false], ["team-members", true], ["usage", true]]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      let usage = 2;
      if (trial) {
        fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'trialing'").run();
        fixture.database.teamBillingDefinition.transitions = { endTrial: true };
      }
      if (quantityKind === "usage") {
        fixture.database.teamBillingDefinition.catalogue.agency.quantity = { kind: "usage", meter: "venues" };
        fixture.database.runTeamBillingUsage = () => ({ venues: usage });
      }
      fixture.setMembers(2);
      fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [cancelAtPeriodEnd] = 1").run();
      const requestId = randomRequestId("b");
      await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency", undefined, true);
      const original = fixture.desired();
      fixture.setMembers(3);
      usage = 3;
      await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(original));
      assert.equal(fixture.providerCalls.length, 0);
      await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
      assert.equal(fixture.providerCalls.length, 1);
      assert.equal(fixture.providerCalls[0].resume, true);
      assert.equal(fixture.providerCalls[0].endTrial, trial ? true : undefined);
      assert.equal(fixture.providerCalls[0].targetQuantity, 3);
      assert.equal(fixture.operationForRequest(requestId).status, "awaiting-observation");
    } finally { fixture.close(); }
  }
});

test("usage repair preserves the acknowledged plan's resume intent", async () => {
  for (const repair of ["count", "acknowledged", "observation"]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      fixture.database.teamBillingDefinition.catalogue.agency.quantity = { kind: "usage", meter: "venues" };
      fixture.database.runTeamBillingUsage = () => ({ venues: 2 });
      fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [state] = 'trialing'").run();
      fixture.database.teamBillingDefinition.transitions = { endTrial: true };
      fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [cancelAtPeriodEnd] = 1").run();
      await requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("b"), "agency", undefined, true);
      await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
      fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [productKey] = 'agency', [providerPriceId] = 'price_agency'").run();
      const original = fixture.desired();
      if (repair === "count") await stageTeamBillingUsageRepair(fixture.database, teamId);
      else if (repair === "acknowledged") await stageAcknowledgedTeamBillingUsageTransitionRepair(fixture.database, teamId, "agency");
      else await settleVerifiedTeamBillingTarget(fixture.database, { teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_test" });
      assert.notEqual(fixture.desired().intentId, original.intentId);
      await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
      assert.equal(fixture.providerCalls.length, 2);
      assert.equal(fixture.providerCalls[1].resume, true);
      assert.equal(fixture.providerCalls[1].endTrial, true);
    } finally { fixture.close(); }
  }
});

test("payment action required fails safely and verified Plan evidence stages latest Team seats", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    fixture.setMembers(2);
    await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "agency",
    );
    const desired = fixture.desired();
    fixture.providerOutcome = { ok: true, outcome: "payment-action-required" };
    assert.deepEqual(await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(desired)),
      { failed: true, safeFailureCode: "PAYMENT_ACTION_REQUIRED" });
    assert.equal(fixture.desired().status, "failed");
    assert.equal(fixture.operation().status, "failed");

    fixture.providerOutcome = { ok: true, outcome: "acknowledged" };
    await repairTeamBillingDesiredState(fixture.database);
    await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
    fixture.setMembers(4);
    fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [productKey] = 'agency', [providerPriceId] = 'price_agency', [quantity] = 2").run();
    assert.deepEqual(await settleVerifiedTeamBillingTarget(fixture.database, {
      teamId, productKey: "agency", quantity: 2, subscriptionId: "sub_test", occurredAt: "2026-08-23T12:10:00.000Z",
    }), { settled: true, repairRequired: true });
    assert.equal(fixture.desired().kind, "seat-convergence");
    assert.equal(fixture.desired().targetQuantity, 4);
    assert.equal(fixture.operation().status, "completed");
  } finally { fixture.close(); }
});

test("a payment-action capability is stored on the operation and returned while unexpired", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
    const action = { url: hostedInvoiceUrls[0], expiresAt: "2026-08-23T13:00:00.000Z" };
    fixture.providerOutcome = { ok: true, outcome: "payment-action-required", paymentAction: action };
    await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
    const operation = fixture.operationForRequest(requestId);
    assert.equal(operation.status, "failed");
    assert.equal(operation.safeFailureCode, "PAYMENT_ACTION_REQUIRED");
    assert.equal(operation.paymentActionUrl, action.url);
    assert.equal(operation.paymentActionExpiresAt, action.expiresAt);
    assert.deepEqual(await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency"), {
      state: "failed", teamId, requestId, productKey: "agency", reason: "payment-action-required", paymentAction: action,
    });

    fixture.providerOutcome = { ok: true, outcome: "payment-action-required", paymentAction: { ...action, url: "https://pay.example.test/i/hosted" } };
    await repairTeamBillingDesiredState(fixture.database);
    await assert.rejects(performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())),
      (error) => error?.code === "TEAM_BILLING_PROVIDER_REJECTED");
    assert.equal(fixture.desired().status, "failed");
    assert.equal(fixture.desired().safeFailureCode, "TEAM_BILLING_PROVIDER_REJECTED");

    fixture.providerOutcome = { ok: true, outcome: "acknowledged", paymentAction: action };
    await repairTeamBillingDesiredState(fixture.database);
    await assert.rejects(performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())),
      (error) => error?.code === "TEAM_BILLING_PROVIDER_REJECTED");
  } finally { fixture.close(); }
});

test("the management seam rejects unsafe hosted-invoice URLs before storage and on read", async () => {
  for (const url of unsafeHostedInvoiceUrls) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      const requestId = randomRequestId("d");
      await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
      const action = { url, expiresAt: "2026-08-23T13:00:00.000Z" };
      fixture.providerOutcome = { ok: true, outcome: "payment-action-required", paymentAction: action };
      await assert.rejects(performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())), { code: "TEAM_BILLING_PROVIDER_REJECTED" });
      assert.equal(fixture.operation().paymentActionUrl, null);
      // Retained state must pass the same boundary before reaching the browser.
      fixture.adapter.prepare("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = 'PAYMENT_ACTION_REQUIRED', [paymentActionUrl] = ?, [paymentActionExpiresAt] = ?").run(url, action.expiresAt);
      const result = await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
      assert.equal(result.paymentAction, undefined);
    } finally { fixture.close(); }
  }
});

test("noncanonical payment-action expiry is rejected before storage and on read", async () => {
  for (const expiresAt of ["Thu, 01 Jan 1970 00:00:00 GMT", "2026-08-23T13:00:00Z", "+010000-01-01T00:00:00.000Z", "invalid"]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      const requestId = randomRequestId("d");
      await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
      const action = { url: hostedInvoiceUrls[0], expiresAt };
      fixture.providerOutcome = { ok: true, outcome: "payment-action-required", paymentAction: action };
      await assert.rejects(performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())), { code: "TEAM_BILLING_PROVIDER_REJECTED" });
      assert.equal(fixture.operation().paymentActionExpiresAt, null);
      fixture.adapter.prepare("UPDATE [sporades_team_billing_operations] SET [status] = 'failed', [safeFailureCode] = 'PAYMENT_ACTION_REQUIRED', [paymentActionUrl] = ?, [paymentActionExpiresAt] = ?").run(action.url, expiresAt);
      const result = await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
      assert.equal(result.paymentAction, undefined);
    } finally { fixture.close(); }
  }
});

test("an expired payment-action capability is never returned", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  try {
    const requestId = "dddddddd-eeee-4eee-8eee-eeeeeeeeeeee";
    await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency");
    fixture.providerOutcome = {
      ok: true, outcome: "payment-action-required",
      paymentAction: { url: "https://invoice.stripe.com/i/in_expired", expiresAt: "2026-08-23T11:00:00.000Z" },
    };
    await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
    assert.deepEqual(await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency"), {
      state: "failed", teamId, requestId, productKey: "agency", reason: "payment-action-required",
    });
  } finally { fixture.close(); }
});

test("resume stages a cancelling Subscription and clears its cancellation inside one provider update", async () => {
  for (const [resume, cancelling] of [[undefined, true], [true, true], [true, false]]) {
    const fixture = openFixture({ productKey: "studio", quantity: 1 });
    try {
      if (cancelling) fixture.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [cancelAtPeriodEnd] = 1").run();
      const requestId = randomRequestId("c");
      if (resume !== true) {
        await assert.rejects(requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency"),
          { code: "TEAM_BILLING_SUBSCRIPTION_CANCELLING" });
        assert.equal(fixture.desired(), undefined);
        continue;
      }
      assert.equal((await requestTeamBillingPlanTransition(fixture.database, actor, teamId, requestId, "agency", undefined, true)).state, "pending");
      assert.equal(fixture.desired().resume, 1);
      await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
      assert.equal(fixture.providerCalls[0].resume, true);
      assert.equal(fixture.operationForRequest(requestId).status, "awaiting-observation");
      assert.equal(fixture.providerCalls.length, 1);
    } finally { fixture.close(); }
  }
});

test("resume does not lift the past-due or schedule refusals", async () => {
  for (const [column, value, code] of [
    ["state", "past-due", "TEAM_BILLING_SUBSCRIPTION_PAST_DUE"],
    ["hasSchedule", 1, "TEAM_BILLING_UNKNOWN_SCHEDULE"],
  ]) {
    for (const cancelling of [0, 1]) {
      for (const phase of ["request", "worker"]) {
        const fixture = openFixture({ productKey: "studio", quantity: 1 });
        try {
          if (phase === "worker") await requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("e"), "agency", undefined, true);
          fixture.adapter.prepare(`UPDATE [sporades_team_billing_subscriptions] SET [${column}] = ?, [cancelAtPeriodEnd] = ?`).run(value, cancelling);
          if (phase === "request") {
            await assert.rejects(requestTeamBillingPlanTransition(fixture.database, actor, teamId, randomRequestId("e"), "agency", undefined, true), { code });
            assert.equal(fixture.desired(), undefined);
          } else {
            await performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired()));
            assert.equal(fixture.operation().safeFailureCode, code);
            assert.equal(fixture.operation().status, "failed");
          }
          assert.equal(fixture.providerCalls.length, 0);
        } finally { fixture.close(); }
      }
    }
  }
});

test("provider outage, retry exhaustion, and startup repair retain the same desired tuple", async () => {
  const fixture = openFixture();
  try {
    fixture.setMembers(7);
    const staged = await stageTeamBillingMembershipChange(fixture.database, teamId, 1_787_952_500);
    fixture.providerError = Object.assign(new Error("provider unavailable"), { retryable: true, code: "PROVIDER_UNAVAILABLE" });
    await assert.rejects(performTeamBillingSeatConvergence(fixture.database, {}, generationPayload(staged)), (error) => error.retryable === true);
    assert.equal(fixture.desired().status, "queued");
    const before = fixture.desired();

    await settleExhaustedTeamBillingManagementJob(fixture.database, generationPayload(staged), "PROVIDER_UNAVAILABLE");
    assert.equal(fixture.desired().status, "failed");
    const repaired = await repairTeamBillingDesiredState(fixture.database);
    assert.deepEqual(repaired, { queued: 1 });
    assert.equal(fixture.desired().intentId, before.intentId);
    assert.equal(fixture.desired().idempotencyKey, before.idempotencyKey);
    assert.equal(fixture.desired().effectiveAt, before.effectiveAt);

    fixture.providerError = null;
    await performTeamBillingSeatConvergence(fixture.database, {}, desiredPayload(fixture.desired()));
    assert.equal(fixture.desired().status, "awaiting-observation");
  } finally { fixture.close(); }
});

test("startup repair discovers accepted Agency quantity drift without needing a prior membership Job", async () => {
  const fixture = openFixture();
  try {
    fixture.setMembers(9);
    assert.equal(fixture.desired(), undefined);
    assert.deepEqual(await repairTeamBillingDesiredState(fixture.database), { queued: 1 });
    assert.equal(fixture.desired().kind, "seat-convergence");
    assert.equal(fixture.desired().targetQuantity, 9);
  } finally { fixture.close(); }
});

test("member-derived management targets honor a floor below it and exact membership above it", async () => {
  const membership = openFixture({ minimum: 5, quantity: 2 });
  try {
    membership.setMembers(1);
    await stageTeamBillingMembershipChange(membership.database, teamId, 1_787_952_100);
    assert.equal(membership.desired().targetQuantity, 5);
    membership.setMembers(6);
    await stageTeamBillingMembershipChange(membership.database, teamId, 1_787_952_200);
    assert.equal(membership.desired().targetQuantity, 6);
  } finally { membership.close(); }

  for (const memberCount of [1, 6]) {
    const transition = openFixture({ productKey: "studio", quantity: 1, minimum: 5 });
    try {
      transition.setMembers(memberCount);
      await requestTeamBillingPlanTransition(
        transition.database, actor, teamId, memberCount === 1
          ? "11111111-1111-4111-8111-111111111111"
          : "66666666-6666-4666-8666-666666666666", "agency",
      );
      assert.equal(transition.desired().targetQuantity, memberCount === 1 ? 5 : 6);
    } finally { transition.close(); }
  }

  for (const memberCount of [1, 6]) {
    const expectedQuantity = memberCount === 1 ? 5 : 6;
    const active = openFixture({ minimum: 5, quantity: 2 });
    try {
      active.setMembers(memberCount);
      const staged = await stageTeamBillingMembershipChange(active.database, teamId, 1_787_952_300 + memberCount);
      active.adapter.prepare(
        "UPDATE [sporades_team_billing_desired_state] SET [targetQuantity] = 1 WHERE [teamId] = ?",
      ).run(teamId);
      assert.deepEqual(await performTeamBillingSeatConvergence(active.database, {}, generationPayload(staged)), {
        superseded: true,
      });
      assert.equal(active.desired().targetQuantity, expectedQuantity);
    } finally { active.close(); }

    const settled = openFixture({ minimum: 5, quantity: 2 });
    try {
      settled.setMembers(memberCount);
      await stageTeamBillingMembershipChange(settled.database, teamId, 1_787_952_400 + memberCount);
      settled.adapter.prepare(
        "UPDATE [sporades_team_billing_subscriptions] SET [quantity] = ? WHERE [teamId] = ?",
      ).run(expectedQuantity, teamId);
      assert.deepEqual(await settleVerifiedTeamBillingTarget(settled.database, {
        teamId, productKey: "agency", quantity: expectedQuantity, subscriptionId: "sub_test", occurredAt: "2026-08-23T12:10:00.000Z",
      }), { settled: true });
      assert.equal(settled.desired(), undefined);
    } finally { settled.close(); }

    const repair = openFixture({ minimum: 5, quantity: 2 });
    try {
      repair.setMembers(memberCount);
      assert.deepEqual(await repairTeamBillingDesiredState(repair.database), { queued: 1 });
      assert.equal(repair.desired().targetQuantity, expectedQuantity);
    } finally { repair.close(); }
  }
});

test("plan transitions distinguish team-member policies that differ only by minimum", async () => {
  const fixture = openFixture({ minimum: 5, quantity: 5, agencyProMinimum: 7 });
  try {
    fixture.setMembers(1);
    await requestTeamBillingPlanTransition(
      fixture.database, actor, teamId, "77777777-7777-4777-8777-777777777777", "agency-pro",
    );
    assert.equal(fixture.desired().targetProductKey, "agency-pro");
    assert.equal(fixture.desired().targetQuantity, 7);
  } finally { fixture.close(); }
});

test("real runtime Job repair uses fresh queue generations while provider idempotency stays stable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-repair-jobs-"));
  const databasePath = path.join(dir, "data.db");
  const providerCalls = [];
  const serverEnv = { STRIPE_SECRET_KEY: "sk_test_management_repair", STRIPE_WEBHOOK_SECRET: "whsec_management_repair" };
  const payments = { stripe: {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://repair.example.test", callbackPath: "/stripe/webhook",
    apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 10_000,
  } };
  const capsule = { name: "team-billing-repair-jobs", schema: {}, teamBilling: {
    catalogue: { agency: { quantity: { kind: "team-members" }, stripe: {
      sandbox: { priceId: "price_repair_agency", productId: "prod_repair_agency" },
      live: { priceId: "price_live_repair_agency", productId: "prod_live_repair_agency" },
    } } },
    authorize: async () => ({ allow: true }),
  } };
  const database = await openDevDatabase(databasePath, "", serverEnv, {
    name: capsule.name, auth: { providers: { anonymous: true } }, payments,
  }, capsule, {
    serviceEnv: serverEnv,
    createStripeCallbackEndpoint,
    createStripeTeamBillingProvider: () => ({
      async updateManagedSubscription(input) {
        providerCalls.push(input);
        return { ok: true, outcome: "acknowledged" };
      },
    }),
  });
  try {
    const now = new Date().toISOString();
    await database.adapter.prepare(
      "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Repair Team', ?, 'repair-admin')",
    ).run(teamId, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'repair-admin', 'admin', ?), (?, 'repair-member', 'member', ?)",
    ).run(teamId, now, teamId, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_repair', ?, ?)",
    ).run(teamId, now, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('repair-subscription', ?, 'sandbox', 'sub_repair', 'price_repair_agency', 'si_repair', 'agency', 1, 'active', 0, ?, ?, 0)",
    ).run(teamId, now, now);

    const staged = await stageTeamBillingMembershipChange(database, teamId, 1_787_952_100);
    assert.equal(staged.staged, true);
    assert.equal(Number((await database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-seat-convergence'",
    ).get()).count), 1);
    await database.init();
    await waitForDesiredStatus(database, teamId, "awaiting-observation");
    const afterRestartRepair = await database.adapter.prepare(
      "SELECT [idempotencyKey] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-seat-convergence' ORDER BY [createdAt], [id]",
    ).all();
    assert.equal(afterRestartRepair.length, 2, "startup repair adds a new Job generation instead of colliding with retained work");
    assert.equal(new Set(afterRestartRepair.map((row) => row.idempotencyKey)).size, 2);
    assert.ok(providerCalls.length >= 1);
    assert.equal(new Set(providerCalls.map((input) => input.idempotencyKey)).size, 1, "all Job generations retain one provider intent identity");

    const beforeDriftJobs = afterRestartRepair.length;
    assert.deepEqual(await settleVerifiedTeamBillingTarget(database, {
      teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_repair", occurredAt: new Date().toISOString(),
    }), { settled: false, repairRequired: true });
    await waitForJobCount(database, "_sporades.team-billing-seat-convergence", beforeDriftJobs + 1);
    const driftJobs = await database.adapter.prepare(
      "SELECT [idempotencyKey] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-seat-convergence'",
    ).all();
    assert.equal(new Set(driftJobs.map((row) => row.idempotencyKey)).size, driftJobs.length,
      "provider-drift repair also owns a fresh durable Job identity");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("crashed provider lane converges after TTL from normal exhaustion and lease recovery without restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-billing-crashed-lane-"));
  const databasePath = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2026-08-23T12:00:00.000Z");
  const providerCalls = [];
  const serverEnv = { STRIPE_SECRET_KEY: "sk_test_crashed_lane", STRIPE_WEBHOOK_SECRET: "whsec_crashed_lane" };
  const payments = { stripe: {
    enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    publicOrigin: "https://crashed-lane.example.test", callbackPath: "/stripe/webhook",
    apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 10_000,
  } };
  const capsule = { name: "team-billing-crashed-lane", schema: {}, teamBilling: {
    catalogue: { agency: { quantity: { kind: "team-members" }, stripe: {
      sandbox: { priceId: "price_crashed_lane", productId: "prod_crashed_lane" },
      live: { priceId: "price_live_crashed_lane", productId: "prod_live_crashed_lane" },
    } } },
    authorize: async () => ({ allow: true }),
  } };
  const database = await openDevDatabase(databasePath, "", serverEnv, {
    name: capsule.name, auth: { providers: { anonymous: true } }, payments,
  }, capsule, {
    clock, serviceEnv: serverEnv, createStripeCallbackEndpoint,
    createStripeTeamBillingProvider: () => ({
      async updateManagedSubscription(input) {
        providerCalls.push(input);
        return { ok: true, outcome: "acknowledged" };
      },
    }),
  });
  try {
    const now = clock.now().toISOString();
    const claimExpiresAt = new Date(clock.now().getTime() + 5 * 60_000).toISOString();
    await database.adapter.prepare(
      "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Crashed lane', ?, 'crashed-admin')",
    ).run(teamId, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'crashed-admin', 'admin', ?), (?, 'crashed-member', 'member', ?)",
    ).run(teamId, now, teamId, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_crashed_lane', ?, ?)",
    ).run(teamId, now, now);
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('crashed-lane-subscription', ?, 'sandbox', 'sub_crashed_lane', 'price_crashed_lane', 'si_crashed_lane', 'agency', 1, 'active', 0, ?, ?, 0)",
    ).run(teamId, now, now);
    await stageTeamBillingMembershipChange(database, teamId, Math.floor(clock.now().getTime() / 1_000));
    await database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [status] = 'failed', [failedAt] = ?, [failure] = '{}' WHERE [handler] = '_sporades.team-billing-seat-convergence'",
    ).run(now);
    await database.adapter.prepare(
      "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = 'crashed-owner', [claimExpiresAt] = ?, [updatedAt] = ? WHERE [teamId] = ?",
    ).run(claimExpiresAt, now, teamId);

    await database.init();
    await clock.runDueTimers();
    clock.advanceBy(60_001);
    await clock.runDueTimers();
    clock.advanceBy(60_001);
    await clock.runDueTimers();

    const replacement = await database.adapter.prepare(
      "SELECT [status], [availableAt], [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-seat-convergence' ORDER BY [createdAt] DESC, [id] DESC LIMIT 1",
    ).get();
    assert.equal(replacement.status, "delayed", "busy exhaustion durably retains executable work");
    assert.equal(replacement.availableAt, claimExpiresAt, "replacement cannot run before the crashed claim expires");
    assert.equal(providerCalls.length, 0);

    clock.setInstant(new Date(Date.parse(claimExpiresAt) - 1));
    await clock.runDueTimers();
    assert.equal(providerCalls.length, 0, "replacement does not hot-loop or overlap before expiry");
    clock.advanceBy(2);
    await clock.runDueTimers();
    assert.equal(providerCalls.length, 1, "provider convergence resumes at expiry without another restart");
    assert.equal((await database.adapter.prepare(
      "SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
    ).get(teamId)).status, "awaiting-observation");

    await database.adapter.prepare(
      "UPDATE [sporades_team_billing_subscriptions] SET [quantity] = 2 WHERE [teamId] = ?",
    ).run(teamId);
    assert.deepEqual(await settleVerifiedTeamBillingTarget(database, {
      teamId, productKey: "agency", quantity: 2, subscriptionId: "sub_crashed_lane", occurredAt: clock.now().toISOString(),
    }), { settled: true });
    await database.adapter.prepare(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'crashed-late-member', 'member', ?)",
    ).run(teamId, clock.now().toISOString());
    const leaseStaged = await stageTeamBillingMembershipChange(database, teamId, Math.floor(clock.now().getTime() / 1_000));
    const leaseExpiry = new Date(clock.now().getTime() - 1).toISOString();
    const providerLaneExpiry = new Date(clock.now().getTime() + 5 * 60_000).toISOString();
    await database.adapter.prepare(
      "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = 3, [leaseExpiresAt] = ?, [claimToken] = 'crashed-job-claim' WHERE [handler] = '_sporades.team-billing-seat-convergence' AND [payload] = ?",
    ).run(leaseExpiry, JSON.stringify(generationPayload(leaseStaged)));
    await database.adapter.prepare(
      "UPDATE [sporades_team_billing_provider_lanes] SET [claimToken] = 'second-crashed-owner', [claimExpiresAt] = ?, [updatedAt] = ? WHERE [teamId] = ?",
    ).run(providerLaneExpiry, clock.now().toISOString(), teamId);

    await recoverExpiredJobLeases(database);
    const leaseReplacement = await database.adapter.prepare(
      "SELECT [status], [availableAt], [payload] FROM [sporades_jobs] WHERE [handler] = '_sporades.team-billing-seat-convergence' AND [availableAt] = ?",
    ).get(providerLaneExpiry);
    assert.equal(leaseReplacement.status, "delayed", "lease recovery atomically retains a successor generation");
    assert.equal(leaseReplacement.availableAt, providerLaneExpiry);
    assert.notDeepEqual(JSON.parse(leaseReplacement.payload), generationPayload(leaseStaged));
    assert.equal(providerCalls.length, 1);

    clock.setInstant(new Date(Date.parse(providerLaneExpiry) + 1));
    await clock.runDueTimers();
    assert.equal(providerCalls.length, 2, "lease recovery successor converges without a restart");
    assert.equal((await database.adapter.prepare(
      "SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
    ).get(teamId)).status, "awaiting-observation");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two PostgreSQL runtimes serialize one Team provider lane while newer membership intent supersedes stale work", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (firstAdapter) => {
    await firstAdapter.ensureTeamsStorage();
    await firstAdapter.ensureTeamBillingStorage();
    const secondAdapter = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    let releaseFirstProvider;
    let markFirstProviderStarted;
    const firstProviderStarted = new Promise((resolve) => { markFirstProviderStarted = resolve; });
    const firstProviderRelease = new Promise((resolve) => { releaseFirstProvider = resolve; });
    const providerCalls = [];
    try {
      const now = "2026-08-23T12:00:00.000Z";
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Provider lane', ?, 'lane-admin')",
      )).run(teamId, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'lane-admin', 'admin', ?), (?, 'lane-member', 'member', ?)",
      )).run(teamId, now, teamId, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_lane', ?, ?)",
      )).run(teamId, now, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('lane-subscription', ?, 'sandbox', 'sub_lane', 'price_agency', 'si_lane', 'agency', 1, 'active', 0, ?, ?, 0)",
      )).run(teamId, now, now);
      const definition = { catalogue: {
        agency: { quantity: { kind: "team-members" }, stripe: {
          sandbox: { priceId: "price_agency", productId: "prod_agency" },
          live: { priceId: "price_live_agency", productId: "prod_live_agency" },
        } },
      } };
      const makeDatabase = (adapter, runtimeName) => ({
        adapter, capsuleIdentity: "postgres-provider-lane", teamBillingDefinition: definition,
        paymentsConfig: { stripe: { livemode: false } }, clock: { now: () => new Date() },
        enqueueTeamBillingSeatConvergenceJob: async () => {}, scheduleTeamBillingJobDispatch() {},
        updateTeamBillingSubscription: async (_context, input) => {
          providerCalls.push({ runtimeName, ...input });
          if (providerCalls.length === 1) {
            markFirstProviderStarted();
            await firstProviderRelease;
          }
          return { ok: true, outcome: "acknowledged" };
        },
      });
      const first = makeDatabase(firstAdapter, "first");
      const second = makeDatabase(secondAdapter, "second");
      const initial = await stageTeamBillingMembershipChange(first, teamId, 1_787_952_100);
      const staleWorker = performTeamBillingSeatConvergence(first, {}, generationPayload(initial));
      await firstProviderStarted;

      await secondAdapter.prepare(secondAdapter.dialect.sql(
        "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'lane-late-member', 'member', ?)",
      )).run(teamId, now);
      assert.equal(Number((await firstAdapter.prepare(firstAdapter.dialect.sql(
        "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?",
      )).get(teamId)).count), 3, "membership commits while the first runtime waits on the provider");
      const latest = await stageTeamBillingMembershipChange(second, teamId, 1_787_952_200);
      assert.notEqual(latest.intentId, initial.intentId);
      await assert.rejects(
        performTeamBillingSeatConvergence(second, {}, generationPayload(latest)),
        (error) => error?.code === "TEAM_BILLING_PROVIDER_LANE_BUSY" && error?.retryable === true,
      );
      assert.equal(providerCalls.length, 1, "the competing runtime never overlaps provider I/O for the Team");

      releaseFirstProvider();
      assert.deepEqual(await staleWorker, { superseded: true });
      const retained = await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [intentId], [targetQuantity], [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
      )).get(teamId);
      assert.deepEqual({ ...retained }, { intentId: latest.intentId, targetQuantity: 3, status: "queued" });
      assert.deepEqual(await performTeamBillingSeatConvergence(second, {}, generationPayload(latest)), { providerAcknowledged: true });
      assert.deepEqual(providerCalls.map(({ runtimeName, targetQuantity }) => ({ runtimeName, targetQuantity })), [
        { runtimeName: "first", targetQuantity: 2 }, { runtimeName: "second", targetQuantity: 3 },
      ]);
      await secondAdapter.prepare(secondAdapter.dialect.sql(
        "UPDATE [sporades_team_billing_subscriptions] SET [quantity] = 3 WHERE [teamId] = ?",
      )).run(teamId);
      assert.deepEqual(await settleVerifiedTeamBillingTarget(second, {
        teamId, productKey: "agency", quantity: 3, subscriptionId: "sub_lane", occurredAt: new Date().toISOString(),
      }), { settled: true });
      assert.equal((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [intentId] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
      )).get(teamId)) ?? null, null);
    } finally {
      releaseFirstProvider?.();
      await secondAdapter.close();
    }
  });
});

test("stale Job generation exhaustion cannot release or fail a shared live provider intent", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async (firstAdapter) => {
    await firstAdapter.ensureTeamsStorage();
    await firstAdapter.ensureTeamBillingStorage();
    const secondAdapter = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    let releaseProvider;
    let markProviderStarted;
    const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
    const providerRelease = new Promise((resolve) => { releaseProvider = resolve; });
    const enqueued = [];
    try {
      const now = "2026-08-23T12:00:00.000Z";
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Generation lane', ?, 'generation-admin')",
      )).run(teamId, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'generation-admin', 'admin', ?), (?, 'generation-member', 'member', ?)",
      )).run(teamId, now, teamId, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_generation', ?, ?)",
      )).run(teamId, now, now);
      await firstAdapter.prepare(firstAdapter.dialect.sql(
        "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('generation-subscription', ?, 'sandbox', 'sub_generation', 'price_generation', 'si_generation', 'agency', 1, 'active', 0, ?, ?, 0)",
      )).run(teamId, now, now);
      const definition = { catalogue: { agency: { quantity: { kind: "team-members" }, stripe: {
        sandbox: { priceId: "price_generation", productId: "prod_generation" },
        live: { priceId: "price_live_generation", productId: "prod_live_generation" },
      } } } };
      const makeDatabase = (adapter, holdProvider = false) => ({
        adapter, capsuleIdentity: "postgres-generation-lane", teamBillingDefinition: definition,
        paymentsConfig: { stripe: { livemode: false } }, clock: { now: () => new Date() },
        enqueueTeamBillingSeatConvergenceJob: async (_transaction, payload, key) => enqueued.push({ payload, key }),
        scheduleTeamBillingJobDispatch() {},
        updateTeamBillingSubscription: async () => {
          if (holdProvider) {
            markProviderStarted();
            await providerRelease;
          }
          return { ok: true, outcome: "acknowledged" };
        },
      });
      const first = makeDatabase(firstAdapter, true);
      const second = makeDatabase(secondAdapter);
      await stageTeamBillingMembershipChange(first, teamId, 1_787_952_100);
      const liveCall = performTeamBillingSeatConvergence(first, {}, enqueued[0].payload);
      await providerStarted;

      assert.deepEqual(await repairTeamBillingDesiredState(second), { queued: 1 });
      const staleBusyGeneration = enqueued.at(-1).payload;
      await assert.rejects(
        performTeamBillingSeatConvergence(second, {}, staleBusyGeneration),
        (error) => error?.code === "TEAM_BILLING_PROVIDER_LANE_BUSY",
      );
      const laneBefore = await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [claimToken], [claimExpiresAt] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
      )).get(teamId);
      assert.ok(laneBefore.claimToken);
      assert.deepEqual(await settleExhaustedTeamBillingManagementJob(
        second, staleBusyGeneration, "TEAM_BILLING_PROVIDER_LANE_BUSY",
      ), {
        settled: false, busy: true, replacementScheduled: true, availableAt: laneBefore.claimExpiresAt,
      });
      assert.equal((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [claimToken] FROM [sporades_team_billing_provider_lanes] WHERE [teamId] = ?",
      )).get(teamId)).claimToken, laneBefore.claimToken, "busy exhaustion cannot release another generation's live lane");
      assert.notEqual((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
      )).get(teamId)).status, "failed");

      releaseProvider();
      assert.deepEqual(await liveCall, { superseded: true });
      assert.deepEqual(await performTeamBillingSeatConvergence(second, {}, enqueued.at(-1).payload),
        { providerAcknowledged: true }, "only the replacement generation can acknowledge its intent");
      assert.deepEqual(await settleExhaustedTeamBillingManagementJob(
        second, staleBusyGeneration, "TEAM_BILLING_PROVIDER_LANE_BUSY",
      ), { settled: false, stale: true });
      assert.equal((await secondAdapter.prepare(secondAdapter.dialect.sql(
        "SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
      )).get(teamId)).status, "awaiting-observation",
      "busy exhaustion after the live call completes cannot corrupt acknowledgement state");
    } finally {
      releaseProvider?.();
      await secondAdapter.close();
    }
  });
});

async function waitForDesiredStatus(database, selectedTeamId, status, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  do {
    row = await database.adapter.prepare(
      "SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
    ).get(selectedTeamId);
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Team Billing desired state did not reach ${status}: ${JSON.stringify(row)}`);
}

async function waitForJobCount(database, handler, minimum, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  do {
    count = Number((await database.adapter.prepare(
      "SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [handler] = ?",
    ).get(handler)).count);
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Expected at least ${minimum} ${handler} Jobs, received ${count}`);
}

function openFixture(options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const adapter = {
    dialect: { sql: (statement) => statement },
    exec: (statement) => sqlite.exec(statement),
    prepare: (statement) => sqlite.prepare(statement),
    withTransaction: async (callback) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const result = await callback(adapter); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  sqlite.exec("CREATE TABLE [sporades_team_billing_desired_state] ([teamId] TEXT PRIMARY KEY, [intentId] TEXT NOT NULL UNIQUE, [kind] TEXT NOT NULL, [operationId] TEXT NULL, [targetProductKey] TEXT NOT NULL, [targetPriceId] TEXT NULL, [targetQuantity] INTEGER NOT NULL, [effectiveAt] INTEGER NOT NULL, [resetBillingCycle] INTEGER NULL, [endTrial] INTEGER NULL, [preserveTrial] INTEGER NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, [providerAttemptedAt] TEXT NULL, [resume] INTEGER NULL, [providerAcknowledgedAt] TEXT NULL, [activeJobGenerationId] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_provider_lanes] ([teamId] TEXT PRIMARY KEY, [claimToken] TEXT NULL, [claimExpiresAt] TEXT NULL, [updatedAt] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_erasure_state] ([teamId] TEXT PRIMARY KEY, [erasureKey] TEXT NOT NULL UNIQUE, [operationId] TEXT NOT NULL UNIQUE, [activeJobGenerationId] TEXT NOT NULL, [status] TEXT NOT NULL, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_erasure_tombstones] ([erasureKey] TEXT PRIMARY KEY, [evidenceDigest] TEXT NOT NULL, [providerQuiescedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_operations] ([id] TEXT PRIMARY KEY, [currency] TEXT NULL, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, [kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [mode] TEXT NULL, [quantity] INTEGER NULL, [providerPriceId] TEXT NULL, [paymentActionUrl] TEXT NULL, [paymentActionExpiresAt] TEXT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_customers] ([teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_billing_subscriptions] ([id] TEXT PRIMARY KEY, [currency] TEXT NULL, [unitAmount] INTEGER NULL, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, [providerPriceId] TEXT NOT NULL, [interval] TEXT NULL, [hasSchedule] INTEGER NOT NULL DEFAULT 0, [providerSubscriptionItemId] TEXT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, [cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodStart] TEXT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, [lastEventOccurredAt] TEXT NULL, [lastEventKind] TEXT NULL, [lastEventRank] INTEGER NULL, [terminalLatch] INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE [sporades_teams] ([id] TEXT PRIMARY KEY, [name] TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE [sporades_team_memberships] ([teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL)");
  adapter.prepare("INSERT INTO [sporades_teams] VALUES (?, 'Test Team')").run(teamId);
  adapter.prepare("INSERT INTO [sporades_team_memberships] VALUES (?, 'admin', 'admin')").run(teamId);
  const now = "2026-08-23T12:00:00.000Z";
  adapter.prepare("INSERT INTO [sporades_team_billing_customers] VALUES (?, 'sandbox', 'cus_test', ?, ?)").run(teamId, now, now);
  adapter.prepare("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt]) VALUES ('subscription', ?, 'sandbox', 'sub_test', ?, 'si_test', ?, ?, 'active', 0, ?, ?)")
    .run(teamId, options.productKey === "studio" ? "price_studio" : "price_agency", options.productKey ?? "agency", options.quantity ?? 2, now, now);
  const definition = { catalogue: {
    studio: { quantity: { kind: "fixed", value: 1 }, stripe: { sandbox: { priceId: "price_studio" }, live: { priceId: "price_live_studio" } } },
    agency: { quantity: { kind: "team-members", ...(options.minimum === undefined ? {} : { minimum: options.minimum }) }, stripe: { sandbox: { priceId: "price_agency" }, live: { priceId: "price_live_agency" } } },
    ...(options.agencyProMinimum === undefined ? {} : { "agency-pro": {
      quantity: { kind: "team-members", minimum: options.agencyProMinimum },
      stripe: { sandbox: { priceId: "price_agency_pro" }, live: { priceId: "price_live_agency_pro" } },
    } }),
  } };
  const enqueued = [];
  const providerCalls = [];
  const database = {
    adapter, teamBillingDefinition: definition, paymentsConfig: { stripe: { livemode: false } }, capsuleIdentity: "capsule-test",
    clock: { now: () => new Date(now) },
    countTeamBillingMembers: async (transaction, selectedTeamId) => Number((await transaction.prepare("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?").get(selectedTeamId)).count),
    readTeamBillingActorAuth: async (_transaction, userId) => fixture.workerAuthByUserId?.[userId] ?? fixture.workerAuth,
    runTeamBillingAuthority: async (_transaction, admittedActor, input) => {
      fixture.lastAuthorityInput = input;
      fixture.lastAuthorityActor = admittedActor.userId;
      return { allow: fixture.authority };
    },
    enqueueTeamBillingPlanTransitionJob: async (_transaction, payload, key) => enqueued.push({ kind: "plan", payload, key }),
    enqueueTeamBillingSeatConvergenceJob: async (_transaction, payload, key) => enqueued.push({ kind: "seat", payload, key }),
    updateTeamBillingSubscription: async (_context, input) => {
      providerCalls.push(input);
      if (fixture.providerError) throw fixture.providerError;
      return fixture.providerOutcome;
    },
  };
  const fixture = {
    adapter, database, authority: true, workerAuth: actor, workerAuthByUserId: null, lastAuthorityActor: null,
    providerError: null, providerOutcome: { ok: true, outcome: "acknowledged" }, enqueued, providerCalls,
    desired: () => adapter.prepare("SELECT * FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?").get(teamId),
    operation: () => adapter.prepare("SELECT * FROM [sporades_team_billing_operations] WHERE [teamId] = ? ORDER BY [createdAt] DESC LIMIT 1").get(teamId),
    operationForRequest: (requestId) => adapter.prepare("SELECT * FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?").get(teamId, requestId),
    setRole: (role) => adapter.prepare("UPDATE [sporades_team_memberships] SET [role] = ? WHERE [teamId] = ? AND [userId] = 'admin'").run(role, teamId),
    setMembers: (count) => {
      adapter.prepare("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] <> 'admin'").run(teamId);
      for (let index = 1; index < count; index += 1) adapter.prepare("INSERT INTO [sporades_team_memberships] VALUES (?, ?, 'member')").run(teamId, `member-${index}`);
    },
    close: () => sqlite.close(),
  };
  return fixture;
}

function randomRequestId(seed) {
  return `${seed.repeat(8)}-${seed.repeat(4)}-4${seed.repeat(3)}-8${seed.repeat(3)}-${seed.repeat(12)}`;
}

function generationPayload(staged) {
  return { intentId: staged.intentId, generationId: staged.generationId };
}

function desiredPayload(desired) {
  return { intentId: desired.intentId, generationId: desired.activeJobGenerationId };
}

test("a superseded provider acknowledgement cannot overwrite a replacement operation's denial", async () => {
  const fixture = openFixture({ productKey: "studio", quantity: 1 });
  let finishProvider;
  try {
    fixture.setMembers(3);
    const firstRequest = randomRequestId("a");
    const secondRequest = randomRequestId("b");
    await requestTeamBillingPlanTransition(fixture.database, actor, teamId, firstRequest, "agency");
    const first = fixture.desired();
    let entered;
    const providerEntered = new Promise((resolve) => { entered = resolve; });
    fixture.database.updateTeamBillingSubscription = async () => {
      entered();
      return new Promise((resolve) => { finishProvider = resolve; });
    };
    const oldAttempt = performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(first));
    await providerEntered;
    await requestTeamBillingPlanTransition(fixture.database, actor, teamId, secondRequest, "agency");
    fixture.setRole("member");
    await assert.rejects(performTeamBillingPlanTransition(fixture.database, {}, desiredPayload(fixture.desired())),
      (error) => error.code === "TEAM_BILLING_DENIED");
    const failed = fixture.operationForRequest(secondRequest);
    assert.equal(failed.status, "failed");
    finishProvider({ ok: true, outcome: "acknowledged" });
    assert.deepEqual(await oldAttempt, { superseded: true });
    assert.equal(fixture.operationForRequest(firstRequest).status, "superseded");
    assert.equal(fixture.operationForRequest(secondRequest).status, "failed");
    assert.equal(fixture.operationForRequest(secondRequest).safeFailureCode, failed.safeFailureCode);
  } finally {
    finishProvider?.({ ok: true, outcome: "acknowledged" });
    fixture.close();
  }
});

for (const billingMode of ["classic", "flexible"]) for (const [label, periodStart, periodEnd] of [
  ["initial period", "2027-01-31", "2027-04-30"],
  ["clamped renewal", "2027-04-30", "2027-07-31"],
  ["ordinary renewal", "2027-07-31", "2027-10-31"],
]) test(`startup repair acknowledges an applied quarterly reset after ${label} (${billingMode})`, async () => {
  const f = openFixture({ productKey: "agency", quantity: 5 });
  const seconds = date => Date.parse(`${date}T12:00:00Z`) / 1000;
  let now = "2027-01-31";
  let posts = 0;
  let current = { id: "sub_test", object: "subscription", customer: "cus_test", livemode: false,
    status: "active", billing_mode: { type: billingMode }, billing_cycle_anchor: seconds("2027-01-01"), pending_update: null,
    items: { object: "list", has_more: false, data: [{ id: "si_test", object: "subscription_item", subscription: "sub_test", quantity: 5,
      price: { id: "price_agency", object: "price", livemode: false, product: "prod_agency", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } },
      current_period_start: seconds("2027-01-01"), current_period_end: seconds("2027-02-01") }] } };
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      for await (const _chunk of request) {}
      posts++;
      current.billing_cycle_anchor = seconds("2027-01-31");
      Object.assign(current.items.data[0], { price: { ...current.items.data[0].price, id: "price_quarter", recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } },
        current_period_start: seconds("2027-01-31"), current_period_end: seconds("2027-04-30") });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(current));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = createStripeTeamBillingProvider({ config: { enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", apiVersion: "2026-08-26.dahlia", livemode: false, requestTimeoutMs: 1000 },
      env: { STRIPE_SECRET_KEY: "sk_test_renewal" }, apiBaseUrl: `http://127.0.0.1:${server.address().port}` });
    f.database.clock = { now: () => new Date(`${now}T12:00:00Z`) };
    f.setMembers(5);
    f.database.teamBillingDefinition.catalogue.agency.stripe.sandbox = { prices: { "month:1": { priceId: "price_agency" }, "month:3": { priceId: "price_quarter" } } };
    f.adapter.prepare("UPDATE [sporades_team_billing_subscriptions] SET [interval] = 'month:1'").run();
    f.database.updateTeamBillingSubscription = (_context, input) => provider.updateManagedSubscription({
      mode: input.mode, customerId: input.providerCustomerId, subscriptionId: input.providerSubscriptionId, subscriptionItemId: input.providerSubscriptionItemId,
      sourcePriceId: input.sourcePriceId, targetPriceId: input.targetPriceId, targetQuantity: input.targetQuantity,
      operationKind: input.operationKind, prorationDate: input.prorationDate, idempotencyKey: input.idempotencyKey, resetBillingCycle: input.resetBillingCycle,
    });
    await requestTeamBillingPlanTransition(f.database, actor, teamId, randomRequestId("a"), "agency", "month:3");
    await performTeamBillingPlanTransition(f.database, {}, desiredPayload(f.desired()));
    assert.equal(posts, 1);
    const attempted = f.desired();
    assert.ok(attempted.providerAttemptedAt);
    Object.assign(current.items.data[0], { current_period_start: seconds(periodStart), current_period_end: seconds(periodEnd) });
    now = periodStart === "2027-01-31" ? "2027-02-15" : periodStart === "2027-04-30" ? "2027-05-15" : "2027-08-15";
    await repairTeamBillingDesiredState(f.database);
    assert.equal(f.desired().idempotencyKey, attempted.idempotencyKey);
    await performTeamBillingPlanTransition(f.database, {}, desiredPayload(f.desired()));
    assert.equal(posts, 1, "recovery must not POST another reset for the already-applied interval");
    assert.equal(f.desired().status, "awaiting-observation", "retrieval alone does not grant entitlement");
    assert.equal(f.adapter.prepare("SELECT [providerPriceId] FROM [sporades_team_billing_subscriptions]").get().providerPriceId, "price_agency");
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close();
  }
});
