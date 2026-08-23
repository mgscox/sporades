import assert from "node:assert/strict";
import {
  performTeamBillingPlanTransition,
  performTeamBillingSeatConvergence,
  repairTeamBillingDesiredState,
  requestTeamBillingPlanTransition,
  settleExhaustedTeamBillingManagementJob,
  settleVerifiedTeamBillingTarget,
  stageTeamBillingMembershipChange,
} from "../../../dist/team-billing-management.js";
import {
  performTeamBillingErasure,
  prepareTeamBillingErasure,
  repairTeamBillingErasureStateAtStartup,
} from "../../../dist/team-billing-erasure.js";

const NOW = "2026-08-14T12:00:00.000Z";

async function count(adapter, statement, ...values) {
  const row = await adapter.prepare(adapter.dialect.sql(statement)).get(...values);
  return Number(row?.count ?? 0);
}

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (runtime Team storage)",
  appTableNames: [],
  async prepareStorage(adapter) {
    await adapter.ensureTeamsStorage();
  },
  cases: [
    {
      name: "ensureTeamBillingStorage upgrades the prior schema and preserves private provider correlation on every engine",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await createPriorTeamBillingStorage(adapter);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?)")).run("billing-team", "sandbox", "cus_private", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run("local-sub", "billing-team", "sandbox", "sub_private", "price_private", "agency", 3, "active", 0, "2026-09-14T12:00:00.000Z", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run("operation-1", "request-1", "billing-team", "billing-admin", "checkout", "agency", "queued", null, "private-idempotency", null, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")).run("observation-1", "billing-team", "sandbox", "evt_private", "sub_private", "digest", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_replay] ([providerEventId], [payloadDigest], [settledAt], [retainedUntil]) VALUES (?, ?, ?, ?)")).run("evt_private", "digest", NOW, "2026-09-13T12:00:00.000Z");

        await adapter.ensureTeamBillingStorage();
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_subscriptions] SET [providerSubscriptionItemId] = 'si_private', [currentPeriodStart] = ?, [lastEventOccurredAt] = ?, [lastEventKind] = 'cancelled', [lastEventRank] = 50, [terminalLatch] = 1 WHERE [id] = 'local-sub'",
        )).run(NOW, NOW);
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_operations] SET [providerSubscriptionId] = 'sub_private' WHERE [id] = 'operation-1'",
        )).run();
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_observations] SET [eventType] = 'customer.subscription.deleted', [eventRank] = 50, [outcome] = 'applied', [safeReason] = NULL WHERE [id] = 'observation-1'",
        )).run();
        await adapter.prepare(sql(
          "INSERT INTO [sporades_team_billing_desired_state] ([teamId], [intentId], [kind], [operationId], [targetProductKey], [targetQuantity], [effectiveAt], [idempotencyKey], [status], [safeFailureCode], [providerAcknowledgedAt], [createdAt], [updatedAt]) VALUES (?, ?, 'seat-convergence', NULL, 'agency', 3, 1786708800, ?, 'queued', NULL, NULL, ?, ?)",
        )).run("billing-team", "intent-private", "desired-private-idempotency", NOW, NOW);
        await adapter.prepare(sql(
          "INSERT INTO [sporades_team_billing_provider_lanes] ([teamId], [claimToken], [claimExpiresAt], [updatedAt]) VALUES (?, NULL, NULL, ?)",
        )).run("billing-team", NOW);

        await adapter.ensureTeamBillingStorage();
        for (const table of ["customers", "subscriptions", "operations", "observations", "replay", "desired_state", "provider_lanes"]) {
          assert.equal(await count(adapter, `SELECT COUNT(*) AS [count] FROM [sporades_team_billing_${table}]`), 1, table);
        }
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionItemId] = 'si_private' AND [currentPeriodStart] = ? AND [lastEventRank] = 50 AND [terminalLatch] = 1", NOW), 1);
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_operations] WHERE [providerSubscriptionId] = 'sub_private'"), 1);
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_observations] WHERE [eventType] = 'customer.subscription.deleted' AND [eventRank] = 50 AND [outcome] = 'applied'"), 1);
        for (const table of ["erasure_state", "erasure_tombstones", "erasure_object_tombstones"]) {
          assert.equal(await count(adapter, `SELECT COUNT(*) AS [count] FROM [sporades_team_billing_${table}]`), 0, table);
        }
      },
    },
    {
      name: "provider-safe Team erasure survives restart with fenced generations on every adapter",
      async run(adapter) {
        const sql = adapter.dialect.sql;
        const teamId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const requestId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const auth = { userId: "erasure-admin", isAuthenticated: true, isGuest: false, provider: "test" };
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Erasure', ?, 'erasure-admin')")).run(teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'erasure-admin', 'admin', ?)")).run(teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_erasure_adapter', ?, ?)")).run(teamId, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('erasure-subscription', ?, 'sandbox', 'sub_erasure_adapter', 'price_erasure_adapter', 'si_erasure_adapter', 'agency', 2, 'active', 0, ?, ?, 0)")).run(teamId, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt], [mode]) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ?, 'erasure-admin', 'checkout', 'agency', 'ready', 'cs_test_erasure_adapter', 'checkout-erasure-adapter', NULL, ?, ?, 'sandbox')")).run(teamId, NOW, NOW);
        const enqueued = [];
        const providerCalls = [];
        const database = {
          adapter,
          capsuleIdentity: "adapter-erasure",
          clock: { now: () => new Date(NOW) },
          paymentsConfig: { stripe: { livemode: false } },
          teamBillingDefinition: { catalogue: { agency: {} }, checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" } },
          runTeamBillingAuthority: async () => ({ allow: true }),
          readTeamBillingActorAuth: async () => auth,
          enqueueTeamBillingErasureJob: async (_transaction, payload, key) => enqueued.push({ payload, key }),
          scheduleTeamBillingJobDispatch() {},
          quiesceTeamBillingProvider: async (_context, input) => {
            providerCalls.push(input);
            return {
              ok: true, outcome: "quiesced", providerObservedAt: NOW,
              checkouts: [{ id: "cs_test_erasure_adapter", state: "expired" }],
              subscriptions: [{ id: "sub_erasure_adapter", state: "cancelled" }],
            };
          },
        };
        await prepareTeamBillingErasure(database, auth, teamId, requestId);
        const stale = enqueued[0].payload;
        assert.deepEqual(await repairTeamBillingErasureStateAtStartup(database), { queued: 1 });
        const fresh = enqueued[1].payload;
        assert.notEqual(fresh.generationId, stale.generationId);
        assert.deepEqual(await performTeamBillingErasure(database, {}, stale), { superseded: true });
        assert.deepEqual(await performTeamBillingErasure(database, {}, fresh), { providerQuiesced: true });
        assert.equal(providerCalls.length, 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_subscriptions] WHERE [teamId] = ?", teamId), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_erasure_tombstones]"), 1);
        const tombstone = await adapter.prepare(sql("SELECT * FROM [sporades_team_billing_erasure_tombstones]")).get();
        assert.equal(JSON.stringify(tombstone).includes(teamId), false);
        assert.equal(JSON.stringify(tombstone).includes("sub_erasure_adapter"), false);
        await adapter.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ?")).run(teamId);
        await adapter.prepare(sql("DELETE FROM [sporades_teams] WHERE [id] = ?")).run(teamId);
      },
    },
    {
      name: "Team-member billing desired state supersedes and settles through every adapter",
      async run(adapter) {
        const sql = adapter.dialect.sql;
        const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Managed', ?, 'managed-admin')")).run(teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'managed-admin', 'admin', ?), (?, 'managed-member', 'member', ?)")).run(teamId, NOW, teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_managed_adapter', ?, ?)")).run(teamId, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('managed-subscription', ?, 'sandbox', 'sub_managed_adapter', 'price_managed_adapter', 'si_managed_adapter', 'agency', 1, 'active', 0, ?, ?, 0)")).run(teamId, NOW, NOW);
        const enqueued = [];
        const providerCalls = [];
        let providerError = null;
        const database = {
          adapter,
          capsuleIdentity: "adapter-conformance",
          clock: { now: () => new Date(NOW) },
          paymentsConfig: { stripe: { livemode: false } },
          teamBillingDefinition: { catalogue: { agency: { quantity: { kind: "team-members" }, stripe: {
            sandbox: { priceId: "price_managed_adapter", productId: "prod_managed_adapter" },
            live: { priceId: "price_live_managed_adapter", productId: "prod_live_managed_adapter" },
          } } } },
          enqueueTeamBillingSeatConvergenceJob: async (_transaction, payload, key) => enqueued.push({ payload, key }),
          scheduleTeamBillingJobDispatch() {},
          updateTeamBillingSubscription: async (_context, input) => {
            providerCalls.push(input);
            if (providerError) throw providerError;
            return { ok: true, outcome: "acknowledged" };
          },
        };
        const first = await stageTeamBillingMembershipChange(database, teamId, 1_786_708_800);
        assert.equal(first.staged, true);
        const firstIntent = await adapter.prepare(sql("SELECT [intentId], [activeJobGenerationId], [idempotencyKey], [targetQuantity] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
        assert.equal(firstIntent.targetQuantity, 2);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'managed-late', 'member', ?)")).run(teamId, NOW);
        await stageTeamBillingMembershipChange(database, teamId, 1_786_708_801);
        const latest = await adapter.prepare(sql("SELECT [intentId], [activeJobGenerationId], [idempotencyKey], [targetQuantity] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
        assert.equal(latest.targetQuantity, 3);
        assert.notEqual(latest.intentId, firstIntent.intentId);
        assert.notEqual(latest.idempotencyKey, firstIntent.idempotencyKey);
        assert.deepEqual(await performTeamBillingSeatConvergence(database, {}, desiredPayload(firstIntent)), { superseded: true });
        assert.equal(providerCalls.length, 0, "a superseded worker never reaches the provider");

        providerError = Object.assign(new Error("adapter provider outage"), { retryable: true, code: "PROVIDER_UNAVAILABLE" });
        await assert.rejects(
          performTeamBillingSeatConvergence(database, { signal: new AbortController().signal }, desiredPayload(latest)),
          (error) => error?.retryable === true && error?.code === "PROVIDER_UNAVAILABLE",
        );
        await settleExhaustedTeamBillingManagementJob(database, desiredPayload(latest), "PROVIDER_UNAVAILABLE");
        const exhausted = await adapter.prepare(sql(
          "SELECT [intentId], [activeJobGenerationId], [idempotencyKey], [effectiveAt], [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
        )).get(teamId);
        assert.equal(exhausted.status, "failed");
        await repairTeamBillingDesiredState(database);
        const repaired = await adapter.prepare(sql(
          "SELECT [intentId], [activeJobGenerationId], [idempotencyKey], [effectiveAt], [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
        )).get(teamId);
        assert.deepEqual({ ...repaired, activeJobGenerationId: undefined }, { ...exhausted, activeJobGenerationId: undefined, status: "queued" },
          "restart repair retains provider tuple identity and proration time");
        assert.equal(new Set(enqueued.map((entry) => entry.key)).size, enqueued.length,
          "every retained desired tuple dispatch receives a fresh queue generation");

        providerError = null;
        await performTeamBillingSeatConvergence(database, { signal: new AbortController().signal }, desiredPayload(repaired));
        assert.equal(providerCalls.at(-1).targetQuantity, 3);
        assert.equal(new Set(providerCalls.map((input) => input.idempotencyKey)).size, 1,
          "provider idempotency remains stable across outage and repair Job generations");
        assert.equal((await adapter.prepare(sql("SELECT [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId)).status, "awaiting-observation");
        assert.deepEqual(await settleVerifiedTeamBillingTarget(database, {
          teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_managed_adapter", occurredAt: NOW,
        }), { settled: false, repairRequired: true });
        assert.equal(new Set(enqueued.map((entry) => entry.key)).size, enqueued.length,
          "provider-drift repair also receives a fresh queue generation");
        const driftRepaired = await adapter.prepare(sql("SELECT [intentId], [activeJobGenerationId] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
        await performTeamBillingSeatConvergence(database, { signal: new AbortController().signal }, desiredPayload(driftRepaired));

        await adapter.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] IN ('managed-member', 'managed-late')")).run(teamId);
        await stageTeamBillingMembershipChange(database, teamId, 1_786_708_802);
        const lower = await adapter.prepare(sql(
          "SELECT [intentId], [activeJobGenerationId], [idempotencyKey], [targetQuantity], [status] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
        )).get(teamId);
        assert.equal(lower.targetQuantity, 1, "rapid leaves supersede the previously acknowledged higher count");
        assert.notEqual(lower.intentId, latest.intentId);
        assert.deepEqual(await performTeamBillingSeatConvergence(database, {}, desiredPayload(latest)), { superseded: true },
          "the stale higher-count worker cannot perform");
        await adapter.prepare(sql("UPDATE [sporades_team_billing_subscriptions] SET [quantity] = 3 WHERE [teamId] = ?")).run(teamId);
        assert.deepEqual(await settleVerifiedTeamBillingTarget(database, {
          teamId, productKey: "agency", quantity: 3, subscriptionId: "sub_managed_adapter", occurredAt: NOW,
        }), { settled: false }, "stale verified higher quantity cannot settle the latest lower desired tuple");
        assert.equal((await adapter.prepare(sql(
          "SELECT [intentId], [targetQuantity] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?",
        )).get(teamId)).intentId, lower.intentId);
        await performTeamBillingSeatConvergence(database, { signal: new AbortController().signal }, desiredPayload(lower));
        assert.equal(providerCalls.at(-1).targetQuantity, 1);
        assert.notEqual(providerCalls.at(-1).idempotencyKey, providerCalls[0].idempotencyKey,
          "the lower desired tuple owns a distinct provider identity");
        await adapter.prepare(sql("UPDATE [sporades_team_billing_subscriptions] SET [quantity] = 1 WHERE [teamId] = ?")).run(teamId);
        await settleVerifiedTeamBillingTarget(database, { teamId, productKey: "agency", quantity: 1, subscriptionId: "sub_managed_adapter", occurredAt: NOW });
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?", teamId), 0);
        assert.ok(enqueued.length >= 2);
        await adapter.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ?")).run(teamId);
        await adapter.prepare(sql("DELETE FROM [sporades_teams] WHERE [id] = ?")).run(teamId);
      },
    },
    {
      name: "managed Team-counted to fixed Plan transitions recheck authority on every adapter",
      async run(adapter) {
        const sql = adapter.dialect.sql;
        const teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Policy transition', ?, 'policy-admin')")).run(teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'policy-admin', 'admin', ?), (?, 'policy-member-1', 'member', ?), (?, 'policy-member-2', 'member', ?)")).run(teamId, NOW, teamId, NOW, teamId, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_policy_adapter', ?, ?)")).run(teamId, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('policy-subscription', ?, 'sandbox', 'sub_policy_adapter', 'price_policy_agency', 'si_policy_adapter', 'policy-agency', 3, 'active', 0, ?, ?, 0)")).run(teamId, NOW, NOW);
        const providerCalls = [];
        const enqueued = [];
        let authority = true;
        const linkedActor = { userId: "policy-admin", isAuthenticated: true, isGuest: false, provider: "test" };
        const database = {
          adapter, capsuleIdentity: "adapter-plan-policy", clock: { now: () => new Date(NOW) },
          paymentsConfig: { stripe: { livemode: false } },
          teamBillingDefinition: { catalogue: {
            "policy-agency": { quantity: { kind: "team-members" }, stripe: {
              sandbox: { priceId: "price_policy_agency", productId: "prod_policy_agency" },
              live: { priceId: "price_live_policy_agency", productId: "prod_live_policy_agency" },
            } },
            "policy-studio": { quantity: { kind: "fixed", value: 1 }, stripe: {
              sandbox: { priceId: "price_policy_studio", productId: "prod_policy_studio" },
              live: { priceId: "price_live_policy_studio", productId: "prod_live_policy_studio" },
            } },
          } },
          runTeamBillingAuthority: async () => ({ allow: authority }),
          readTeamBillingActorAuth: async () => linkedActor,
          enqueueTeamBillingPlanTransitionJob: async (_transaction, payload, key) => enqueued.push({ payload, key }),
          scheduleTeamBillingJobDispatch() {},
          updateTeamBillingSubscription: async (_context, input) => {
            providerCalls.push(input);
            return { ok: true, outcome: "acknowledged" };
          },
        };
        await requestTeamBillingPlanTransition(database, linkedActor, teamId, requestId, "policy-studio");
        const desired = await adapter.prepare(sql("SELECT * FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
        assert.equal(desired.targetQuantity, 1);
        authority = false;
        await assert.rejects(
          performTeamBillingPlanTransition(database, {}, desiredPayload(desired)),
          (error) => error?.code === "TEAM_BILLING_DENIED",
        );
        assert.equal(providerCalls.length, 0);
        assert.equal((await adapter.prepare(sql("SELECT [safeFailureCode] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId)).safeFailureCode, "AUTHORITY_CHANGED");
        authority = true;
        await repairTeamBillingDesiredState(database);
        const repairedDesired = await adapter.prepare(sql("SELECT * FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?")).get(teamId);
        await performTeamBillingPlanTransition(database, {}, desiredPayload(repairedDesired));
        assert.equal(providerCalls.length, 1);
        assert.equal(providerCalls[0].sourcePriceId, "price_policy_agency");
        assert.equal(providerCalls[0].targetPriceId, "price_policy_studio");
        assert.equal(providerCalls[0].targetQuantity, 1);
        assert.equal(new Set(enqueued.map((entry) => entry.key)).size, enqueued.length);
        await adapter.prepare(sql("UPDATE [sporades_team_billing_subscriptions] SET [providerPriceId] = 'price_policy_studio', [productKey] = 'policy-studio', [quantity] = 1 WHERE [teamId] = ?")).run(teamId);
        assert.deepEqual(await settleVerifiedTeamBillingTarget(database, {
          teamId, productKey: "policy-studio", quantity: 1, subscriptionId: "sub_policy_adapter", occurredAt: NOW,
        }), { settled: true });
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_desired_state] WHERE [teamId] = ?", teamId), 0);
        await adapter.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ?")).run(teamId);
        await adapter.prepare(sql("DELETE FROM [sporades_teams] WHERE [id] = ?")).run(teamId);
      },
    },
    {
      name: "ensureTeamsStorage creates empty writable runtime tables and preserves existing Team history",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_secrets]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_links]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_throttles]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions]"), 0);

        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("team-one", "My Team", NOW, "user-one");
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("team-one", "user-one", "admin", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_bootstrap] ([userId], [teamId], [createdAt]) VALUES (?, ?, ?)")).run("user-one", "team-one", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, ?)")).run("user-one", 1);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_secrets] ([id], [secret], [createdAt]) VALUES (?, ?, ?)")).run("v1", "test-secret", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")).run("link-one", "selector-one", "hash-one", "team-one", "invitee@example.com", "user-one", NOW, "2026-08-15T12:00:00.000Z");
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_throttles] ([teamId], [adminUserId], [windowStartedAt], [count]) VALUES (?, ?, ?, ?)")).run("team-one", "user-one", NOW, 1);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_counters] ([teamId], [activeCount]) VALUES (?, ?)")).run("team-one", 1);

        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [id] = ?", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?", "team-one", "user-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap] WHERE [userId] = ? AND [teamId] = ?", "user-one", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters] WHERE [userId] = ? AND [membershipCount] = ?", "user-one", 1), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_secrets] WHERE [id] = ?", "v1"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_links] WHERE [id] = ? AND [email] = ?", "link-one", "invitee@example.com"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_throttles] WHERE [teamId] = ? AND [adminUserId] = ?", "team-one", "user-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters] WHERE [teamId] = ? AND [activeCount] = ?", "team-one", 1), 1);
      },
    },
    {
      name: "Team membership counter admits exactly one final bounded slot through the adapter transaction seam",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, ?)")).run("bounded-user", 24);
        const first = await adapter.withTransaction((tx) => tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 WHERE [userId] = ? AND [membershipCount] < ?",
        )).run("bounded-user", 25));
        const second = await adapter.withTransaction((tx) => tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 WHERE [userId] = ? AND [membershipCount] < ?",
        )).run("bounded-user", 25));
        assert.equal(Number(first.changes), 1);
        assert.equal(Number(second.changes), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters] WHERE [userId] = ? AND [membershipCount] = ?", "bounded-user", 25), 1);
      },
    },
    {
      name: "Team lifecycle locking keeps exact counts and membership rollback portable",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("counted-team", "Counted", NOW, "counted-admin");
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "counted-admin", "admin", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "counted-member", "member", NOW);
        await assert.rejects(adapter.withTransaction(async (tx) => {
          const locked = await tx.prepare(tx.dialect.sql("UPDATE [sporades_teams] SET [name] = [name] WHERE [id] = ?")).run("counted-team");
          assert.equal(Number(locked.changes), 1);
          assert.equal(await count(tx, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?", "counted-team"), 2);
          await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "rolled-back-member", "member", NOW);
          throw new Error("roll back admission lane");
        }), /roll back admission lane/);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?", "counted-team"), 2);
      },
    },
  ],
};

async function createPriorTeamBillingStorage(adapter) {
  const sql = adapter.dialect.sql;
  for (const statement of [
    "CREATE TABLE [sporades_team_billing_customers] ([teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_subscriptions] ([id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, [providerPriceId] TEXT NOT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, [cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_operations] ([id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, [kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, UNIQUE ([teamId], [requestId]))",
    "CREATE TABLE [sporades_team_billing_observations] ([id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, [providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_replay] ([providerEventId] TEXT PRIMARY KEY, [payloadDigest] TEXT NOT NULL, [settledAt] TEXT NOT NULL, [retainedUntil] TEXT NOT NULL)",
  ]) {
    await adapter.exec(sql(statement));
  }
}

function desiredPayload(desired) {
  return {
    intentId: desired.intentId,
    generationId: desired.activeJobGenerationId,
  };
}
