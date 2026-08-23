import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import Stripe from "stripe";
import {
  STRIPE_EVENT_JOB,
  STRIPE_EVENT_PAYLOAD_RETENTION_MS,
  cleanupExpiredStripeEventPayloads,
  createControllableRuntimeClock,
  ensureJobStorage,
  inspectRuntimeJobs,
  openDevDatabase,
  routeEndpoint,
  stripeEventPayloadRetentionDeadline,
} from "../dist/server-runtime-source.js";
import { stripeEvent as declareStripeEvent } from "../dist/server.js";
import { createStripeCallbackEndpoint } from "../dist/stripe-webhook-runtime.js";
import { DATABASE_ADAPTER_ENGINES } from "./support/database-adapter-engines.js";

const webhookSecret = "whsec_retention_fixture";
const serverEnv = { STRIPE_SECRET_KEY: "sk_test_retention_fixture", STRIPE_WEBHOOK_SECRET: webhookSecret };
const stripe = {
  enabled: true, secretKeyEnv: "STRIPE_SECRET_KEY", webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
  publicOrigin: "https://payments.example.test", callbackPath: "/stripe/webhook",
  apiVersion: "2026-07-29.dahlia", livemode: false, requestTimeoutMs: 10_000,
};

function responseCapture() {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  return { status: null, body: "", finished, writeHead(status) { this.status = status; }, end(body = "") { this.body += String(body); finish(); } };
}

function stripeEvent(providerEventId) {
  return JSON.stringify({
    id: providerEventId, object: "event", api_version: "2026-07-29.dahlia", created: 1_893_456_000,
    data: { object: { id: "cs_retention_secret", object: "checkout.session" } }, livemode: false,
    pending_webhooks: 1, request: null, type: "checkout.session.completed",
  });
}

function withMalformedSettlementRepairRace(adapter, id, repairedCompletedAt) {
  const prepare = adapter.prepare.bind(adapter);
  let repaired = false;
  return {
    ...adapter,
    dialect: adapter.dialect,
    prepare(statement) {
      const prepared = prepare(statement);
      if (!/SET\s+[\[\"]?payloadRetentionUntil[\]\"]?\s*=\s*''/i.test(String(statement))) return prepared;
      return {
        ...prepared,
        async run(...args) {
          if (!repaired && args[0] === id) {
            repaired = true;
            await prepare(adapter.dialect.sql(
              "UPDATE [sporades_jobs] SET [completedAt]=? WHERE [id]=? AND [payloadRetentionUntil] IS NULL",
            )).run(repairedCompletedAt, id);
          }
          return await prepared.run(...args);
        },
      };
    },
  };
}

async function postStripe(database, body) {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
  const request = Object.assign(Readable.from([body]), {
    method: "POST", url: "/stripe/webhook",
    headers: { "content-type": "application/json", "stripe-signature": signature },
  });
  const response = responseCapture();
  assert.equal(await routeEndpoint(database, request, response), true);
  await response.finished;
  return response;
}

async function insertReservedJob(adapter, row) {
  const sql = adapter.dialect.sql;
  const createdAt = row.createdAt ?? "2030-01-01T00:00:00.000Z";
  const completedAt = row.completedAt ?? (row.status === "succeeded" ? createdAt : null);
  await adapter.prepare(sql(
    "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], " +
    "[availableAt], [attempts], [idempotencyKey], [createdAt], [completedAt], [failedAt], [retryJson], [attemptHistory], " +
    "[payloadRetentionUntil], [payloadRedactedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )).run(
    row.id, STRIPE_EVENT_JOB, "__provider_callback__", "__privileged__", "privileged-server-role",
    JSON.stringify({ providerEventId: `evt_private_${row.id}`, raw: { secret: `raw_private_${row.id}` } }),
    row.status, row.availableAt ?? createdAt, row.attempts ?? 0, `stripe-event:digest-${row.id}`, createdAt,
    completedAt, row.failedAt ?? (["failed", "cancelled"].includes(row.status) ? createdAt : null),
    JSON.stringify({ maxAttempts: 5, delayMs: 1_000 }), "[]", row.payloadRetentionUntil ?? null, null,
  );
}

async function readStoredJob(adapter, id) {
  return await adapter.prepare(adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id]=?")).get(id);
}

async function readSentinelMaintenance(adapter) {
  const row = await adapter.prepare(adapter.dialect.sql(
    "SELECT [value] FROM [sporades] WHERE [key]='stripe-event-payload-retention-sentinel-cursor-v1'",
  )).get();
  return JSON.parse(row.value);
}

test("reserved Stripe Event payload retention is a fixed finite runtime contract", () => {
  assert.equal(STRIPE_EVENT_PAYLOAD_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(typeof cleanupExpiredStripeEventPayloads, "function");
  assert.equal(stripeEventPayloadRetentionDeadline("2030-01-01T00:00:00.000Z"), "2030-01-31T00:00:00.000Z");
  assert.equal(
    stripeEventPayloadRetentionDeadline("9999-12-15T00:00:00.000Z"),
    null,
    "an unrepresentable exact deadline remains unresolved instead of redacting early",
  );
});

for (const engine of DATABASE_ADAPTER_ENGINES) {
  test(`${engine.name}: cleanup is bounded, restart-safe, CAS-safe, and preserves unresolved Stripe work`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (initialAdapter, controls) => {
      let adapter = initialAdapter;
      await ensureJobStorage(adapter);
      const dueAt = "2030-01-31T00:00:00.000Z";
      const futureAt = "2030-02-01T00:00:00.000Z";
      for (const row of [
        { id: "due-a", status: "succeeded", payloadRetentionUntil: dueAt },
        { id: "due-b", status: "succeeded", payloadRetentionUntil: dueAt },
        { id: "due-c", status: "succeeded", payloadRetentionUntil: dueAt },
        { id: "future", status: "succeeded", payloadRetentionUntil: futureAt },
        { id: "queued", status: "queued" },
        { id: "delayed", status: "delayed", availableAt: futureAt },
        { id: "running", status: "running", attempts: 1 },
        { id: "failed", status: "failed", attempts: 5 },
        { id: "cancelled", status: "cancelled", attempts: 1 },
        { id: "malformed-settlement", status: "succeeded", completedAt: "not-a-timestamp" },
      ]) await insertReservedJob(adapter, row);

      const clock = createControllableRuntimeClock("2030-01-30T23:59:59.999Z");
      let database = { adapter, clock };
      assert.equal((await cleanupExpiredStripeEventPayloads(database, { batchSize: 2 })).redactedCount, 0);
      assert.match((await readStoredJob(adapter, "due-a")).payload, /raw_private_due-a/);

      adapter = await controls.restart();
      database = { adapter, clock };
      clock.advanceBy(1);
      const concurrent = await Promise.all([
        cleanupExpiredStripeEventPayloads(database, { batchSize: 2 }),
        cleanupExpiredStripeEventPayloads(database, { batchSize: 2 }),
      ]);
      assert.equal(concurrent.reduce((count, result) => count + result.redactedCount, 0), 2);
      assert.equal((await cleanupExpiredStripeEventPayloads(database, { batchSize: 2 })).redactedCount, 1);
      assert.equal((await cleanupExpiredStripeEventPayloads(database, { batchSize: 2 })).redactedCount, 0);

      for (const id of ["due-a", "due-b", "due-c"]) {
        const row = await readStoredJob(adapter, id);
        assert.deepEqual(JSON.parse(row.payload), { kind: "stripe-event", retained: false });
        assert.equal(row.result, null);
        assert.equal(row.payloadRedactedAt, dueAt);
        assert.equal(row.idempotencyKey, `stripe-event:digest-${id}`);
      }
      for (const id of ["future", "queued", "delayed", "running", "failed", "cancelled", "malformed-settlement"]) {
        assert.match((await readStoredJob(adapter, id)).payload, new RegExp(`raw_private_${id}`));
      }
      assert.equal((await readStoredJob(adapter, "malformed-settlement")).payloadRetentionUntil, "");
      const malformedInspection = (await inspectRuntimeJobs(adapter)).find((job) => job.id === "malformed-settlement");
      assert.deepEqual(malformedInspection.payloadRetention, {
        state: "unresolved",
        code: "INVALID_COMPLETED_AT",
        deadline: null,
      });
      assert.equal("payload" in malformedInspection, false);
      assert.doesNotMatch(JSON.stringify(malformedInspection), /evt_private|raw_private|providerEventId/);

      const replay = await adapter.prepare(adapter.dialect.sql(
        "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [payload], [status], [availableAt], [attempts], [idempotencyKey], [createdAt]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )).run("replayed", STRIPE_EVENT_JOB, "__provider_callback__", "__privileged__", "{}", "queued", dueAt, 0, "stripe-event:digest-due-a", dueAt);
      assert.equal(Number(replay?.changes ?? 0), 0);
      assert.equal((await readStoredJob(adapter, "due-a")).status, "succeeded");
    });
  });

  test(`${engine.name}: malformed settlement classification loses safely to canonical repair`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (adapter) => {
      await ensureJobStorage(adapter);
      await insertReservedJob(adapter, { id: "repair-race", status: "succeeded", completedAt: "not-a-timestamp" });
      const repairedCompletedAt = "2029-12-01T00:00:00.000Z";
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
      const raced = withMalformedSettlementRepairRace(adapter, "repair-race", repairedCompletedAt);

      const classified = await cleanupExpiredStripeEventPayloads({ adapter: raced, clock });
      assert.equal(classified.assignedCount, 1, "cleanup reselects after the stale malformed CAS loses");
      assert.equal(classified.redactedCount, 0);
      let stored = await readStoredJob(adapter, "repair-race");
      assert.equal(stored.completedAt, repairedCompletedAt);
      assert.equal(stored.payloadRetentionUntil, "2029-12-31T00:00:00.000Z");
      assert.match(stored.payload, /raw_private_repair-race/);

      const expired = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(expired.redactedCount, 1);
      stored = await readStoredJob(adapter, "repair-race");
      assert.deepEqual(JSON.parse(stored.payload), { kind: "stripe-event", retained: false });
      assert.equal(stored.payloadRedactedAt, "2030-01-01T00:00:00.000Z");
    });
  });

  test(`${engine.name}: a canonical repair after malformed classification re-enters retention`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (initialAdapter, controls) => {
      let adapter = initialAdapter;
      await ensureJobStorage(adapter);
      await insertReservedJob(adapter, { id: "classified-then-repaired", status: "succeeded", completedAt: "not-a-timestamp" });
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");

      const classified = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(classified.classifiedCount, 1);
      assert.equal(classified.nextCleanupAt, "2030-01-02T00:00:00.000Z", "still-malformed sentinels get one bounded daily safety scan");
      assert.equal((await readStoredJob(adapter, "classified-then-repaired")).payloadRetentionUntil, "");

      adapter = await controls.restart();
      await adapter.prepare(adapter.dialect.sql(
        "UPDATE [sporades_jobs] SET [completedAt]=? WHERE [id]=? AND [payloadRetentionUntil]=''",
      )).run("2029-12-01T00:00:00.000Z", "classified-then-repaired");
      const pendingRepair = (await inspectRuntimeJobs(adapter)).find((job) => job.id === "classified-then-repaired");
      assert.deepEqual(pendingRepair.payloadRetention, {
        state: "unresolved",
        code: "CANONICAL_REPAIR_PENDING",
        deadline: null,
      });

      clock.advanceBy(24 * 60 * 60 * 1_000);
      const repaired = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(repaired.assignedCount, 1);
      assert.equal(repaired.redactedCount, 0);
      assert.equal(repaired.nextCleanupAt, "2029-12-31T00:00:00.000Z");
      let stored = await readStoredJob(adapter, "classified-then-repaired");
      assert.equal(stored.payloadRetentionUntil, "2029-12-31T00:00:00.000Z");
      assert.match(stored.payload, /raw_private_classified-then-repaired/);
      assert.deepEqual((await inspectRuntimeJobs(adapter)).find((job) => job.id === "classified-then-repaired").payloadRetention, {
        state: "retained",
        deadline: "2029-12-31T00:00:00.000Z",
      });

      const concurrent = await Promise.all([
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
      ]);
      assert.equal(concurrent.reduce((count, result) => count + result.redactedCount, 0), 1);
      stored = await readStoredJob(adapter, "classified-then-repaired");
      assert.deepEqual(JSON.parse(stored.payload), { kind: "stripe-event", retained: false });
      assert.deepEqual((await inspectRuntimeJobs(adapter)).find((job) => job.id === "classified-then-repaired").payloadRetention, {
        state: "redacted",
        deadline: "2029-12-31T00:00:00.000Z",
        redactedAt: "2030-01-02T00:00:00.000Z",
      });
    });
  });

  test(`${engine.name}: durable sentinel scanning cannot starve a canonical repair`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (initialAdapter, controls) => {
      let adapter = initialAdapter;
      await ensureJobStorage(adapter);
      for (let index = 0; index < 225; index += 1) {
        await insertReservedJob(adapter, {
          id: `starve-invalid-${String(index).padStart(3, "0")}`,
          status: "succeeded",
          completedAt: "2029-02-31T00:00:00.000Z",
          payloadRetentionUntil: "",
        });
      }
      await insertReservedJob(adapter, {
        id: "starve-repaired-z",
        status: "succeeded",
        completedAt: "2029-12-01T00:00:00.000Z",
        payloadRetentionUntil: "",
      });
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");

      const first = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(first.assignedCount + first.classifiedCount + first.redactedCount, 0);
      assert.equal(first.nextCleanupAt, "2030-01-01T00:00:00.000Z", "a bounded next page re-arms immediately");
      const cursor = await adapter.prepare(adapter.dialect.sql(
        "SELECT [value] FROM [sporades] WHERE [key]='stripe-event-payload-retention-sentinel-cursor-v1'",
      )).get();
      assert.match(JSON.parse(cursor.value).afterId, /^starve-invalid-/);
      assert.doesNotMatch(cursor.value, /evt_|raw_private|providerEventId/);

      adapter = await controls.restart();
      const overlappingScans = await Promise.all([
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
      ]);
      assert.ok(overlappingScans.some((result) => result.nextCleanupAt !== null));
      if ((await readStoredJob(adapter, "starve-repaired-z")).payloadRetentionUntil === "") {
        await cleanupExpiredStripeEventPayloads({ adapter, clock });
      }
      assert.equal((await readStoredJob(adapter, "starve-repaired-z")).payloadRetentionUntil, "2029-12-31T00:00:00.000Z");
      assert.deepEqual((await inspectRuntimeJobs(adapter)).find((job) => job.id === "starve-repaired-z").payloadRetention, {
        state: "retained",
        deadline: "2029-12-31T00:00:00.000Z",
      });

      const concurrent = await Promise.all([
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
      ]);
      assert.equal(concurrent.reduce((count, result) => count + result.redactedCount, 0), 1);
      assert.deepEqual(JSON.parse((await readStoredJob(adapter, "starve-repaired-z")).payload), {
        kind: "stripe-event",
        retained: false,
      });
    });
  });

  test(`${engine.name}: periodic sentinel safety scans detect repairs behind and after cursor wrap`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (initialAdapter, controls) => {
      let adapter = initialAdapter;
      await ensureJobStorage(adapter);
      for (let index = 0; index < 225; index += 1) {
        await insertReservedJob(adapter, {
          id: `periodic-invalid-${String(index).padStart(3, "0")}`,
          status: "succeeded",
          completedAt: "2029-02-31T00:00:00.000Z",
          payloadRetentionUntil: "",
        });
      }
      await adapter.prepare(adapter.dialect.sql(
        "UPDATE [sporades] SET [value]=? WHERE [key]='stripe-event-payload-retention-sentinel-cursor-v1'",
      )).run("periodic-invalid-099");
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
      assert.equal((await cleanupExpiredStripeEventPayloads({ adapter, clock })).nextCleanupAt, "2030-01-01T00:00:00.000Z");
      await adapter.prepare(adapter.dialect.sql(
        "UPDATE [sporades_jobs] SET [completedAt]=? WHERE [id]=? AND [payloadRetentionUntil]=''",
      )).run("2029-12-01T00:00:00.000Z", "periodic-invalid-050");

      adapter = await controls.restart();
      await Promise.all([
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
      ]);
      let maintenance = await readSentinelMaintenance(adapter);
      for (let pass = 0; maintenance.recheckAt === null && pass < 4; pass += 1) {
        await cleanupExpiredStripeEventPayloads({ adapter, clock });
        maintenance = await readSentinelMaintenance(adapter);
      }
      assert.deepEqual(maintenance, { afterId: "", recheckAt: "2030-01-02T00:00:00.000Z" });
      assert.equal((await readStoredJob(adapter, "periodic-invalid-050")).payloadRetentionUntil, "");

      await adapter.prepare(adapter.dialect.sql(
        "UPDATE [sporades_jobs] SET [completedAt]=? WHERE [id]=? AND [payloadRetentionUntil]=''",
      )).run("2029-12-01T00:00:00.000Z", "periodic-invalid-060");
      adapter = await controls.restart();
      clock.advanceBy(24 * 60 * 60 * 1_000 - 1);
      const early = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(early.nextCleanupAt, "2030-01-02T00:00:00.000Z");
      assert.equal(early.assignedCount, 0, "restart before the safety deadline does not scan early");
      clock.advanceBy(1);
      const periodic = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.equal(periodic.assignedCount, 2);
      for (const id of ["periodic-invalid-050", "periodic-invalid-060"]) {
        assert.equal((await readStoredJob(adapter, id)).payloadRetentionUntil, "2029-12-31T00:00:00.000Z");
      }

      const concurrent = await Promise.all([
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
        cleanupExpiredStripeEventPayloads({ adapter, clock }),
      ]);
      assert.equal(concurrent.reduce((count, result) => count + result.redactedCount, 0), 2);
      for (const id of ["periodic-invalid-050", "periodic-invalid-060"]) {
        assert.deepEqual(JSON.parse((await readStoredJob(adapter, id)).payload), { kind: "stripe-event", retained: false });
      }
    });
  });

  test(`${engine.name}: one cleanup invocation shares its 100-row mutation budget`, { skip: engine.skip }, async () => {
    await engine.withAdapter(async (initialAdapter, controls) => {
      let adapter = initialAdapter;
      await ensureJobStorage(adapter);
      for (let index = 0; index < 60; index += 1) {
        await insertReservedJob(adapter, {
          id: `budget-due-${String(index).padStart(3, "0")}`,
          status: "succeeded",
          completedAt: "2029-11-01T00:00:00.000Z",
          payloadRetentionUntil: "2029-12-01T00:00:00.000Z",
        });
        await insertReservedJob(adapter, {
          id: `budget-unassigned-${String(index).padStart(3, "0")}`,
          status: "succeeded",
          completedAt: "2029-11-01T00:00:00.000Z",
        });
      }
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
      const first = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.deepEqual({ assigned: first.assignedCount, redacted: first.redactedCount }, { assigned: 40, redacted: 60 });
      assert.equal(first.assignedCount + first.redactedCount, 100);

      adapter = await controls.restart();
      const second = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.deepEqual({ assigned: second.assignedCount, redacted: second.redactedCount }, { assigned: 20, redacted: 40 });
      const third = await cleanupExpiredStripeEventPayloads({ adapter, clock });
      assert.deepEqual({ assigned: third.assignedCount, redacted: third.redactedCount }, { assigned: 0, redacted: 20 });
      assert.equal(third.nextCleanupAt, null);
      const retained = await adapter.prepare(adapter.dialect.sql(
        "SELECT [id] FROM [sporades_jobs] WHERE [handler]=? AND [payloadRedactedAt] IS NULL",
      )).all(STRIPE_EVENT_JOB);
      assert.deepEqual(retained, []);
    });
  });
}

test("automatic cleanup redacts a settled raw event at its deadline without rerunning replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-stripe-retention-runtime-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const providerEventId = "evt_retention_must_not_reach_logs";
  let applied = 0;
  const capsule = { stripeEvents: declareStripeEvent(() => { applied += 1; }) };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv,
    { name: "stripe-retention-runtime", payments: { stripe } }, capsule,
    { clock, createStripeCallbackEndpoint });
  try {
    await insertReservedJob(database.adapter, {
      id: "retained-before-restart",
      status: "succeeded",
      completedAt: "2029-12-01T00:00:00.000Z",
    });
    await database.init();
    await clock.runDueTimers();
    assert.deepEqual(JSON.parse((await readStoredJob(database.adapter, "retained-before-restart")).payload), {
      kind: "stripe-event", retained: false,
    });
    const body = stripeEvent(providerEventId);
    const first = await postStripe(database, body);
    const jobId = JSON.parse(first.body).jobId;
    await clock.runDueTimers();
    let stored = await readStoredJob(database.adapter, jobId);
    assert.equal(stored.status, "succeeded");
    assert.match(stored.payload, /cs_retention_secret/);
    assert.equal(stored.payloadRetentionUntil, "2030-01-31T00:00:00.000Z");

    clock.advanceBy(STRIPE_EVENT_PAYLOAD_RETENTION_MS - 1);
    await clock.runDueTimers();
    assert.match((await readStoredJob(database.adapter, jobId)).payload, /cs_retention_secret/);
    clock.advanceBy(1);
    await clock.runDueTimers();
    stored = await readStoredJob(database.adapter, jobId);
    assert.deepEqual(JSON.parse(stored.payload), { kind: "stripe-event", retained: false });
    assert.equal(stored.result, null);
    assert.equal(stored.payloadRedactedAt, "2030-01-31T00:00:00.000Z");

    const replay = await postStripe(database, body);
    assert.equal(JSON.parse(replay.body).jobId, jobId);
    await clock.runDueTimers();
    assert.equal(applied, 1);
    assert.equal((await inspectRuntimeJobs(database.adapter)).filter((job) => job.id === jobId).length, 1);
    assert.doesNotMatch(JSON.stringify(await database.adapter.readRecentLogEvents(200)), new RegExp(providerEventId));
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
