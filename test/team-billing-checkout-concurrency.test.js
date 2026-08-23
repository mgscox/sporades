import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { String as Text, table } from "../dist/server.js";
import { startTeamBillingCheckout, TEAM_BILLING_CHECKOUT_JOB } from "../dist/team-billing-runtime.js";
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
  apiVersion: "2026-07-29.dahlia",
  livemode: false,
  requestTimeoutMs: 10_000,
} };
const baseEnv = { STRIPE_SECRET_KEY: "sk_test_concurrent", STRIPE_WEBHOOK_SECRET: "whsec_concurrent" };
const capsule = {
  name: "team-checkout-concurrency",
  schema: { billingHolders: table({ teamId: Text(), userId: Text() }).unique("teamId") },
  teamBilling: {
    checkout: { successPath: "/billing/success", cancelPath: "/billing/cancelled" },
    catalogue: {
      agency: { quantity: { kind: "team-members" }, stripe: { sandbox: { priceId: "price_test_agency" }, live: { priceId: "price_live_agency" } } },
    },
    authorize: async (ctx, input) => (await ctx.db.billingHolders.where("teamId", input.teamId).get())?.userId === ctx.auth.userId
      ? { allow: true } : { allow: false },
  },
};

const engines = [
  {
    name: "SQLite",
    skip: false,
    async run(dir, fn) {
      const file = path.join(dir, "data.db");
      const first = await open(file, baseEnv, {});
      const second = await open(file, baseEnv, {});
      try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
    },
  },
  {
    name: "libSQL",
    skip: false,
    async run(dir, fn) {
      await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
        const env = { ...baseEnv, SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
        const config = { services: { database: { kind: "database", engine: "libsql" } } };
        const first = await open(path.join(dir, "unused-1.db"), env, config);
        const second = await open(path.join(dir, "unused-2.db"), env, config);
        try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
      });
    },
  },
  {
    name: "PostgreSQL",
    skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres Team Checkout concurrency test.",
    async run(dir, fn) {
      await withPostgresAdapter(async () => {}, { appTableNames: ["billingHolders"] });
      const env = { ...baseEnv, SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
      const config = { services: { database: { engine: "postgres" } } };
      const first = await open(path.join(dir, "unused-1.db"), env, config);
      const second = await open(path.join(dir, "unused-2.db"), env, config);
      try { await fn(first, second); } finally { await Promise.all([first.close(), second.close()]); }
    },
  },
];

for (const engine of engines) {
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
}

function open(databasePath, env, serviceConfig) {
  return openDevDatabase(databasePath, "", env, { name: capsule.name, payments, ...serviceConfig }, capsule, {
    serviceEnv: env,
    createStripeCallbackEndpoint,
    createStripeTeamBillingProvider: () => ({ create: async () => { throw new Error("provider must not run before init"); } }),
  });
}
