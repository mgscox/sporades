import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, inspectRuntimeJobs, openDevDatabase, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { job, mutation, Number as Numeric, query, String as Text, table } from "../dist/server.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

const tableName = "ticket08PaymentIntents";
const actor = { userId: "payment-actor", displayName: "Payment Actor", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "email" };

const engines = [
  {
    name: "SQLite",
    skip: false,
    async run(dir, capsule, clock, fn) {
      const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: capsule.name }, capsule, { clock });
      try { await fn(database); } finally { await database.close(); }
    },
  },
  {
    name: "libSQL",
    skip: false,
    async run(dir, capsule, clock, fn) {
      await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
        const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
        const database = await openDevDatabase(path.join(dir, "unused.db"), "", serverEnv, {
          name: capsule.name,
          services: { database: { kind: "database", engine: "libsql" } },
        }, capsule, { serviceEnv: serverEnv, clock });
        try { await fn(database); } finally { await database.close(); }
      });
    },
  },
  {
    name: "PostgreSQL",
    skip: POSTGRES_SKIP_REASON,
    async run(dir, capsule, clock, fn) {
      await withPostgresAdapter(async () => {}, { appTableNames: [tableName] });
      const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
      const database = await openDevDatabase(path.join(dir, "unused.db"), "", serverEnv, {
        name: capsule.name,
        services: { database: { kind: "database", engine: "postgres" } },
      }, capsule, { serviceEnv: serverEnv, clock });
      try { await fn(database); } finally { await database.close(); }
    },
  },
];

for (const engine of engines) {
  // Only bound real hangs; dispatch and settlement follow runtime signals, not elapsed time.
  test(`${engine.name} commits or rolls back payment intent and Job enqueue together before provider I/O`, { skip: engine.skip, timeout: 120_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-ticket08-payment-${engine.name.toLowerCase()}-`));
    const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
    let providerStarted;
    let releaseProvider;
    const began = new Promise((resolve) => { providerStarted = resolve; });
    const release = new Promise((resolve) => { releaseProvider = resolve; });
    const providerObservations = [];
    const capsule = {
      name: `ticket08-payment-${engine.name.toLowerCase()}`,
      schema: {
        [tableName]: table({ ownerId: Text(), intentId: Text(), productKey: Text(), quantity: Numeric(), status: Text() })
          .unique("ownerId", "intentId"),
      },
      queries: { paymentIntents: query((ctx) => ctx.db[tableName].orderBy("intentId", "asc").all()) },
      jobs: {
        stripeCheckout: job(async (ctx, input) => {
          providerObservations.push(await ctx.db[tableName].where("ownerId", ctx.auth.userId).where("intentId", input.intentId).get());
          providerStarted();
          await release;
          return { ok: true };
        }),
      },
      mutations: {
        startPayment: mutation(async (ctx, intentId) => {
          await ctx.db[tableName].insert({ ownerId: ctx.auth.userId, intentId, productKey: "starter", quantity: 1, status: "queued" });
          return await ctx.jobs.enqueue("stripeCheckout", { intentId }, { idempotencyKey: `checkout:${ctx.auth.userId}:${intentId}` });
        }),
        failPayment: mutation(async (ctx, intentId) => {
          await ctx.db[tableName].insert({ ownerId: ctx.auth.userId, intentId, productKey: "starter", quantity: 1, status: "queued" });
          await ctx.jobs.enqueue("stripeCheckout", { intentId }, { idempotencyKey: `checkout:${ctx.auth.userId}:${intentId}` });
          throw new Error("rollback payment intent and Job");
        }),
        writeWhileProviderWaits: mutation((ctx) => ctx.db[tableName].insert({ ownerId: ctx.auth.userId, intentId: "intent-concurrent", productKey: "audit", quantity: 1, status: "recorded" })),
      },
    };

    try {
      await engine.run(dir, capsule, clock, async (database) => {
        let draining;
        try {
          const sql = database.adapter.dialect.sql;
          await database.adapter.prepare(sql("INSERT INTO [sporades_auth_users] ([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
            .run(actor.userId, new Date().toISOString(), actor.displayName, null, null, 1, 0, actor.provider);
          await database.init();

          const started = await runMutation(database, actor, "startPayment", ["intent-success"]);
          assert.equal(started.ok, true, JSON.stringify(started));
          draining = clock.runDueTimers();
          await Promise.race([began, draining]);
          assert.equal(providerObservations[0]?.intentId, "intent-success", "provider I/O begins only after the payment intent commit is visible");

          const concurrent = await runMutation(database, actor, "writeWhileProviderWaits", []);
          assert.equal(concurrent.ok, true, JSON.stringify(concurrent));
          const rolledBack = await runMutation(database, actor, "failPayment", ["intent-rollback"]);
          assert.equal(rolledBack.ok, false);

          const rows = (await runQuery(database, actor, "paymentIntents", [])).data;
          assert.deepEqual(rows.map((row) => row.intentId), ["intent-concurrent", "intent-success"]);
          const paymentJobs = (await inspectRuntimeJobs(database.adapter)).filter((candidate) => candidate.handler === "stripeCheckout");
          assert.equal(paymentJobs.length, 1);
          assert.equal(paymentJobs[0].id, started.data.id);

          releaseProvider();
          await draining;
          const completed = (await inspectRuntimeJobs(database.adapter)).find((candidate) => candidate.id === started.data.id);
          assert.equal(completed?.status, "succeeded");
          assert.equal(completed.attempts, 1);
        } finally {
          releaseProvider();
          await draining;
        }
      });
    } finally {
      releaseProvider();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
