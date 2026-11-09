import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { String as Text, table } from "../dist/server.js";
import { performTeamBillingPortal, performTeamBillingCheckout, startTeamBillingCheckout, startTeamBillingPortal, TEAM_BILLING_CHECKOUT_JOB, TEAM_BILLING_PORTAL_JOB } from "../dist/team-billing-runtime.js";
import { promoteTeamMember } from "../dist/teams-runtime.js";
import { requestTeamBillingPlanTransition } from "../dist/team-billing-management.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "checkout-concurrent-admin";
const auth = { userId, displayName: "Checkout admin", email: "checkout@example.test", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
const payments = { stripe: {
  enabled: true,
  secretKeyEnv: "STRIPE_SECRET_KEY",
  webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://checkout.example.test",
  callbackPath: "/stripe/webhook",
  apiVersion: "2026-08-26.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
} };
const baseEnv = { STRIPE_SECRET_KEY: "sk_test_concurrent", STRIPE_WEBHOOK_SECRET: "whsec_concurrent" };
const capsule = {
  name: "team-checkout-concurrency",
  schema: { billingHolders: table({ teamId: Text(), userId: Text() }).unique("teamId") },
  teamBilling: {
    checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" },
    portal: { returnPath: "/billing" },
    catalogue: {
      agency: { quantity: { kind: "team-members" }, stripe: {
        sandbox: { productId: "prod_test_agency", priceId: "price_test_agency", portalConfigurationId: "bpc_test_agency" },
        live: { productId: "prod_live_agency", priceId: "price_live_agency", portalConfigurationId: "bpc_live_agency" },
      } },
    },
    authorize: async (ctx, input) => (await ctx.db.billingHolders.where("teamId", input.teamId).get())?.userId === ctx.auth.userId
      ? { allow: true } : { allow: false },
  },
};
const minimumCapsule = {
  ...capsule,
  name: "team-checkout-minimum",
  teamBilling: {
    ...capsule.teamBilling,
    catalogue: {
      agency: {
        ...capsule.teamBilling.catalogue.agency,
        quantity: { kind: "team-members", minimum: 5 },
      },
    },
  },
};

const engines = [
  {
    name: "SQLite",
    skip: false,
    async run(dir, fn, selectedCapsule = capsule) {
      const file = path.join(dir, "data.db");
      const first = await open(file, baseEnv, {}, undefined, selectedCapsule);
      const second = await open(file, baseEnv, {}, undefined, selectedCapsule);
      try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
    },
  },
  {
    name: "libSQL",
    skip: false,
    async run(dir, fn, selectedCapsule = capsule) {
      await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
        const env = { ...baseEnv, SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
        const config = { services: { database: { kind: "database", engine: "libsql" } } };
        const first = await open(path.join(dir, "unused-1.db"), env, config, undefined, selectedCapsule);
        const second = await open(path.join(dir, "unused-2.db"), env, config, undefined, selectedCapsule);
        try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
      });
    },
  },
  {
    name: "PostgreSQL",
    skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres Team Checkout concurrency test.",
    async run(dir, fn, selectedCapsule = capsule) {
      await withPostgresAdapter(async () => {}, { appTableNames: ["billingHolders"] });
      const env = { ...baseEnv, SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
      const config = { services: { database: { engine: "postgres" } } };
      const first = await open(path.join(dir, "unused-1.db"), env, config, undefined, selectedCapsule);
      const second = await open(path.join(dir, "unused-2.db"), env, config, undefined, selectedCapsule);
      try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
    },
  },
];

for (const engine of engines) {
  for (const operation of ["checkout", "plan-transition"]) {
    test(`${engine.name} ${operation} policy counts exact administrators and serializes promotion`, { skip: engine.skip }, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-staff-count-"));
      const counts = [];
      let capturedCount;
      let releasePolicy;
      let policyEntered;
      const entered = new Promise(resolve => { policyEntered = resolve; });
      const hold = new Promise(resolve => { releasePolicy = resolve; });
      const selectedCapsule = {
        ...capsule,
        teamBilling: {
          ...capsule.teamBilling,
          catalogue: {
            ...capsule.teamBilling.catalogue,
            studio: { ...capsule.teamBilling.catalogue.agency, quantity: { kind: "fixed", value: 1 }, stripe: {
              sandbox: { productId: "prod_test_studio", priceId: "price_test_studio", portalConfigurationId: "bpc_test_studio" },
              live: { productId: "prod_live_studio", priceId: "price_live_studio", portalConfigurationId: "bpc_live_studio" },
            } },
          },
          async authorize(ctx, input) {
            capturedCount = ctx.teams.countMembers;
            await assert.rejects(() => ctx.teams.countMembers("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), error => error.code === "TEAM_BILLING_DENIED");
            const count = await ctx.teams.countMembers(input.teamId);
            assert.equal(Object.isFrozen(count), true);
            counts.push(count);
            if (counts.length === 1) {
              policyEntered();
              await hold;
              assert.deepEqual(await ctx.teams.countMembers(input.teamId), count, "both counts stay in the locked snapshot");
            }
            return { allow: count.adminCount <= 1 };
          },
        },
      };
      try {
        await engine.run(dir, async (first, second) => {
          const sql = first.adapter.dialect.sql;
          const now = new Date().toISOString();
          await seedTeam(first, sql, now);
          await first.adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member', ?)")).run(teamId, now);
          if (operation === "plan-transition") {
            await first.adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_staff', ?, ?)")).run(teamId, now, now);
            await first.adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [providerSubscriptionItemId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [observedAt], [updatedAt], [terminalLatch]) VALUES ('staff-sub', ?, 'sandbox', 'sub_staff', 'price_test_agency', 'si_staff', 'agency', 2, 'active', 0, ?, ?, 0)")).run(teamId, now, now);
          }
          const request = () => operation === "checkout"
            ? startTeamBillingCheckout(first, auth, teamId, requestId, "studio")
            : requestTeamBillingPlanTransition(first, auth, teamId, requestId, "studio");
          const admission = request();
          // A broken count policy must fail promptly rather than leave this test waiting for its gate.
          await Promise.race([entered, admission.then(() => { throw new Error("policy did not reach gate"); })]);
          let promoted = false;
          const promotion = promoteTeamMember(second, auth, teamId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd").then(() => { promoted = true; });
          try {
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(promoted, false, "promotion waits for billing's Team lifecycle lock");
          } finally { releasePolicy(); }
          const [admitted, promotedResult] = await Promise.allSettled([admission, promotion]);
          assert.deepEqual(counts[0], { totalCount: 2, adminCount: 1 });
          assert.equal(admitted.status, "fulfilled", String(admitted.reason));
          assert.equal(admitted.value.state, "pending", "one admin and one viewer fit the one-staff product");
          assert.equal(promotedResult.status, "fulfilled", String(promotedResult.reason));
          await assert.rejects(() => capturedCount(teamId), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
          await assert.rejects(request, error => error.code === "TEAM_BILLING_DENIED");
          assert.deepEqual(counts.at(-1), { totalCount: 2, adminCount: 2 });
        }, selectedCapsule);
      } finally {
        releasePolicy();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  test(`${engine.name} trial allowance survives lost replies and concurrent runtimes across products`, { skip: engine.skip }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-trial-"));
    const selectedCapsule = { ...capsule, teamBilling: { ...capsule.teamBilling, catalogue: {
      agency: { ...capsule.teamBilling.catalogue.agency, trialDays: 14 },
      studio: { ...capsule.teamBilling.catalogue.agency, trialDays: 7, stripe: {
        sandbox: { productId: "prod_trial_studio", priceId: "price_trial_studio", portalConfigurationId: "bpc_trial_studio" },
        live: { productId: "prod_live_trial_studio", priceId: "price_live_trial_studio", portalConfigurationId: "bpc_live_trial_studio" },
      } },
    } } };
    try {
      await engine.run(dir, async (first, second) => {
        const sql = first.adapter.dialect.sql;
        await seedTeam(first, sql, new Date().toISOString());
        const enqueue = first.enqueueTeamBillingCheckoutJob;
        first.enqueueTeamBillingCheckoutJob = async () => { throw new Error("synthetic rollback"); };
        await assert.rejects(startTeamBillingCheckout(first, auth, teamId, requestId, "agency"), /synthetic rollback/);
        first.enqueueTeamBillingCheckoutJob = enqueue;
        await startTeamBillingCheckout(first, auth, teamId, requestId, "agency");
        const operation = await first.adapter.prepare(sql("SELECT [id] FROM [sporades_team_billing_operations] WHERE [requestId] = ?")).get(requestId);
        let calls = 0;
        const create = async input => {
          assert.equal(input.trialDays, 14);
          if (++calls === 1) throw Object.assign(new Error("synthetic lost reply"), { retryable: true });
          return { ok: true, sessionId: "cs_test_trial", url: "https://checkout.stripe.com/c/pay/cs_test_trial" };
        };
        first.createStripeTeamBillingProvider = second.createStripeTeamBillingProvider = () => ({ create });
        await assert.rejects(performTeamBillingCheckout(first, {}, { operationId: operation.id }), error => error.retryable === true);
        const otherRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        await assert.rejects(startTeamBillingCheckout(second, auth, teamId, otherRequestId, "studio"), error => error.code === "TEAM_BILLING_DENIED");
        second.teamBillingDefinition = { ...second.teamBillingDefinition, catalogue: {
          ...second.teamBillingDefinition.catalogue,
          agency: { ...second.teamBillingDefinition.catalogue.agency, trialDays: 7 },
        } };
        assert.deepEqual(await performTeamBillingCheckout(second, {}, { operationId: operation.id }, 2), { ready: true });
        assert.equal((await startTeamBillingCheckout(first, auth, teamId, requestId, "agency")).state, "ready");
        await first.adapter.prepare(sql("UPDATE [sporades_team_billing_operations] SET [status] = 'expired' WHERE [id] = ?")).run(operation.id);
        await assert.rejects(startTeamBillingCheckout(second, auth, teamId, otherRequestId, "studio"), error => error.code === "TEAM_BILLING_DENIED");
        assert.equal(calls, 2);
      }, selectedCapsule);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test(`${engine.name} serializes duplicate Team Checkout admission across runtimes`, { skip: engine.skip }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-team-checkout-${engine.name.toLowerCase()}-`));
    try {
      await engine.run(dir, async (first, second) => {
        const sql = first.adapter.dialect.sql;
        const now = new Date().toISOString();
        await first.adapter.prepare(sql("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, ?, ?, NULL, 1, 0, 'email')")).run(userId, now, auth.displayName, auth.email);
        await first.adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Checkout Team', ?, ?)")).run(teamId, now, userId);
        await first.adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(teamId, userId, now);
        await first.adapter.prepare(sql("INSERT INTO [billingHolders] ([id], [createdAt], [updatedAt], [teamId], [userId]) VALUES ('holder', ?, ?, ?, ?)")).run(now, now, teamId, userId);
        const [left, right] = await Promise.all([
          startTeamBillingCheckout(first, auth, teamId, requestId, "agency"),
          startTeamBillingCheckout(second, auth, teamId, requestId, "agency"),
        ]);
        assert.equal(left.state, "pending");
        assert.equal(right.state, "pending");
        assert.equal((await first.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, requestId)).count, 1);
        assert.equal((await first.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [handler] = ?")).get(TEAM_BILLING_CHECKOUT_JOB)).count, 1);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${engine.name} serializes duplicate Team Portal admission across runtimes`, { skip: engine.skip }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-team-portal-${engine.name.toLowerCase()}-`));
    try {
      await engine.run(dir, async (first, second) => {
        const sql = first.adapter.dialect.sql;
        const now = new Date().toISOString();
        await seedTeam(first, sql, now);
        await first.adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_concurrent_portal', ?, ?)")).run(teamId, now, now);
        await first.adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES ('portal-subscription', ?, 'sandbox', 'sub_concurrent_portal', 'price_test_agency', 'agency', 1, 'active', 0, NULL, ?, ?)")).run(teamId, now, now);
        const portalRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const [left, right] = await Promise.all([
          startTeamBillingPortal(first, auth, teamId, portalRequestId),
          startTeamBillingPortal(second, auth, teamId, portalRequestId),
        ]);
        assert.equal(left.state, "pending");
        assert.equal(right.state, "pending");
        assert.equal((await first.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, portalRequestId)).count, 1);
        assert.equal((await first.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [handler] = ?")).get(TEAM_BILLING_PORTAL_JOB)).count, 1);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("Team Checkout and Portal apply a declared member floor below it and exact membership above it", async () => {
  for (const memberCount of [1, 6]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-team-minimum-${memberCount}-`));
    const database = await open(path.join(dir, "data.db"), baseEnv, {}, undefined, minimumCapsule);
    try {
      const sql = database.adapter.dialect.sql;
      const now = new Date().toISOString();
      await seedTeam(database, sql, now);
      for (let index = 1; index < memberCount; index += 1) {
        await database.adapter.prepare(sql(
          "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)",
        )).run(teamId, `minimum-member-${index}`, now);
      }
      const expectedQuantity = memberCount === 1 ? 5 : 6;
      const checkoutRequestId = memberCount === 1
        ? "11111111-1111-4111-8111-111111111111"
        : "66666666-6666-4666-8666-666666666666";
      assert.equal((await startTeamBillingCheckout(database, auth, teamId, checkoutRequestId, "agency")).state, "pending");
      assert.equal((await database.adapter.prepare(sql(
        "SELECT [quantity] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
      )).get(teamId, checkoutRequestId)).quantity, expectedQuantity);

      await database.adapter.prepare(sql(
        "INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', ?, ?, ?)",
      )).run(teamId, `cus_minimum_${memberCount}`, now, now);
      await database.adapter.prepare(sql(
        "INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES (?, ?, 'sandbox', ?, 'price_test_agency', 'agency', ?, 'active', 0, NULL, ?, ?)",
      )).run(`minimum-subscription-${memberCount}`, teamId, `sub_minimum_${memberCount}`, expectedQuantity, now, now);
      const portalRequestId = memberCount === 1
        ? "22222222-2222-4222-8222-222222222222"
        : "77777777-7777-4777-8777-777777777777";
      assert.equal((await startTeamBillingPortal(database, auth, teamId, portalRequestId)).state, "pending");
      assert.equal((await database.adapter.prepare(sql(
        "SELECT [quantity] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?",
      )).get(teamId, portalRequestId)).quantity, expectedQuantity);
    } finally {
      await database.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Team Portal retries transient SQLite locks at both provider transaction boundaries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-portal-locks-"));
  const portalUrl = `https://billing.stripe.com/p/session?secret=${"a".repeat(89)}`;
  const database = await open(path.join(dir, "data.db"), baseEnv, {}, () => ({
    retrievePortalConfiguration: async () => ({ ok: true }),
    createPortal: async () => ({ ok: true, sessionId: "bps_test_lock_retry", url: portalUrl }),
  }));
  try {
    const sql = database.adapter.dialect.sql;
    const now = new Date().toISOString();
    await seedTeam(database, sql, now);
    await database.adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, 'sandbox', 'cus_lock_retry', ?, ?)")).run(teamId, now, now);
    await database.adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES ('lock-subscription', ?, 'sandbox', 'sub_lock_retry', 'price_test_agency', 'agency', 1, 'active', 0, NULL, ?, ?)")).run(teamId, now, now);
    const lockRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    assert.equal((await startTeamBillingPortal(database, auth, teamId, lockRequestId)).state, "pending");
    const operation = await database.adapter.prepare(sql("SELECT [id] FROM [sporades_team_billing_operations] WHERE [teamId] = ? AND [requestId] = ?")).get(teamId, lockRequestId);
    const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    const locked = () => { const error = new Error("database is locked"); error.code = "ERR_SQLITE_ERROR"; throw error; };

    database.adapter.withTransaction = async () => locked();
    await assert.rejects(performTeamBillingPortal(database, {}, { operationId: operation.id }, 1), (error) => error?.retryable === true);
    database.adapter.withTransaction = originalWithTransaction;
    assert.equal((await database.adapter.prepare(sql("SELECT [status] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(operation.id)).status, "queued");

    let boundary = 0;
    database.adapter.withTransaction = async (callback) => {
      boundary += 1;
      if (boundary === 2) return locked();
      return originalWithTransaction(callback);
    };
    await assert.rejects(performTeamBillingPortal(database, {}, { operationId: operation.id }, 2), (error) => error?.retryable === true);
    database.adapter.withTransaction = originalWithTransaction;
    assert.equal((await database.adapter.prepare(sql("SELECT [status] FROM [sporades_team_billing_operations] WHERE [id] = ?")).get(operation.id)).status, "retrying");
    assert.deepEqual(await performTeamBillingPortal(database, {}, { operationId: operation.id }, 3), { ready: true });

    let failReadyRead = true;
    database.adapter.withTransaction = async (callback) => originalWithTransaction(async (transaction) => {
      const originalPrepare = transaction.prepare.bind(transaction);
      transaction.prepare = (statement) => {
          if (failReadyRead && String(statement).includes("sporades_team_billing_customers")) {
            failReadyRead = false;
            return locked();
          }
          return originalPrepare(statement);
      };
      return callback(transaction);
    });
    const readyAfterTransientRead = await startTeamBillingPortal(database, auth, teamId, lockRequestId);
    database.adapter.withTransaction = originalWithTransaction;
    assert.equal(readyAfterTransientRead.state, "ready", "a transient ready-state read retries instead of burning the continuation");
    const persistedReady = await database.adapter.prepare(sql(
      "SELECT [status], [continuationUrl] FROM [sporades_team_billing_operations] WHERE [id] = ?",
    )).get(operation.id);
    assert.equal(persistedReady.status, "ready");
    assert.equal(persistedReady.continuationUrl, portalUrl);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedTeam(database, sql, now) {
  await database.adapter.prepare(sql("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, ?, ?, NULL, 1, 0, 'email')")).run(userId, now, auth.displayName, auth.email);
  await database.adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, 'Checkout Team', ?, ?)")).run(teamId, now, userId);
  await database.adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(teamId, userId, now);
  await database.adapter.prepare(sql("INSERT INTO [billingHolders] ([id], [createdAt], [updatedAt], [teamId], [userId]) VALUES ('holder', ?, ?, ?, ?)")).run(now, now, teamId, userId);
}

function open(databasePath, env, serviceConfig, providerFactory = () => ({ create: async () => { throw new Error("provider must not run before init"); } }), selectedCapsule = capsule) {
  return openDevDatabase(databasePath, "", env, { name: selectedCapsule.name, payments, ...serviceConfig }, selectedCapsule, {
    serviceEnv: env,
    createStripeCallbackEndpoint,
    createStripeTeamBillingProvider: providerFactory,
  });
}
