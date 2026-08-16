import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createControllableRuntimeClock, createPostgresDatabaseAdapter, enqueueScheduledOccurrence, openDevDatabase, replaceRuntimeDatabase } from "../dist/server-runtime-source.js";
import { job, mutation, schedule } from "../dist/server.js";
import { runMutation } from "../dist/server-runtime-source.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

async function seedRetainedScheduleGeneration(database, nextOccurrence) {
  const definition = database.schedules[0];
  const generationToken = `retained:${definition.name}:${nextOccurrence}`;
  const sql = database.adapter.dialect.sql;
  await database.adapter.prepare(sql(
    "INSERT INTO [sporades_schedules] ([name], [definitionFingerprint], [generationToken], [expression], [effectiveTimezone], [missedRunPolicy], [enabled], [nextOccurrence]) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
  )).run(definition.name, definition.fingerprint, generationToken, definition.expression, definition.effectiveTimezone, definition.missedRun, nextOccurrence);
  return generationToken;
}

test("far-future annual and monthly Schedules do not run before their nominal occurrence", async (t) => {
  for (const scenario of [
    { name: "annual", now: "2026-08-16T00:00:00.000Z", expression: "0 0 1 1 *" },
    { name: "monthly", now: "2030-01-01T00:00:01.000Z", expression: "0 0 1 * *" },
  ]) {
    await t.test(scenario.name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), `sporades-schedule-long-${scenario.name}-timer-`));
      const fixedNow = new Date(scenario.now);
      const clock = {
        now: () => new Date(fixedNow),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (timer) => clearTimeout(timer),
      };
      let executions = 0;
      const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: `scheduled-long-${scenario.name}-timer` }, {
        jobs: { work: job(() => { executions += 1; return null; }) },
        schedules: {
          longWait: schedule({ expression: scenario.expression, timezone: "UTC", job: "work" }),
        },
      }, { clock });
      try {
        await database.init();
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(executions, 0);
        assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
      } finally {
        await database.shutdown();
        await database.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("a far-future Schedule rechecks its occurrence after each native-timer chunk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-long-chunk-"));
  const clock = createControllableRuntimeClock("2026-08-16T00:00:00.000Z");
  let executions = 0;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-long-chunk" }, {
    jobs: { work: job(() => { executions += 1; return null; }) },
    schedules: { annual: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock });
  try {
    await database.init();
    const scheduledFor = Date.parse("2027-01-01T00:00:00.000Z");
    clock.advanceBy(2_147_483_647);
    await clock.runDueTimers();
    assert.equal(executions, 0);
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);

    clock.advanceBy(scheduledFor - clock.now().getTime());
    await clock.runDueTimers();
    assert.equal(executions, 1);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a distant retained occurrence claim is revisited after a bounded timer chunk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-retained-long-chunk-"));
  const controlled = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const armedDelays = [];
  const clock = {
    ...controlled,
    setTimer(callback, delayMs) {
      armedDelays.push(delayMs);
      return controlled.setTimer(callback, delayMs);
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-retained-long-chunk" }, {
    jobs: { work: job(() => null) },
    schedules: { annual: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock });
  try {
    const scheduledFor = "2030-01-02T00:00:00.000Z";
    const occurrenceId = createHash("sha256").update(JSON.stringify(["scheduled-retained-long-chunk", "annual", scheduledFor])).digest("hex");
    const createdAt = clock.now().toISOString();
    const generationToken = await seedRetainedScheduleGeneration(database, "2031-01-01T00:00:00.000Z");
    database.adapter.prepare(
      "INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, generationToken, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    ).run(
      occurrenceId,
      "annual",
      database.schedules[0].fingerprint,
      generationToken,
      scheduledFor,
      "prior-runtime-claim",
      "2031-01-01T00:00:00.000Z",
      createdAt,
      createdAt,
    );
    await database.init();
    assert.ok(armedDelays.length > 0);
    assert.equal(armedDelays.every((delayMs) => delayMs <= 2_147_483_647), true);

    clock.advanceBy(2_147_483_647);
    await clock.runDueTimers();

    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT status FROM sporades_schedule_occurrences WHERE id = ?").get(occurrenceId).status, "pending");
    assert.equal(armedDelays.every((delayMs) => delayMs <= 2_147_483_647), true);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a transient retained-occurrence recovery failure re-arms a bounded retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-recovery-retry-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-recovery-retry" }, {
    jobs: { work: job(() => null) },
    schedules: { retained: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock });
  try {
    const createdAt = clock.now().toISOString();
    const occurrenceId = createHash("sha256").update(JSON.stringify(["scheduled-recovery-retry", "retained", "2030-01-01T00:00:00.000Z"])).digest("hex");
    const generationToken = await seedRetainedScheduleGeneration(database, "2031-01-01T00:00:00.000Z");
    database.adapter.prepare(
      "INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, generationToken, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    ).run(occurrenceId, "retained", database.schedules[0].fingerprint, generationToken, "2030-01-01T00:00:00.000Z", "prior-runtime-claim", "2030-01-01T00:00:01.000Z", createdAt, createdAt);
    await database.init();

    const originalPrepare = database.adapter.prepare.bind(database.adapter);
    let failRecoveryOnce = true;
    database.adapter.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (failRecoveryOnce && String(sql).includes("sporades_schedule_occurrences") && String(sql).includes("status") && String(sql).includes("pending")) {
        return { ...statement, all(...args) { failRecoveryOnce = false; throw new Error("transient recovery read failure"); } };
      }
      return statement;
    };

    clock.advanceBy(1_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT status FROM sporades_schedule_occurrences WHERE id=?").get(occurrenceId).status, "pending");
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    assert.ok(database.__scheduleRecoveryTimer);
    assert.equal(database.__scheduleRecoveryDueAt, Date.parse("2030-01-01T00:00:02.000Z"));

    clock.advanceBy(1_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT status FROM sporades_schedule_occurrences WHERE id=?").get(occurrenceId).status, "enqueued");
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close awaits an active retained-occurrence recovery before closing its adapter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-recovery-close-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-recovery-close" }, {
    jobs: { work: job(() => null) },
    schedules: { retained: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock });
  let releaseRecovery;
  let markRecoveryStarted;
  let closeCompleted = false;
  const recoveryStarted = new Promise((resolve) => { markRecoveryStarted = resolve; });
  try {
    const scheduledFor = "2030-01-01T00:00:00.000Z";
    const occurrenceId = createHash("sha256").update(JSON.stringify(["scheduled-recovery-close", "retained", scheduledFor])).digest("hex");
    const createdAt = clock.now().toISOString();
    const generationToken = await seedRetainedScheduleGeneration(database, "2031-01-01T00:00:00.000Z");
    database.adapter.prepare(
      "INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, generationToken, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    ).run(occurrenceId, "retained", database.schedules[0].fingerprint, generationToken, scheduledFor, "prior-runtime-claim", "2030-01-01T00:00:01.000Z", createdAt, createdAt);
    await database.init();
    const originalPrepare = database.adapter.prepare.bind(database.adapter);
    let pauseRecovery = true;
    database.adapter.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (pauseRecovery && String(sql).includes("sporades_schedule_occurrences") && String(sql).includes("status") && String(sql).includes("pending")) {
        return { ...statement, async all(...args) {
          pauseRecovery = false;
          markRecoveryStarted();
          await new Promise((resolve) => { releaseRecovery = resolve; });
          return statement.all(...args);
        } };
      }
      return statement;
    };

    clock.advanceBy(1_000);
    const recovering = clock.runDueTimers();
    await recoveryStarted;
    const closing = Promise.resolve(database.close()).then(() => { closeCompleted = true; });
    await Promise.resolve();
    assert.equal(closeCompleted, false);
    releaseRecovery();
    await recovering;
    await closing;
    assert.equal(closeCompleted, true);
  } finally {
    releaseRecovery?.();
    if (!closeCompleted) await Promise.resolve(database.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("retained Schedule occurrences with malformed timestamps become opaque terminal failures", async (t) => {
  for (const scenario of [
    { name: "claim expiry", scheduledFor: "2030-01-01T00:00:00.000Z", claimExpiresAt: "not-a-timestamp" },
    { name: "scheduled instant", scheduledFor: "not-a-timestamp", claimExpiresAt: null },
  ]) {
    await t.test(scenario.name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-malformed-retained-"));
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
      const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-malformed-retained" }, {
        jobs: { work: job(() => null) },
        schedules: { retained: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
      }, { clock });
      const occurrenceId = createHash("sha256").update(JSON.stringify(["scheduled-malformed-retained", "retained", scenario.scheduledFor])).digest("hex");
      try {
        const createdAt = clock.now().toISOString();
        const generationToken = await seedRetainedScheduleGeneration(database, "2031-01-01T00:00:00.000Z");
        database.adapter.prepare(
          "INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, generationToken, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        ).run(occurrenceId, "retained", database.schedules[0].fingerprint, generationToken, scenario.scheduledFor, "prior-runtime-claim", scenario.claimExpiresAt, createdAt, createdAt);

        await database.init();

        assert.deepEqual({ ...database.adapter.prepare("SELECT status, claimToken, claimExpiresAt, jobId, errorCode FROM sporades_schedule_occurrences WHERE id=?").get(occurrenceId) }, {
          status: "enqueue-failed",
          claimToken: null,
          claimExpiresAt: null,
          jobId: null,
          errorCode: "SCHEDULE_OCCURRENCE_INVALID",
        });
        assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
      } finally {
        await database.shutdown();
        await database.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("a retained Schedule occurrence with a mismatched deterministic identity is quarantined", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-mismatched-retained-identity-"));
  const clock = createControllableRuntimeClock("2029-12-31T23:59:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-mismatched-retained-identity" }, {
    jobs: { work: job(() => null) },
    schedules: { retained: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock });
  try {
    const createdAt = clock.now().toISOString();
    const generationToken = await seedRetainedScheduleGeneration(database, "2030-01-01T00:00:00.000Z");
    database.adapter.prepare(
      "INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, generationToken, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    ).run("not-the-deterministic-id", "retained", database.schedules[0].fingerprint, generationToken, "2030-01-01T00:00:00.000Z", "prior-runtime-claim", null, createdAt, createdAt);

    await database.init();

    assert.deepEqual({ ...database.adapter.prepare(
      "SELECT status, claimToken, claimExpiresAt, jobId, errorCode FROM sporades_schedule_occurrences WHERE id=?",
    ).get("not-the-deterministic-id") }, {
      status: "enqueue-failed",
      claimToken: null,
      claimExpiresAt: null,
      jobId: null,
      errorCode: "SCHEDULE_OCCURRENCE_INVALID",
    });
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL quarantines a retained Schedule occurrence with a mismatched deterministic identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-mismatched-retained-identity-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const clock = createControllableRuntimeClock("2029-12-31T23:59:30.000Z");
      const config = { name: "scheduled-mismatched-retained-identity-libsql", services: { database: { kind: "database", engine: "libsql" } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      const database = await openDevDatabase(path.join(dir, "unused.db"), "", {}, config, {
        jobs: { work: job(() => null) },
        schedules: { retainedLibsql: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
      }, { clock, serviceEnv });
      try {
        const sql = database.adapter.dialect.sql;
        const createdAt = clock.now().toISOString();
        const generationToken = await seedRetainedScheduleGeneration(database, "2030-01-01T00:00:00.000Z");
        await database.adapter.prepare(sql(
          "INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        )).run("not-the-deterministic-libsql-id", "retainedLibsql", database.schedules[0].fingerprint, generationToken, "2030-01-01T00:00:00.000Z", "prior-runtime-claim", null, createdAt, createdAt);

        await database.init();

        assert.deepEqual(await database.adapter.prepare(sql(
          "SELECT [status], [claimToken], [claimExpiresAt], [jobId], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?",
        )).get("not-the-deterministic-libsql-id"), {
          status: "enqueue-failed", claimToken: null, claimExpiresAt: null, jobId: null, errorCode: "SCHEDULE_OCCURRENCE_INVALID",
        });
        clock.advanceBy(30_000);
        await clock.runDueTimers();
        assert.equal(Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_jobs]")).get()).count), 0);
      } finally {
        await database.shutdown();
        await database.close();
      }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Postgres quarantines a retained Schedule occurrence with a mismatched deterministic identity", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres retained-occurrence test." }, async () => {
  const clock = createControllableRuntimeClock("2029-12-31T23:59:30.000Z");
  const config = { name: "scheduled-mismatched-retained-identity-postgres", services: { database: { kind: "database", engine: "postgres" } } };
  const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  const database = await openDevDatabase("unused.db", "", {}, config, {
    jobs: { work: job(() => null) },
    schedules: { retainedPostgres: schedule({ expression: "0 0 1 1 *", timezone: "UTC", job: "work" }) },
  }, { clock, serviceEnv });
  const sql = database.adapter.dialect.sql;
  try {
    await database.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run("retainedPostgres");
    await database.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run("retainedPostgres");
    await database.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run("retainedPostgres");
    const createdAt = clock.now().toISOString();
    const generationToken = await seedRetainedScheduleGeneration(database, "2030-01-01T00:00:00.000Z");
    await database.adapter.prepare(sql(
      "INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    )).run("not-the-deterministic-postgres-id", "retainedPostgres", database.schedules[0].fingerprint, generationToken, "2030-01-01T00:00:00.000Z", "prior-runtime-claim", null, createdAt, createdAt);

    await database.init();

    assert.deepEqual(await database.adapter.prepare(sql(
      "SELECT [status], [claimToken], [claimExpiresAt], [jobId], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?",
    )).get("not-the-deterministic-postgres-id"), {
      status: "enqueue-failed", claimToken: null, claimExpiresAt: null, jobId: null, errorCode: "SCHEDULE_OCCURRENCE_INVALID",
    });
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.equal(Number((await database.adapter.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [scheduleName]=?")).get("retainedPostgres")).count), 0);
  } finally {
    await database.shutdown();
    await database.close();
  }
});

test("a matching static Schedule enqueues and runs one ordinary Privileged Job", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const seen = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: {
      maintain: job((ctx, payload) => {
        seen.push({ userId: ctx.auth.userId, payload });
        return null;
      }),
    },
    schedules: {
      everyMinute: schedule({ expression: "* * * * *", job: "maintain", payload: { source: "static" } }),
    },
  }, { clock });

  try {
    assert.equal(database.__scheduleTimers, undefined);
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [{ userId: "__privileged__", payload: { source: "static" } }]);

    const rows = database.adapter.prepare("SELECT * FROM sporades_jobs").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduleName, "everyMinute");
    assert.equal(rows[0].scheduledFor, "2030-01-01T00:01:00.000Z");
  } finally {
    await database.shutdown();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Privileged Schedule inspection is bounded, ordered, correlated, and side-effect free", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-inspection-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const audits = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => null) },
    schedules: {
      zeta: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "work", payload: { secret: "never-return-me" }, missedRun: "latest" }),
      alpha: schedule({ expression: "0 9 * * *", timezone: "UTC", job: "work", enabled: false }),
    },
    mutations: {
      inspect: mutation((ctx) => ctx.privileged.run({ operation: "test.inspect", targetResourceKind: "schedule-store" }, async (privilegedCtx) => ({
        one: await privilegedCtx.schedules.get("zeta"),
        missing: await privilegedCtx.schedules.get("missing"),
        all: await privilegedCtx.schedules.list(),
      }))),
      inspectJob: mutation((ctx, id) => ctx.privileged.run({ operation: "test.inspect-job", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.get(id))),
      ordinaryJob: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  }, { clock });
  try {
    await database.init();
    const originalEmit = database.audit.emit.bind(database.audit);
    database.audit.emit = async (details) => { audits.push(details); return originalEmit(details); };
    const beforeJobs = database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count;
    const result = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.all.map((entry) => entry.name), ["alpha", "zeta"]);
    assert.deepEqual(result.data.one, {
      name: "zeta", expression: "*/5 * * * *", timezone: "UTC", missedRun: "latest", enabled: true,
      nextOccurrence: "2030-01-01T00:05:00.000Z", latestOccurrence: null,
    });
    assert.deepEqual(result.data.all[0], {
      name: "alpha", expression: "0 9 * * *", timezone: "UTC", missedRun: "skip", enabled: false,
      nextOccurrence: null, latestOccurrence: null,
    });
    assert.equal(result.data.missing, null);
    assert.doesNotMatch(JSON.stringify(result.data), /never-return-me|definitionFingerprint|claim|idempotency/i);
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, beforeJobs);
    assert.equal(audits.every((entry) => entry.operation === "test.inspect"), true);

    database.adapter.prepare("UPDATE sporades_schedules SET latestScheduledFor=?, latestOutcome='payload-failed', latestErrorCode=? WHERE name='zeta'").run("2030-01-01T00:00:00.000Z", "SCHEDULE_PAYLOAD_FAILED");
    const failed = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
    assert.deepEqual(failed.data.one.latestOccurrence, { scheduledFor: "2030-01-01T00:00:00.000Z", outcome: "payload-failed", errorCode: "SCHEDULE_PAYLOAD_FAILED" });

    const assertInvalidInspection = async (values) => {
      database.adapter.prepare("UPDATE sporades_schedules SET latestScheduledFor=?, latestOutcome=?, latestJobId=?, latestErrorCode=? WHERE name='zeta'").run(...values);
      const invalid = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, "PRIVILEGED_RUN_FAILED");
    };
    database.adapter.prepare("INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory, scheduleName, scheduledFor) VALUES ('unrelated', 'work', '__privileged__', '__privileged__', 'null', 'queued', ?, 0, ?, '{\"maxAttempts\":1,\"delayMs\":0}', '[]', 'other', '2030-01-01T00:00:00.000Z')").run(clock.now().toISOString(), clock.now().toISOString());
    await assertInvalidInspection(["2030-01-01T00:00:00.000Z", "enqueued", "unrelated", null]);
    await assertInvalidInspection(["2030-01-01T00:00:00.000Z", "enqueued", "unrelated", "STALE_ERROR"]);
    await assertInvalidInspection(["2030-01-01T00:00:00.000Z", "payload-failed", "unrelated", "SCHEDULE_PAYLOAD_FAILED"]);
    await assertInvalidInspection(["2030-01-01T00:00:00.000Z", "payload-failed", null, "SECRET_database_password"]);
    await assertInvalidInspection(["0", "payload-failed", null, "SCHEDULE_PAYLOAD_FAILED"]);
    await assertInvalidInspection(["2030-01-01", "payload-failed", null, "SCHEDULE_PAYLOAD_FAILED"]);
    for (const noncanonical of ["0", "2030-01-01"]) {
      database.adapter.prepare("UPDATE sporades_schedules SET nextOccurrence=?, latestScheduledFor=NULL, latestOutcome=NULL, latestJobId=NULL, latestErrorCode=NULL WHERE name='zeta'").run(noncanonical);
      const invalid = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
      assert.equal(invalid.ok, false);
    }
    database.adapter.prepare("DELETE FROM sporades_jobs WHERE id='unrelated'").run();

    clock.advanceBy(270_000); await clock.runDueTimers();
    const latest = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
    const jobId = database.adapter.prepare("SELECT id FROM sporades_jobs").get().id;
    assert.deepEqual(latest.data.one.latestOccurrence, { scheduledFor: "2030-01-01T00:05:00.000Z", outcome: "enqueued", jobId });
    const correlated = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspectJob", [jobId]);
    assert.deepEqual(correlated.data.enqueuedBy, { mode: "schedule", scheduleName: "zeta", scheduledFor: "2030-01-01T00:05:00.000Z" });
    assert.equal("schedule" in correlated.data, false);
    const ordinary = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "ordinaryJob", [jobId]);
    assert.equal(ordinary.data, null);
    const executionAudit = audits.find((entry) => entry.operation === "jobs.execute" && entry.outcome === "started");
    assert.equal(executionAudit.metadata.scheduleName, "zeta");
    assert.equal(executionAudit.metadata.scheduledFor, "2030-01-01T00:05:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a Schedule matches wall-clock fields in its explicit IANA timezone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-timezone-"));
  const clock = createControllableRuntimeClock("2030-01-01T16:59:30.000Z");
  const seen = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job((_ctx, payload) => { seen.push(payload); return null; }) },
    schedules: { localMorning: schedule({ expression: "0 9 * * *", timezone: "America/Los_Angeles", job: "record" }) },
  }, { clock });
  try {
    await database.init();
    assert.equal(database.schedules[0].effectiveTimezone, "America/Los_Angeles");
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [null]);
    assert.equal(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2030-01-01T17:00:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Schedule timezone evaluation covers offsets and calendar boundaries", async () => {
  const cases = [
    ["normal offset", "2030-01-15T07:59:30.000Z", "0 9 * * *", "Europe/Berlin", "2030-01-15T08:00:00.000Z"],
    ["non-hour offset", "2030-01-15T03:14:30.000Z", "0 9 * * *", "Asia/Kathmandu", "2030-01-15T03:15:00.000Z"],
    ["month boundary", "2030-01-31T23:59:30.000Z", "0 0 1 * *", "UTC", "2030-02-01T00:00:00.000Z"],
    ["leap day", "2032-02-28T23:59:30.000Z", "0 0 29 2 *", "UTC", "2032-02-29T00:00:00.000Z"],
  ];
  for (const [label, start, expression, timezone, expected] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-calendar-"));
    const clock = createControllableRuntimeClock(start);
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
      jobs: { record: job(() => null) }, schedules: { calendar: schedule({ expression, timezone, job: "record" }) },
    }, { clock });
    try {
      await database.init(); clock.advanceBy(30_000); await clock.runDueTimers();
      assert.equal(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, expected, label);
    } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test("leap-day scheduling crosses a non-leap Gregorian century", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-century-leap-"));
  const clock = createControllableRuntimeClock("2096-02-29T00:00:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) }, schedules: { leapDay: schedule({ expression: "0 0 29 2 *", timezone: "UTC", job: "record" }) },
  }, { clock });
  try {
    await database.init();
    clock.setInstant("2104-02-29T00:00:00.000Z");
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2104-02-29T00:00:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cron day-of-month and day-of-week use OR when both are restricted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-day-or-"));
  const clock = createControllableRuntimeClock("2030-06-02T23:59:30.000Z"); // Monday follows; not the first of the month.
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) }, schedules: { dayOr: schedule({ expression: "0 0 1 * 1", timezone: "UTC", job: "record" }) },
  }, { clock });
  try {
    await database.init(); clock.advanceBy(30_000); await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2030-06-03T00:00:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("spring-forward nonexistent wall time is skipped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-spring-"));
  const clock = createControllableRuntimeClock("2024-03-10T06:59:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) }, schedules: { twoThirty: schedule({ expression: "30 2 * * *", timezone: "America/New_York", job: "record" }) },
  }, { clock });
  try {
    await database.init(); clock.advanceBy((23 * 60 + 30) * 60 * 1000 + 30_000); await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2024-03-11T06:30:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("fall-back repeated wall time produces two distinct UTC occurrences", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-fall-"));
  const clock = createControllableRuntimeClock("2024-11-03T05:29:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) }, schedules: { oneThirty: schedule({ expression: "30 1 * * *", timezone: "America/New_York", job: "record" }) },
  }, { clock });
  try {
    await database.init(); clock.advanceBy(30_000); await clock.runDueTimers();
    clock.advanceBy(60 * 60 * 1000); await clock.runDueTimers();
    const occurrences = database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs ORDER BY scheduledFor").all().map((row) => row.scheduledFor);
    assert.deepEqual(occurrences, ["2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z"]);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("omitted timezone resolves from the runtime and invalid timezones reject startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-default-timezone-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) }, schedules: { serverLocal: schedule({ expression: "* * * * *", job: "record" }) },
  });
  try {
    assert.equal(database.schedules[0].effectiveTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }

  for (const timezone of ["Not/A_Timezone", "", 42]) {
    const invalidDir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-invalid-timezone-"));
    await assert.rejects(openDevDatabase(path.join(invalidDir, "data.db"), "", {}, { name: "scheduled" }, {
      jobs: { record: job(() => null) }, schedules: { invalid: schedule({ expression: "* * * * *", timezone, job: "record" }) },
    }), /Invalid Schedule timezone/);
    await rm(invalidDir, { recursive: true, force: true });
  }
});

test("Schedule payload factories receive immutable occurrence input and resolve ordinary Job payloads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const seen = [];
  const factoryCalls = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job((_ctx, payload) => { seen.push(payload); return null; }) },
    schedules: {
      dynamic: schedule({
        expression: "* * * * *",
        job: "record",
        payloadVersion: "generated-for-v1",
        payload: async (occurrence, ctx) => {
          factoryCalls.push({ occurrence, keys: Object.keys(ctx).sort(), aborted: ctx.signal.aborted });
          return { generatedFor: occurrence.scheduledFor };
        },
      }),
    },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [{ generatedFor: "2030-01-01T00:01:00.000Z" }]);
    assert.deepEqual(factoryCalls.map(({ occurrence, keys, aborted }) => ({ occurrence, keys, aborted })), [{
      occurrence: { scheduleName: "dynamic", scheduledFor: "2030-01-01T00:01:00.000Z" },
      keys: ["privileged", "signal"],
      aborted: false,
    }]);
    assert.equal(Object.isFrozen(factoryCalls[0].occurrence), true);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Schedule payload factories may explicitly enter Privileged access without implicit calculation audit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-privileged-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: {
      plain: schedule({ expression: "* * * * *", job: "record", payloadVersion: "plain-v1", payload: () => ({ kind: "plain" }) }),
      explicit: schedule({ expression: "* * * * *", job: "record", payloadVersion: "explicit-v1", payload: (_occurrence, ctx) => ctx.privileged.run({ operation: "schedules.payload.read", targetResourceKind: "database" }, () => ({ kind: "explicit" })) }),
    },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    const audits = await database.adapter.readRecentLogEvents(50);
    assert.deepEqual(audits.filter((event) => event.category === "audit" && event.data?.outcome === "started" && event.data?.operation?.startsWith("schedules.")).map((event) => event.data.operation), [
      "schedules.enqueue", "schedules.payload.read", "schedules.enqueue",
    ]);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("payload factory failures skip one occurrence safely and re-arm the Schedule", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-failure-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let calls = 0;
  const seen = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job((_ctx, payload) => { seen.push(payload); return null; }) },
    schedules: { resilient: schedule({ expression: "* * * * *", job: "record", payloadVersion: "resilient-v1", payload: async () => { calls += 1; if (calls === 1) throw new Error("secret detail"); return { calls }; } }) },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, []);
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [{ calls: 2 }]);
    const logs = await database.adapter.readRecentLogEvents(20);
    const failure = logs.find((entry) => entry.event === "schedule.occurrence.payload_failed");
    assert.deepEqual(failure.data, { scheduleName: "resilient", scheduledFor: "2030-01-01T00:01:00.000Z", code: "SCHEDULE_PAYLOAD_FACTORY_FAILED" });
    assert.equal(JSON.stringify(failure).includes("secret detail"), false);
    assert.equal(database.schedulePayloadFactoryLanes.size, 0);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rejected and invalid resolved factory payloads create no Job", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-invalid-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: {
      rejected: schedule({ expression: "* * * * *", job: "record", payloadVersion: "rejected-v1", payload: () => Promise.reject(new Error("private rejection")) }),
      invalid: schedule({ expression: "* * * * *", job: "record", payloadVersion: "invalid-v1", payload: () => ({ value: 1n }) }),
    },
  }, { clock });
  try {
    await Promise.all(database.schedules.map((definition) => enqueueScheduledOccurrence(database, definition, new Date("2030-01-01T00:01:00.000Z"))));
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    assert.equal(database.schedulePayloadFactoryLanes.size, 0);
    const failures = (await database.adapter.readRecentLogEvents(20)).filter((entry) => entry.event === "schedule.occurrence.payload_failed");
    assert.deepEqual(failures.map((entry) => entry.data.code).sort(), ["SCHEDULE_PAYLOAD_FACTORY_FAILED", "SCHEDULE_PAYLOAD_INVALID_JOB_PAYLOAD"]);
    assert.equal(JSON.stringify(failures).includes("private rejection"), false);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("payload factory timeout aborts cooperatively and discards a late result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-timeout-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let signal;
  let resolveFactory;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled", scheduling: { payloadFactoryTimeoutSeconds: 1 } }, {
    jobs: { record: job(() => null) },
    schedules: { slow: schedule({ expression: "* * * * *", job: "record", payloadVersion: "slow-v1", payload: (_occurrence, ctx) => { signal = ctx.signal; return new Promise((resolve) => { resolveFactory = resolve; }); } }) },
  }, { clock });
  try {
    const pending = enqueueScheduledOccurrence(database, database.schedules[0], new Date("2030-01-01T00:01:00.000Z"));
    while (!signal) await Promise.resolve();
    assert.equal(signal.aborted, false);
    clock.advanceBy(1_000);
    await clock.runDueTimers();
    await pending;
    assert.equal(signal.aborted, true);
    resolveFactory({ late: true });
    await Promise.resolve();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("payload factories use four FIFO Capsule-wide slots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-concurrency-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const started = [];
  const releases = [];
  const schedules = {};
  const jobs = {};
  for (let index = 0; index < 6; index += 1) {
    const name = `schedule${index}`;
    jobs[name] = job(() => null);
    schedules[name] = schedule({ expression: "* * * * *", job: name, payloadVersion: "1", payload: () => new Promise((resolve) => { started.push(name); releases.push(() => resolve({ name })); }) });
  }
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, { jobs, schedules }, { clock });
  try {
    const pending = database.schedules.map((definition) => enqueueScheduledOccurrence(database, definition, new Date("2030-01-01T00:01:00.000Z")));
    while (started.length < 4) await Promise.resolve();
    assert.deepEqual(started, ["schedule0", "schedule1", "schedule2", "schedule3"]);
    releases.shift()();
    while (started.length < 5) await Promise.resolve();
    assert.deepEqual(started, ["schedule0", "schedule1", "schedule2", "schedule3", "schedule4"]);
    for (const release of releases.splice(0)) release();
    while (started.length < 6) await Promise.resolve();
    for (const release of releases.splice(0)) release();
    await Promise.all(pending);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown removes a queued fifth payload factory without starting it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-shutdown-queue-"));
  let nowMs = Date.parse("2030-01-01T00:00:30.000Z");
  let nextTimerId = 1;
  const timers = new Map();
  const clock = {
    now: () => new Date(nowMs),
    setTimer(callback, delayMs) {
      const id = nextTimerId++;
      timers.set(id, { id, dueAt: nowMs + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advanceBy(delayMs) { nowMs += delayMs; },
    async runDueTimers() {
      while (true) {
        const due = [...timers.values()].filter((timer) => timer.dueAt <= nowMs)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
        if (due.length === 0) return;
        for (const timer of due) timers.delete(timer.id);
        await Promise.all(due.map((timer) => timer.callback()));
      }
    },
  };
  const started = [];
  const releases = [];
  const schedules = {};
  const jobs = {};
  for (let index = 0; index < 5; index += 1) {
    const name = `shutdown${index}`;
    jobs[name] = job(() => null);
    schedules[name] = schedule({
      expression: "* * * * *",
      job: name,
      payloadVersion: "1",
      payload: () => new Promise((resolve) => {
        started.push(name);
        releases.push(() => resolve({ name }));
      }),
    });
  }
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-factory-shutdown-queue" }, { jobs, schedules }, { clock });
  let dueWork;
  let closing;
  try {
    await database.init();
    clock.advanceBy(30_000);
    dueWork = clock.runDueTimers();
    while (started.length < 4) await Promise.resolve();
    assert.deepEqual(started, ["shutdown0", "shutdown1", "shutdown2", "shutdown3"]);

    let closed = false;
    closing = database.shutdown().then(() => { closed = true; });
    for (let turn = 0; turn < 20 && !closed; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(closed, true);
    assert.deepEqual(started, ["shutdown0", "shutdown1", "shutdown2", "shutdown3"]);
    await dueWork;
  } finally {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of releases.splice(0)) release();
    await Promise.allSettled([closing, dueWork]);
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent occurrences of one Schedule serialize payload factory evaluation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-lane-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: { serial: schedule({ expression: "* * * * *", job: "record", payloadVersion: "serial-v1", payload: () => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => { active -= 1; resolve(null); });
    }) }) },
  }, { clock });
  try {
    const definition = database.schedules[0];
    const pending = [
      enqueueScheduledOccurrence(database, definition, new Date("2030-01-01T00:01:00.000Z")),
      enqueueScheduledOccurrence(database, definition, new Date("2030-01-01T00:02:00.000Z")),
    ];
    while (releases.length < 1) await Promise.resolve();
    await Promise.resolve();
    assert.equal(releases.length, 1);
    releases.shift()();
    while (releases.length < 1) await Promise.resolve();
    releases.shift()();
    await Promise.all(pending);
    assert.equal(maxActive, 1);
    assert.equal(database.schedulePayloadFactoryLanes.size, 0);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("payload factory timeout configuration defaults to 30 seconds and validates 1 through 300", async () => {
  const valid = [undefined, 1, 300];
  for (const seconds of valid) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-config-"));
    const config = seconds === undefined ? { name: "scheduled" } : { name: "scheduled", scheduling: { payloadFactoryTimeoutSeconds: seconds } };
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, config);
    assert.equal(database.schedulePayloadFactoryTimeoutMs, (seconds ?? 30) * 1000);
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
  for (const value of [0, 301, 1.5, Number.NaN, "30"]) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-config-invalid-"));
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { scheduling: { payloadFactoryTimeoutSeconds: value } }), /Invalid Schedule payload factory timeout/);
    await rm(dir, { recursive: true, force: true });
  }
});

test("static Schedules default payload to null and disabled declarations remain inactive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-defaults-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const seen = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job((_ctx, payload) => { seen.push(payload); return null; }) },
    schedules: {
      active: schedule({ expression: "*/1 * * * *", job: "record" }),
      dormant: schedule({ expression: "0-59/1 * * * *", job: "record", payload: "nope", enabled: false }),
    },
  }, { clock });
  try {
    await database.init();
    assert.deepEqual(database.schedules.map(({ name, enabled }) => ({ name, enabled })), [{ name: "active", enabled: true }, { name: "dormant", enabled: false }]);
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [null]);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Schedule restart recovery persists state and applies skip or latest without backfilling", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-recovery-"));
  const file = path.join(dir, "data.db");
  const definition = (missedRun) => ({
    jobs: { record: job(() => null) },
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", missedRun }) },
  });
  for (const [policy, expected] of [["skip", []], ["latest", ["2030-01-01T00:03:00.000Z"]]]) {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
    let database = await openDevDatabase(file, "", {}, { name: "scheduled" }, definition(policy), { clock });
    await database.init();
    await database.shutdown();
    database.close();
    clock.advanceBy(180_000);
    database = await openDevDatabase(file, "", {}, { name: "scheduled" }, definition(policy), { clock });
    try {
      await database.init();
      await clock.runDueTimers();
      const rows = await database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs WHERE scheduleName='recurring' ORDER BY scheduledFor").all();
      assert.deepEqual(rows.map((row) => row.scheduledFor), expected);
      const state = await database.adapter.prepare("SELECT nextOccurrence, missedRunPolicy, enabled FROM sporades_schedules WHERE name='recurring'").get();
      assert.deepEqual({ ...state }, { nextOccurrence: "2030-01-01T00:04:00.000Z", missedRunPolicy: policy, enabled: 1 });
    } finally { await database.shutdown(); database.close(); }
  }
  await rm(dir, { recursive: true, force: true });
});

test("an armed Schedule timer keeps its intended occurrence identity when it fires late", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-late-timer-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: { late: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", missedRun: "skip" }) },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(150_000);
    await clock.runDueTimers();
    const row = await database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs WHERE scheduleName='late'").get();
    assert.equal(row.scheduledFor, "2030-01-01T00:01:00.000Z");
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Schedule reconciliation treats changes and re-enabling as future-only and removal forgets state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-reconcile-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const open = (schedules) => openDevDatabase(file, "", {}, { name: "scheduled" }, { jobs: { record: job(() => null) }, schedules }, { clock });
  let database = await open({ kept: schedule({ expression: "* * * * *", job: "record", enabled: false }) });
  await database.init(); await database.shutdown(); database.close();
  clock.advanceBy(180_000);
  database = await open({ kept: schedule({ expression: "*/2 * * * *", job: "record", enabled: true }) });
  await database.init();
  let state = await database.adapter.prepare("SELECT enabled, nextOccurrence FROM sporades_schedules WHERE name='kept'").get();
  assert.deepEqual({ ...state }, { enabled: 1, nextOccurrence: "2030-01-01T00:04:00.000Z" });
  await database.shutdown(); database.close();
  database = await open({ renamed: schedule({ expression: "* * * * *", job: "record" }) });
  try {
    await database.init();
    const names = await database.adapter.prepare("SELECT name FROM sporades_schedules ORDER BY name").all();
    assert.deepEqual(names.map((row) => row.name), ["renamed"]);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("payload factory versions distinguish declarations with identical source and changed captured values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-payload-version-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const config = { name: "scheduled-payload-version" };
  const payloadFactory = (version) => () => ({ version });
  const open = (version) => openDevDatabase(file, "", {}, config, {
    jobs: { record: job(() => null) },
    schedules: {
      recurring: schedule({
        expression: "* * * * *",
        timezone: "UTC",
        job: "record",
        payload: payloadFactory(version),
        payloadVersion: String(version),
      }),
    },
  }, { clock });
  let database = await open(1);
  try {
    await database.init();
    const firstFingerprint = database.adapter.prepare("SELECT definitionFingerprint FROM sporades_schedules WHERE name='recurring'").get().definitionFingerprint;
    await database.shutdown();
    await database.close();

    database = await open(2);
    await database.init();
    const secondFingerprint = database.adapter.prepare("SELECT definitionFingerprint FROM sporades_schedules WHERE name='recurring'").get().definitionFingerprint;
    assert.notEqual(secondFingerprint, firstFingerprint);
  } finally {
    try { await database.shutdown(); } catch {}
    try { await database.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.8.5 payload factories without payloadVersion retain their legacy declaration identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-legacy-payload-factory-"));
  const payload = () => ({ compatible: true });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-legacy-payload-factory" }, {
    jobs: { record: job(() => null) },
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload }) },
  });
  try {
    await database.init();
    assert.equal(database.schedules[0].fingerprint, JSON.stringify({
      expression: "* * * * *",
      timezone: "UTC",
      job: "record",
      payload: String(payload),
      retry: { maxAttempts: 1, delayMs: 0 },
      missedRun: "skip",
    }));
  } finally {
    try { await database.shutdown(); } catch {}
    try { await database.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("a v0.8.5 pending occurrence is migrated into the published restart incarnation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-legacy-pending-upgrade-"));
  const file = path.join(dir, "data.db");
  const capsuleName = "scheduled-legacy-pending-upgrade";
  const scheduleName = "recurring";
  const scheduledFor = "2030-01-01T00:01:00.000Z";
  const occurrenceId = createHash("sha256").update(JSON.stringify([capsuleName, scheduleName, scheduledFor])).digest("hex");
  const fingerprint = JSON.stringify({
    expression: "* * * * *",
    timezone: "UTC",
    job: "record",
    payload: "legacy",
    retry: { maxAttempts: 1, delayMs: 0 },
    missedRun: "skip",
  });
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE sporades (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
    "CREATE TABLE sporades_schedules (name TEXT PRIMARY KEY, definitionFingerprint TEXT NOT NULL, expression TEXT NOT NULL, effectiveTimezone TEXT NOT NULL, missedRunPolicy TEXT NOT NULL, enabled INTEGER NOT NULL, nextOccurrence TEXT, latestScheduledFor TEXT, latestOutcome TEXT, latestJobId TEXT, latestErrorCode TEXT);" +
    "CREATE TABLE sporades_schedule_occurrences (id TEXT PRIMARY KEY, scheduleName TEXT NOT NULL, scheduledFor TEXT NOT NULL, status TEXT NOT NULL, claimToken TEXT, claimExpiresAt TEXT, jobId TEXT, errorCode TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);" +
    "CREATE UNIQUE INDEX sporades_schedule_occurrence_identity ON sporades_schedule_occurrences(scheduleName, scheduledFor);",
  );
  legacy.prepare("INSERT INTO sporades_schedules (name, definitionFingerprint, expression, effectiveTimezone, missedRunPolicy, enabled, nextOccurrence) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .run(scheduleName, fingerprint, "* * * * *", "UTC", "skip", "2030-01-01T00:02:00.000Z");
  legacy.prepare("INSERT INTO sporades_schedule_occurrences (id, scheduleName, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)")
    .run(occurrenceId, scheduleName, scheduledFor, "legacy-claim", "2030-01-01T00:01:30.000Z", scheduledFor, scheduledFor);
  legacy.close();

  const clock = createControllableRuntimeClock("2030-01-01T00:02:00.000Z");
  const executions = [];
  const database = await openDevDatabase(file, "", {}, { name: capsuleName }, {
    jobs: { record: job((_ctx, payload) => { executions.push(payload); return null; }) },
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "legacy" }) },
  }, { clock });
  try {
    await database.init();
    await clock.runDueTimers();
    assert.deepEqual(executions, ["legacy"]);
  } finally {
    try { await database.shutdown(); } catch {}
    try { await database.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveLegacyPendingOccurrenceUpgrade(openRuntime, capsuleName, scheduleName) {
  const originalClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const restartClock = createControllableRuntimeClock("2030-01-01T00:02:00.000Z");
  const executions = [];
  const capsule = {
    jobs: { record: job((_ctx, payload) => { executions.push(payload); return null; }) },
    schedules: { [scheduleName]: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "legacy" }) },
  };
  let database = await openRuntime(capsule, originalClock, "original");
  const sql = database.adapter.dialect.sql;
  const scheduledFor = "2030-01-01T00:01:00.000Z";
  const occurrenceId = createHash("sha256").update(JSON.stringify([capsuleName, scheduleName, scheduledFor])).digest("hex");
  try {
    await database.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run(scheduleName);
    await database.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run(scheduleName);
    await database.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(scheduleName);
    await database.init();
    await database.shutdown();
    await database.adapter.prepare(sql(
      "INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
    )).run(occurrenceId, scheduleName, scheduledFor, "legacy-claim", "2030-01-01T00:01:30.000Z", scheduledFor, scheduledFor);
    await database.close();

    database = await openRuntime(capsule, restartClock, "restart");
    await database.init();
    await restartClock.runDueTimers();
    assert.deepEqual(executions, ["legacy"]);
    const migrated = await database.adapter.prepare(sql(
      "SELECT [definitionFingerprint], [generationToken], [status] FROM [sporades_schedule_occurrences] WHERE [id]=?",
    )).get(occurrenceId);
    assert.equal(typeof migrated.definitionFingerprint, "string");
    assert.equal(typeof migrated.generationToken, "string");
    assert.equal(migrated.status, "enqueued");
  } finally {
    try {
      await database.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run(scheduleName);
      await database.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run(scheduleName);
      await database.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(scheduleName);
    } catch {}
    await Promise.allSettled([database.shutdown(), database.close()]);
  }
}

test("libSQL migrates a legacy pending occurrence into the published restart incarnation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-legacy-pending-upgrade-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const config = { name: "scheduled-legacy-pending-upgrade-libsql", services: { database: { kind: "database", engine: "libsql" } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveLegacyPendingOccurrenceUpgrade((capsule, clock, suffix) => openDevDatabase(path.join(dir, `unused-${suffix}.db`), "", {}, config, capsule, { clock, serviceEnv }), config.name, "legacyLibsql");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PostgreSQL migrates a legacy pending occurrence into the published restart incarnation", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL legacy Schedule migration." }, async () => {
  const config = { name: "scheduled-legacy-pending-upgrade-postgres", services: { database: { kind: "database", engine: "postgres" } } };
  const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  await proveLegacyPendingOccurrenceUpgrade((capsule, clock) => openDevDatabase("unused.db", "", {}, config, capsule, { clock, serviceEnv }), config.name, "legacyPostgres");
});

test("static Schedule fingerprints remain compatible across payload-version identity adoption", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-static-fingerprint-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled-static-fingerprint" }, {
    jobs: { record: job(() => null) },
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: { version: 1 } }) },
  });
  try {
    const expected = JSON.stringify({
      expression: "* * * * *",
      timezone: "UTC",
      job: "record",
      payload: { version: 1 },
      retry: { maxAttempts: 1, delayMs: 0 },
      missedRun: "skip",
    });
    assert.equal(database.schedules[0].fingerprint, expected);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("changed, disabled, and removed Schedule generations quarantine pending occurrences before later reuse", async (t) => {
  for (const scenario of [
    { name: "changed", replacement: { recurring: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "record" }) } },
    { name: "disabled", replacement: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", enabled: false }) } },
    { name: "removed", replacement: {} },
  ]) {
    await t.test(scenario.name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), `sporades-schedule-superseded-${scenario.name}-`));
      const file = path.join(dir, "data.db");
      const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
      const config = { name: `scheduled-superseded-${scenario.name}` };
      const original = { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record" }) };
      const open = (schedules) => openDevDatabase(file, "", {}, config, { jobs: { record: job(() => null) }, schedules }, { clock });
      let database = await open(original);
      const scheduledFor = "2030-01-01T00:01:00.000Z";
      const occurrenceId = createHash("sha256").update(JSON.stringify([config.name, "recurring", scheduledFor])).digest("hex");
      try {
        await database.init();
        await database.shutdown();
        const createdAt = clock.now().toISOString();
        database.adapter.prepare(
          "INSERT INTO sporades_schedule_occurrences (id, scheduleName, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
        ).run(occurrenceId, "recurring", scheduledFor, "old-generation-claim", "2030-01-01T00:10:00.000Z", createdAt, createdAt);
        await database.close();

        database = await open(scenario.replacement);
        await database.init();
        assert.deepEqual({ ...database.adapter.prepare(
          "SELECT status, claimToken, claimExpiresAt, jobId, errorCode FROM sporades_schedule_occurrences WHERE id=?",
        ).get(occurrenceId) }, {
          status: "enqueue-failed",
          claimToken: null,
          claimExpiresAt: null,
          jobId: null,
          errorCode: "SCHEDULE_OCCURRENCE_SUPERSEDED",
        });
        assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
        await database.shutdown();
        await database.close();

        clock.advanceBy(120_000);
        database = await open(original);
        await database.init();
        assert.equal(database.adapter.prepare("SELECT errorCode FROM sporades_schedule_occurrences WHERE id=?").get(occurrenceId).errorCode, "SCHEDULE_OCCURRENCE_SUPERSEDED");
        assert.equal(database.adapter.prepare("SELECT nextOccurrence FROM sporades_schedules WHERE name='recurring'").get().nextOccurrence, "2030-01-01T00:03:00.000Z");
        clock.advanceBy(30_000);
        await clock.runDueTimers();
        assert.deepEqual(database.adapter.prepare("SELECT scheduledFor FROM sporades_jobs ORDER BY scheduledFor").all().map((row) => row.scheduledFor), ["2030-01-01T00:03:00.000Z"]);
      } finally {
        try { await database.shutdown(); } catch {}
        try { await database.close(); } catch {}
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("a lost superseded-occurrence quarantine race schedules recovery for the winning claim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-superseded-race-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const config = { name: "scheduled-superseded-race" };
  const base = { jobs: { record: job(() => null) }, schedules: { recurring: schedule({ expression: "* * * * *", job: "record" }) } };
  let database = await openDevDatabase(file, "", {}, config, base, { clock });
  const scheduledFor = "2030-01-01T00:01:00.000Z";
  const occurrenceId = createHash("sha256").update(JSON.stringify([config.name, "recurring", scheduledFor])).digest("hex");
  try {
    await database.init();
    await database.shutdown();
    const createdAt = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO sporades_schedule_occurrences (id, scheduleName, definitionFingerprint, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
      .run(occurrenceId, "recurring", database.schedules[0].fingerprint, scheduledFor, "old-claim", null, createdAt, createdAt);
    await database.close();

    database = await openDevDatabase(file, "", {}, config, {
      jobs: { record: job(() => null) },
      schedules: { recurring: schedule({ expression: "*/5 * * * *", job: "record" }) },
    }, { clock });
    const injectWinningClaim = (adapter) => {
      const originalPrepare = adapter.prepare.bind(adapter);
      adapter.prepare = (sql) => {
        const statement = originalPrepare(sql);
        if (stealQuarantine && String(sql).includes("sporades_schedule_occurrences") && String(sql).includes("enqueue-failed")) {
          return { ...statement, run(...args) {
            stealQuarantine = false;
            originalPrepare("UPDATE sporades_schedule_occurrences SET claimToken=?, claimExpiresAt=? WHERE id=?")
              .run("winning-claim", "2030-01-01T00:00:31.000Z", occurrenceId);
            return statement.run(...args);
          } };
        }
        return statement;
      };
    };
    const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    let stealQuarantine = true;
    database.adapter.withTransaction = (callback) => originalWithTransaction((transactionAdapter) => {
      injectWinningClaim(transactionAdapter);
      return callback(transactionAdapter);
    });
    injectWinningClaim(database.adapter);
    await database.init();
    assert.equal(stealQuarantine, false, "the superseded-occurrence quarantine was attempted");
    assert.equal(database.__scheduleRecoveryDueAt, Date.parse("2030-01-01T00:00:31.000Z"));
    clock.advanceBy(1_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT errorCode FROM sporades_schedule_occurrences WHERE id=?").get(occurrenceId).errorCode, "SCHEDULE_OCCURRENCE_SUPERSEDED");
  } finally {
    try { await database.shutdown(); } catch {}
    try { await database.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveReplacementScheduleGenerationSurvivesStaleRuntime(openPair, scheduleName) {
  const staleClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const replacementClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const executions = [];
  let releaseReplacementClaim;
  let markReplacementClaimed;
  const replacementClaimed = new Promise((resolve) => { markReplacementClaimed = resolve; });
  const jobs = { work: job((_ctx, payload) => { executions.push(payload.version); return null; }) };
  const staleCapsule = {
    jobs,
    schedules: {
      [scheduleName]: schedule({ expression: "* * * * *", timezone: "UTC", job: "work", payload: { version: "stale" } }),
    },
  };
  const replacementCapsule = {
    jobs,
    schedules: {
      [scheduleName]: schedule({ expression: "* * * * *", timezone: "UTC", job: "work", payload: { version: "replacement" } }),
    },
  };
  const { stale, openReplacement } = await openPair(staleCapsule, replacementCapsule, staleClock, replacementClock, {
    scheduleOccurrenceFault: async (boundary) => {
      if (boundary !== "after-pending") return;
      markReplacementClaimed();
      await new Promise((resolve) => { releaseReplacementClaim = resolve; });
    },
  });
  let replacement;
  try {
    await stale.init();
    replacement = await openReplacement();
    await replacement.init();

    replacementClock.advanceBy(30_000);
    const replacementOccurrence = replacementClock.runDueTimers();
    await replacementClaimed;

    staleClock.advanceBy(30_000);
    await staleClock.runDueTimers();
    releaseReplacementClaim();
    await replacementOccurrence;

    assert.deepEqual(executions, ["replacement"]);
  } finally {
    releaseReplacementClaim?.();
    await Promise.allSettled([stale.shutdown(), replacement?.shutdown()]);
    await Promise.allSettled([stale.close(), replacement?.close()]);
  }
}

test("a stale SQLite Schedule generation cannot quarantine the replacement generation's occurrence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-replacement-owner-sqlite-"));
  const file = path.join(dir, "data.db");
  const config = { name: "scheduled-replacement-owner-sqlite" };
  try {
    await proveReplacementScheduleGenerationSurvivesStaleRuntime(async (staleCapsule, replacementCapsule, staleClock, replacementClock, replacementOptions) => ({
      stale: await openDevDatabase(file, "", {}, config, staleCapsule, { clock: staleClock }),
      openReplacement: () => openDevDatabase(file, "", {}, config, replacementCapsule, { clock: replacementClock, ...replacementOptions }),
    }), "sharedSqlite");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stale libSQL Schedule generation cannot quarantine the replacement generation's occurrence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-replacement-owner-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const config = { name: "scheduled-replacement-owner-libsql", services: { database: { kind: "database", engine: "libsql" } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveReplacementScheduleGenerationSurvivesStaleRuntime(async (staleCapsule, replacementCapsule, staleClock, replacementClock, replacementOptions) => ({
        stale: await openDevDatabase(path.join(dir, "unused-a.db"), "", {}, config, staleCapsule, { clock: staleClock, serviceEnv }),
        openReplacement: () => openDevDatabase(path.join(dir, "unused-b.db"), "", {}, config, replacementCapsule, { clock: replacementClock, serviceEnv, ...replacementOptions }),
      }), "sharedLibsqlGeneration");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stale PostgreSQL Schedule generation cannot quarantine the replacement generation's occurrence", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Schedule-generation race." }, async () => {
  const scheduleName = "sharedPostgresGeneration";
  const config = { name: "scheduled-replacement-owner-postgres", services: { database: { kind: "database", engine: "postgres" } } };
  const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  await proveReplacementScheduleGenerationSurvivesStaleRuntime(async (staleCapsule, replacementCapsule, staleClock, replacementClock, replacementOptions) => {
    const stale = await openDevDatabase("unused-a.db", "", {}, config, staleCapsule, { clock: staleClock, serviceEnv });
    const sql = stale.adapter.dialect.sql;
    await stale.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run(scheduleName);
    await stale.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run(scheduleName);
    await stale.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(scheduleName);
    return {
      stale,
      openReplacement: () => openDevDatabase("unused-b.db", "", {}, config, replacementCapsule, { clock: replacementClock, serviceEnv, ...replacementOptions }),
    };
  }, scheduleName);
});

test("a live superseded Schedule generation stops its local timer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-live-superseded-cursor-"));
  const file = path.join(dir, "data.db");
  let nowMs = Date.parse("2030-01-01T00:00:30.000Z");
  let nextTimerId = 1;
  const timers = new Map();
  const clock = {
    now: () => new Date(nowMs),
    setTimer(callback, delayMs) { const id = nextTimerId++; timers.set(id, { id, callback, dueAt: nowMs + delayMs }); return id; },
    clearTimer(id) { timers.delete(id); },
  };
  const config = { name: "scheduled-live-superseded-cursor" };
  const jobs = { record: job(() => null) };
  const current = await openDevDatabase(file, "", {}, config, { jobs, schedules: { recurring: schedule({ expression: "* * * * *", job: "record" }) } }, { clock });
  let candidate;
  try {
    await current.init();
    candidate = await openDevDatabase(file, "", {}, config, { jobs, schedules: { recurring: schedule({ expression: "*/5 * * * *", job: "record" }) } }, { clock });
    await candidate.init();
    nowMs += 30_000;
    const due = [...timers.values()].filter((timer) => timer.dueAt <= nowMs).sort((left, right) => left.id - right.id)[0];
    timers.delete(due.id);
    const remainingTimers = timers.size;
    await due.callback();
    assert.equal(current.schedules[0].enabled, false);
    assert.equal(timers.size, remainingTimers);
  } finally {
    try { await current.shutdown(); } catch {}
    try { await current.close(); } catch {}
    try { if (candidate) await candidate.shutdown(); } catch {}
    try { if (candidate) await candidate.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed Dev candidate cannot publish Schedule authority or fence the live runtime", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-failed-candidate-authority-"));
  const file = path.join(dir, "data.db");
  const liveClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const candidateBaseClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const candidateClock = {
    ...candidateBaseClock,
    setTimer() { throw new Error("candidate timer unavailable"); },
  };
  const executions = [];
  const jobs = { record: job((_ctx, payload) => { executions.push(payload); return null; }) };
  const live = await openDevDatabase(file, "", {}, { name: "scheduled-failed-candidate-authority" }, {
    jobs,
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live" }) },
  }, { clock: liveClock });
  let candidate;
  try {
    await live.init();
    candidate = await openDevDatabase(file, "", {}, { name: "scheduled-failed-candidate-authority" }, {
      jobs,
      schedules: { recurring: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "record", payload: "candidate" }) },
    }, { clock: candidateClock });
    await assert.rejects(replaceRuntimeDatabase(live, candidate), /candidate timer unavailable/);

    liveClock.advanceBy(30_000);
    await liveClock.runDueTimers();
    assert.deepEqual(executions, ["live"]);
  } finally {
    try { await live.shutdown(); } catch {}
    try { await live.close(); } catch {}
    try { await candidate?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Dev candidate that cannot validate Schedule recovery leaves the live runtime authoritative", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-failed-candidate-recovery-"));
  const file = path.join(dir, "data.db");
  const liveClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const candidateClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const executions = [];
  const jobs = { record: job((_ctx, payload) => { executions.push(payload); return null; }) };
  const live = await openDevDatabase(file, "", {}, { name: "scheduled-failed-candidate-recovery" }, {
    jobs,
    schedules: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live" }) },
  }, { clock: liveClock });
  let candidate;
  try {
    await live.init();
    candidate = await openDevDatabase(file, "", {}, { name: "scheduled-failed-candidate-recovery" }, {
      jobs,
      schedules: { recurring: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "record", payload: "candidate" }) },
    }, { clock: candidateClock });
    const originalPrepare = candidate.adapter.prepare.bind(candidate.adapter);
    candidate.adapter.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (String(sql).includes("sporades_schedule_occurrences") && String(sql).includes("ORDER BY")) {
        return { ...statement, all() { throw new Error("candidate recovery unavailable"); } };
      }
      return statement;
    };
    await assert.rejects(replaceRuntimeDatabase(live, candidate), /candidate recovery unavailable/);

    liveClock.advanceBy(30_000);
    await liveClock.runDueTimers();
    assert.deepEqual(executions, ["live"]);
  } finally {
    try { await live.shutdown(); } catch {}
    try { await live.close(); } catch {}
    try { await candidate?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale Schedule incarnations cannot regain authority after an equivalent declaration returns", async (t) => {
  for (const scenario of [
    { name: "A-B-A", intermediate: { recurring: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "record", payload: "replacement" }) } },
    { name: "remove-readd", intermediate: {} },
    { name: "disable-reenable", intermediate: { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live", enabled: false }) } },
  ]) {
    await t.test(scenario.name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), `sporades-schedule-incarnation-${scenario.name}-`));
      const file = path.join(dir, "data.db");
      const staleClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
      const intermediateClock = createControllableRuntimeClock("2030-01-01T00:01:30.000Z");
      const currentClock = createControllableRuntimeClock("2030-01-01T00:02:30.000Z");
      const executions = [];
      const jobs = { record: job((_ctx, payload) => { executions.push(payload); return null; }) };
      const originalSchedules = { recurring: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live" }) };
      const config = { name: `scheduled-incarnation-${scenario.name}` };
      const stale = await openDevDatabase(file, "", {}, config, { jobs, schedules: originalSchedules }, { clock: staleClock });
      let intermediate;
      let current;
      try {
        await stale.init();
        intermediate = await openDevDatabase(file, "", {}, config, { jobs, schedules: scenario.intermediate }, { clock: intermediateClock });
        await intermediate.init();
        await intermediate.shutdown();
        await intermediate.close();
        intermediate = null;

        current = await openDevDatabase(file, "", {}, config, { jobs, schedules: originalSchedules }, { clock: currentClock });
        await current.init();

        staleClock.advanceBy(30_000);
        await staleClock.runDueTimers();
        assert.deepEqual(executions, []);
      } finally {
        try { await stale.shutdown(); } catch {}
        try { await stale.close(); } catch {}
        try { await intermediate?.shutdown(); } catch {}
        try { await intermediate?.close(); } catch {}
        try { await current?.shutdown(); } catch {}
        try { await current?.close(); } catch {}
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

async function proveEquivalentScheduleIncarnationsStayFenced(t, openRuntime, schedulePrefix) {
  for (const scenario of [
    { name: "A-B-A", intermediate: (name) => ({ [name]: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "record", payload: "replacement" }) }) },
    { name: "remove-readd", intermediate: () => ({}) },
    { name: "disable-reenable", intermediate: (name) => ({ [name]: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live", enabled: false }) }) },
  ]) {
    await t.test(scenario.name, async () => {
      const scheduleName = `${schedulePrefix}${scenario.name.replaceAll("-", "")}`;
      const staleClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
      const intermediateClock = createControllableRuntimeClock("2030-01-01T00:01:30.000Z");
      const currentClock = createControllableRuntimeClock("2030-01-01T00:02:30.000Z");
      const executions = [];
      const jobs = { record: job((_ctx, payload) => { executions.push(payload); return null; }) };
      const originalSchedules = { [scheduleName]: schedule({ expression: "* * * * *", timezone: "UTC", job: "record", payload: "live" }) };
      const stale = await openRuntime({ jobs, schedules: originalSchedules }, staleClock, scenario.name, "stale");
      const sql = stale.adapter.dialect.sql;
      let intermediate;
      let current;
      try {
        await stale.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run(scheduleName);
        await stale.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run(scheduleName);
        await stale.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(scheduleName);
        await stale.init();
        intermediate = await openRuntime({ jobs, schedules: scenario.intermediate(scheduleName) }, intermediateClock, scenario.name, "intermediate");
        await intermediate.init();
        await intermediate.shutdown();
        await intermediate.close();
        intermediate = null;
        current = await openRuntime({ jobs, schedules: originalSchedules }, currentClock, scenario.name, "current");
        await current.init();

        staleClock.advanceBy(30_000);
        await staleClock.runDueTimers();
        assert.deepEqual(executions, []);
      } finally {
        await Promise.allSettled([stale.shutdown(), intermediate?.shutdown(), current?.shutdown()]);
        const cleanup = current ?? intermediate ?? stale;
        try {
          await cleanup.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run(scheduleName);
          await cleanup.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run(scheduleName);
          await cleanup.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(scheduleName);
        } catch {}
        await Promise.allSettled([stale.close(), intermediate?.close(), current?.close()]);
      }
    });
  }
}

test("libSQL stale Schedule incarnations cannot regain authority after equivalent declarations return", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-incarnation-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const config = { name: "scheduled-incarnation-libsql", services: { database: { kind: "database", engine: "libsql" } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveEquivalentScheduleIncarnationsStayFenced(t, (capsule, clock, scenario, phase) => openDevDatabase(path.join(dir, `unused-${scenario}-${phase}.db`), "", {}, config, capsule, { clock, serviceEnv }), "incarnationLibsql");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PostgreSQL stale Schedule incarnations cannot regain authority after equivalent declarations return", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Schedule-incarnation races." }, async (t) => {
  const config = { name: "scheduled-incarnation-postgres", services: { database: { kind: "database", engine: "postgres" } } };
  const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  await proveEquivalentScheduleIncarnationsStayFenced(t, (capsule, clock) => openDevDatabase("unused.db", "", {}, config, capsule, { clock, serviceEnv }), "incarnationPostgres");
});

test("Dev replacement cannot let an old Schedule generation overwrite the candidate future cursor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-replacement-generation-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let markPayloadStarted;
  const payloadStarted = new Promise((resolve) => { markPayloadStarted = resolve; });
  const current = await openDevDatabase(file, "", {}, { name: "scheduled-replacement-generation" }, {
    jobs: { work: job(() => null) },
    schedules: { changing: schedule({
      expression: "* * * * *",
      timezone: "UTC",
      job: "work",
      payloadVersion: "blocking-v1",
      payload: (_occurrence, context) => {
        markPayloadStarted();
        return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true }));
      },
    }) },
  }, { clock });
  let candidate;
  try {
    await current.init();
    clock.advanceBy(30_000);
    const activeOccurrence = clock.runDueTimers();
    await payloadStarted;

    candidate = await openDevDatabase(file, "", {}, { name: "scheduled-replacement-generation" }, {
      jobs: { work: job(() => null) },
      schedules: { changing: schedule({ expression: "*/5 * * * *", timezone: "UTC", job: "work" }) },
    }, { clock });
    candidate = await replaceRuntimeDatabase(current, candidate);
    await activeOccurrence;

    assert.deepEqual({ ...await candidate.adapter.prepare(candidate.adapter.dialect.sql(
      "SELECT [expression], [nextOccurrence], [latestScheduledFor], [latestOutcome] FROM [sporades_schedules] WHERE [name]=?",
    )).get("changing") }, {
      expression: "*/5 * * * *",
      nextOccurrence: "2030-01-01T00:05:00.000Z",
      latestScheduledFor: null,
      latestOutcome: null,
    });
    assert.equal(Number((await candidate.adapter.prepare(candidate.adapter.dialect.sql(
      "SELECT COUNT(*) AS [count] FROM [sporades_jobs] WHERE [scheduleName]=?",
    )).get("changing")).count), 0);
  } finally {
    try { if (candidate) await candidate.shutdown(); } catch {}
    try { if (candidate) await candidate.close(); } catch {}
    try { await current.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test("Schedule reconciliation validates the complete plan before changing durable state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-reconcile-atomic-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const open = (schedules) => openDevDatabase(file, "", {}, { name: "scheduled" }, { jobs: { record: job(() => null) }, schedules }, { clock });
  let database = await open({
    removed: schedule({ expression: "* * * * *", job: "record" }),
    changed: schedule({ expression: "*/2 * * * *", job: "record" }),
  });
  await database.init(); await database.shutdown(); database.close();
  database = await open({
    changed: schedule({ expression: "*/5 * * * *", job: "record" }),
    impossible: schedule({ expression: "0 0 30 2 *", job: "record" }),
  });
  try {
    await assert.rejects(database.init(), /Schedule has no future occurrence/);
    const rows = await database.adapter.prepare("SELECT name, expression, nextOccurrence FROM sporades_schedules ORDER BY name").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { name: "changed", expression: "*/2 * * * *", nextOccurrence: "2030-01-01T00:02:00.000Z" },
      { name: "removed", expression: "* * * * *", nextOccurrence: "2030-01-01T00:01:00.000Z" },
    ]);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("disabling the runtime aborts an active payload factory and creates no Job", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-disable-abort-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let signal;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: { active: schedule({ expression: "* * * * *", job: "record", payloadVersion: "active-v1", payload: (_occurrence, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    } }) },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(30_000);
    const due = clock.runDueTimers();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    await database.shutdown();
    await due;
    assert.equal(signal.aborted, true);
    assert.equal((await database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_jobs").get()).count, 0);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("libSQL persists and reconciles Schedule state through the configured adapter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-libsql-"));
  await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
    const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
    const options = { clock, serviceEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url } };
    const config = { name: "scheduled", services: { database: { kind: "database", engine: "libsql" } } };
    let database = await openDevDatabase(path.join(dir, "unused.db"), "", {}, config, { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "* * * * *", job: "work" }) } }, options);
    await database.init(); await database.shutdown(); await database.close();
    clock.advanceBy(120_000);
    database = await openDevDatabase(path.join(dir, "unused.db"), "", {}, config, { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "*/2 * * * *", job: "work" }) } }, options);
    try {
      await database.init();
      const state = await database.adapter.prepare("SELECT expression, nextOccurrence FROM sporades_schedules WHERE name=?").get("durable");
      assert.deepEqual(state, { expression: "*/2 * * * *", nextOccurrence: "2030-01-01T00:04:00.000Z" });
    } finally { await database.shutdown(); await database.close(); }
  });
  await rm(dir, { recursive: true, force: true });
});

test("Postgres persists Schedule state through the configured adapter", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres adapter integration test." }, async () => {
  const admin = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL });
  await admin.exec("DROP TABLE IF EXISTS sporades_schedules, sporades_jobs, sporades, sporades_auth_users, sporades_auth_sessions, sporades_auth_email_credentials, sporades_auth_oauth_states, sporades_user_preferences, sporades_file_buckets, sporades_files, sporades_file_uploads, sporades_file_public_urls, sporades_log_events");
  await admin.close();
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const config = { name: "scheduled", services: { database: { kind: "database", engine: "postgres" } } };
  const options = { clock, serviceEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL } };
  const database = await openDevDatabase("unused.db", "", {}, config, { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "* * * * *", job: "work" }) } }, options);
  try {
    await database.init();
    assert.equal(
      (await database.adapter
        .prepare(database.adapter.dialect.sql("SELECT [nextOccurrence] FROM [sporades_schedules] WHERE [name]=?"))
        .get("durable")).nextOccurrence,
      "2030-01-01T00:01:00.000Z",
    );
  } finally { await database.shutdown(); await database.close(); }
});

test("Scheduled provenance is present at the atomic enqueue boundary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-provenance-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let database;
  let observed;
  database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { inspect: job(() => { observed = database.adapter.prepare(database.adapter.dialect.sql("SELECT [scheduleName], [scheduledFor] FROM [sporades_jobs]")).get(); return null; }) },
    schedules: { atomic: schedule({ expression: "* * * * *", job: "inspect" }) },
  }, { clock });
  try {
    const originalPrepare = database.adapter.prepare.bind(database.adapter);
    database.adapter.prepare = (sql) => {
      if (String(sql).startsWith('UPDATE "sporades_jobs" SET "scheduleName"=')) throw new Error("post-enqueue provenance write is forbidden");
      return originalPrepare(sql);
    };
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual({ ...observed }, { scheduleName: "atomic", scheduledFor: "2030-01-01T00:01:00.000Z" });
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a restart recovers a durable occurrence that crashed before enqueue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-crash-before-enqueue-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "* * * * *", job: "work" }) } };
  let crashed = false;
  let database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock, scheduleOccurrenceFault: (boundary) => {
    if (!crashed && boundary === "after-pending") { crashed = true; database.__scheduleStopped = true; throw new Error("simulated crash"); }
  } });
  try {
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    database.close();

    clock.advanceBy(31_000);
    database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock });
    await database.init();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
    const occurrence = database.adapter.prepare("SELECT status, jobId FROM sporades_schedule_occurrences").get();
    assert.equal(occurrence.status, "enqueued");
    assert.ok(occurrence.jobId);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an immediate restart revisits a pending occurrence when its claim expires", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-unexpired-restart-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "* * * * *", job: "work" }) } };
  let database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock, scheduleOccurrenceFault: (boundary) => {
    if (boundary === "after-pending") { database.__scheduleStopped = true; throw new Error("simulated crash"); }
  } });
  try {
    await database.init(); clock.advanceBy(30_000); await clock.runDueTimers(); database.close();
    database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock });
    await database.init();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    clock.advanceBy(30_000); await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a crash after transactional enqueue rolls back before restart recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-crash-after-enqueue-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { durable: schedule({ expression: "* * * * *", job: "work" }) } };
  let crashed = false;
  let database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock, scheduleOccurrenceFault: (boundary) => {
    if (!crashed && boundary === "after-enqueue") { crashed = true; database.__scheduleStopped = true; throw new Error("simulated crash"); }
  } });
  try {
    await database.init(); clock.advanceBy(30_000); await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    database.close();
    clock.advanceBy(31_000);
    database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock });
    await database.init();
    const jobs = database.adapter.prepare("SELECT id FROM sporades_jobs").all();
    assert.equal(jobs.length, 1);
    assert.equal(database.adapter.prepare("SELECT jobId FROM sporades_schedule_occurrences").get().jobId, jobs[0].id);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("overlapping runtime starts converge on one occurrence Job identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-overlap-"));
  const file = path.join(dir, "data.db");
  const clockA = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const clockB = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { shared: schedule({ expression: "* * * * *", job: "work" }) } };
  const first = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockA });
  const second = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockB });
  try {
    await Promise.all([first.init(), second.init()]);
    clockA.advanceBy(30_000); clockB.advanceBy(30_000);
    await Promise.all([clockA.runDueTimers(), clockB.runDueTimers()]);
    const jobs = first.adapter.prepare("SELECT id FROM sporades_jobs").all();
    const occurrences = first.adapter.prepare("SELECT id, jobId, status FROM sporades_schedule_occurrences").all();
    assert.equal(jobs.length, 1);
    assert.deepEqual(occurrences.map(({ jobId, status }) => ({ jobId, status })), [{ jobId: jobs[0].id, status: "enqueued" }]);
  } finally { await Promise.all([first.shutdown(), second.shutdown()]); first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an expired Schedule owner cannot enqueue after a replacement owner terminally fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-stale-owner-"));
  const file = path.join(dir, "data.db");
  const clockA = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const clockB = createControllableRuntimeClock("2030-01-01T00:01:31.000Z");
  let payloadCalls = 0;
  let releaseFirst;
  let markFirstPayloadStarted;
  const firstPayloadStarted = new Promise((resolve) => { markFirstPayloadStarted = resolve; });
  const capsule = {
    jobs: { work: job(() => null) },
    schedules: {
      shared: schedule({
        expression: "* * * * *",
        job: "work",
        payloadVersion: "shared-v1",
        payload: async () => {
          payloadCalls += 1;
          if (payloadCalls === 1) {
            markFirstPayloadStarted();
            await new Promise((release) => { releaseFirst = release; });
            return { owner: "expired" };
          }
          throw new Error("replacement payload failed");
        },
      }),
    },
  };
  const first = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockA });
  let second;
  try {
    await first.init();
    clockA.advanceBy(30_000);
    const firstOccurrence = clockA.runDueTimers();
    await firstPayloadStarted;

    second = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockB });
    await second.init();
    releaseFirst();
    await firstOccurrence;

    assert.equal(payloadCalls, 2);
    assert.deepEqual({ ...first.adapter.prepare("SELECT status, jobId, errorCode FROM sporades_schedule_occurrences").get() }, {
      status: "payload-failed",
      jobId: null,
      errorCode: "SCHEDULE_PAYLOAD_FAILED",
    });
    assert.deepEqual({ ...first.adapter.prepare("SELECT latestOutcome, latestJobId, latestErrorCode FROM sporades_schedules WHERE name='shared'").get() }, {
      latestOutcome: "payload-failed",
      latestJobId: null,
      latestErrorCode: "SCHEDULE_PAYLOAD_FAILED",
    });
    assert.equal(first.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
  } finally {
    releaseFirst?.();
    await Promise.allSettled([first.shutdown(), second?.shutdown()]);
    await Promise.allSettled([first.close(), second?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveStaleScheduleOwnerCannotCommit(openPair, scheduleName) {
  const clockA = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const clockB = createControllableRuntimeClock("2030-01-01T00:01:31.000Z");
  let payloadCalls = 0;
  let releaseFirst;
  let markFirstPayloadStarted;
  const firstPayloadStarted = new Promise((resolve) => { markFirstPayloadStarted = resolve; });
  const capsule = {
    jobs: { work: job(() => null) },
    schedules: {
      [scheduleName]: schedule({
        expression: "* * * * *",
        job: "work",
        payloadVersion: "shared-v1",
        payload: async () => {
          payloadCalls += 1;
          if (payloadCalls === 1) {
            markFirstPayloadStarted();
            await new Promise((resolve) => { releaseFirst = resolve; });
            return { owner: "expired" };
          }
          throw new Error("replacement payload failed");
        },
      }),
    },
  };
  const { first, openSecond } = await openPair(capsule, clockA, clockB);
  let second;
  try {
    await first.init();
    clockA.advanceBy(30_000);
    const firstOccurrence = clockA.runDueTimers();
    await firstPayloadStarted;
    second = await openSecond();
    await second.init();
    releaseFirst();
    await firstOccurrence;

    const sql = first.adapter.dialect.sql;
    assert.equal(Number((await first.adapter.prepare(sql("SELECT count(*) AS count FROM [sporades_jobs] WHERE [scheduleName]=?")).get(scheduleName)).count), 0);
    assert.deepEqual(await first.adapter.prepare(sql("SELECT [status], [jobId], [errorCode] FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).get(scheduleName), {
      status: "payload-failed", jobId: null, errorCode: "SCHEDULE_PAYLOAD_FAILED",
    });
    assert.deepEqual(await first.adapter.prepare(sql("SELECT [latestOutcome], [latestJobId], [latestErrorCode] FROM [sporades_schedules] WHERE [name]=?")).get(scheduleName), {
      latestOutcome: "payload-failed", latestJobId: null, latestErrorCode: "SCHEDULE_PAYLOAD_FAILED",
    });
  } finally {
    releaseFirst?.();
    await Promise.allSettled([first.shutdown(), second?.shutdown()]);
    await Promise.allSettled([first.close(), second?.close()]);
  }
}

test("libSQL rejects a stale Schedule owner before its deterministic Job side effect", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-stale-owner-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const config = { name: "scheduled-stale-owner-libsql", services: { database: { kind: "database", engine: "libsql" } } };
      const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await proveStaleScheduleOwnerCannotCommit(async (capsule, clockA, clockB) => ({
        first: await openDevDatabase(path.join(dir, "unused-a.db"), "", {}, config, capsule, { clock: clockA, serviceEnv }),
        openSecond: () => openDevDatabase(path.join(dir, "unused-b.db"), "", {}, config, capsule, { clock: clockB, serviceEnv }),
      }), "sharedLibsql");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Postgres rejects a stale Schedule owner before its deterministic Job side effect", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres adapter race." }, async () => {
  const config = { name: "scheduled-stale-owner-postgres", services: { database: { kind: "database", engine: "postgres" } } };
  const serviceEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  await proveStaleScheduleOwnerCannotCommit(async (capsule, clockA, clockB) => {
    const first = await openDevDatabase("unused-a.db", "", {}, config, capsule, { clock: clockA, serviceEnv });
    const sql = first.adapter.dialect.sql;
    await first.adapter.prepare(sql("DELETE FROM [sporades_jobs] WHERE [scheduleName]=?")).run("sharedPostgres");
    await first.adapter.prepare(sql("DELETE FROM [sporades_schedule_occurrences] WHERE [scheduleName]=?")).run("sharedPostgres");
    await first.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run("sharedPostgres");
    return {
      first,
      openSecond: () => openDevDatabase("unused-b.db", "", {}, config, capsule, { clock: clockB, serviceEnv }),
    };
  }, "sharedPostgres");
});

test("a replacement runtime recovers after its current owner crashes while the stale runtime stays fenced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-overlap-winner-crash-"));
  const file = path.join(dir, "data.db");
  const clockA = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const clockB = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { shared: schedule({ expression: "* * * * *", job: "work" }) } };
  const first = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockA });
  let second;
  second = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockB, scheduleOccurrenceFault: (boundary) => {
    if (boundary === "after-pending") { second.__scheduleStopped = true; throw new Error("current owner crashed"); }
  } });
  let replacement;
  try {
    await first.init(); await second.init();
    clockA.advanceBy(30_000); clockB.advanceBy(30_000);
    await clockA.runDueTimers(); await clockB.runDueTimers();
    assert.equal(second.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    replacement = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockB });
    await replacement.init();
    clockA.advanceBy(30_000); clockB.advanceBy(30_000);
    await clockA.runDueTimers(); await clockB.runDueTimers();
    assert.equal(replacement.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
  } finally {
    await Promise.allSettled([first.shutdown(), second.shutdown(), replacement?.shutdown()]);
    await Promise.allSettled([first.close(), second.close(), replacement?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Capsule code cannot forge Schedule provenance through context properties", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-forgery-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => null) },
    mutations: {
      forge: mutation((ctx) => {
        ctx.__jobScheduleProvenance = { scheduleName: "forged", scheduledFor: "2030-01-01T00:01:00.000Z" };
        return ctx.privileged.run({ operation: "test.forge", targetResourceKind: "job-queue" },
          (privilegedCtx) => privilegedCtx.jobs.enqueue("work", null));
      }),
    },
  }, { clock });
  try {
    const result = await runMutation(database, { userId: "attacker", displayName: "attacker", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" }, "forge", []);
    assert.equal(result.ok, true);
    const row = database.adapter.prepare("SELECT scheduleName, scheduledFor FROM sporades_jobs WHERE id=?").get(result.data.id);
    assert.deepEqual({ ...row }, { scheduleName: null, scheduledFor: null });
    assert.deepEqual(result.data.enqueuedBy, { mode: "user", userId: "attacker" });
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Scheduled idempotent returns reject an existing Job without matching private provenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-idempotency-conflict-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const occurrenceKey = `schedule:${createHash("sha256").update(JSON.stringify(["scheduled", "collision", "2030-01-01T00:01:00.000Z"])).digest("hex")}`;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => null) },
    schedules: { collision: schedule({ expression: "* * * * *", job: "work" }) },
    mutations: { reserve: mutation((ctx) => ctx.privileged.run({ operation: "test.reserve", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.enqueue("work", null, { idempotencyKey: occurrenceKey }))) },
  }, { clock });
  try {
    await runMutation(database, { userId: "attacker", displayName: "attacker", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" }, "reserve", []);
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    const rows = database.adapter.prepare("SELECT scheduleName, scheduledFor FROM sporades_jobs").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ scheduleName: null, scheduledFor: null }]);
    const logs = await database.adapter.readRecentLogEvents(20);
    assert.equal(logs.some((entry) => entry.event === "schedule.occurrence.enqueue_failed"), true);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a failed occurrence logs safely and re-arms the next occurrence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-rearm-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let runs = 0;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => { runs += 1; return null; }) },
    schedules: { resilient: schedule({ expression: "* * * * *", job: "work" }) },
    mutations: { inspect: mutation((ctx) => ctx.privileged.run({ operation: "test.inspect", targetResourceKind: "schedule-store" }, (privilegedCtx) => privilegedCtx.schedules.get("resilient"))) },
  }, { clock });
  try {
    const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    let rejectOnce = true;
    database.adapter.withTransaction = (callback) => originalWithTransaction(async (transactionAdapter) => {
      const originalPrepare = transactionAdapter.prepare.bind(transactionAdapter);
      transactionAdapter.prepare = (sql) => {
        const statement = originalPrepare(sql);
        if (rejectOnce && String(sql).startsWith('INSERT INTO "sporades_jobs"')) return { ...statement, run() { rejectOnce = false; throw new Error("queue unavailable"); } };
        return statement;
      };
      return callback(transactionAdapter);
    });
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.equal(runs, 0);
    const inspected = await runMutation(database, { userId: "operator", displayName: "operator", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "test" }, "inspect", []);
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.data.latestOccurrence, { scheduledFor: "2030-01-01T00:01:00.000Z", outcome: "payload-failed", errorCode: "SCHEDULE_ENQUEUE_FAILED" });
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.equal(runs, 1);
    const logs = await database.adapter.readRecentLogEvents(20);
    assert.equal(logs.some((entry) => entry.event === "schedule.occurrence.enqueue_failed"), true);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown stops future occurrences and awaits an active occurrence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-shutdown-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let release;
  let markOccurrenceStarted;
  const occurrenceStarted = new Promise((resolve) => { markOccurrenceStarted = resolve; });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => null) },
    schedules: { stopping: schedule({ expression: "* * * * *", job: "work" }) },
  }, { clock, scheduleOccurrenceFault: async (boundary) => {
    if (boundary !== "after-pending") return;
    markOccurrenceStarted();
    await new Promise((resolve) => { release = resolve; });
  } });
  try {
    await database.init();
    clock.advanceBy(30_000);
    const occurrence = clock.runDueTimers();
    await occurrenceStarted;
    let stopped = false;
    const shutdown = database.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await occurrence;
    await shutdown;
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
    const jobId = database.adapter.prepare("SELECT id FROM sporades_jobs").get().id;
    assert.deepEqual({ ...database.adapter.prepare("SELECT status, jobId, errorCode FROM sporades_schedule_occurrences").get() }, {
      status: "enqueued",
      jobId,
      errorCode: null,
    });
    assert.deepEqual({ ...database.adapter.prepare("SELECT nextOccurrence, latestScheduledFor, latestOutcome, latestJobId, latestErrorCode FROM sporades_schedules WHERE name='stopping'").get() }, {
      nextOccurrence: "2030-01-01T00:02:00.000Z",
      latestScheduledFor: "2030-01-01T00:01:00.000Z",
      latestOutcome: "enqueued",
      latestJobId: jobId,
      latestErrorCode: null,
    });
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Schedule evaluation starts after successful Capsule init and stops before Capsule shutdown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-hooks-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const events = [];
  let releaseInit;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => { events.push("job"); return null; }) },
    schedules: { hooked: schedule({ expression: "* * * * *", job: "work" }) },
    hooks: {
      init: async () => { events.push("init-start"); await new Promise((resolve) => { releaseInit = resolve; }); events.push("init-end"); },
      shutdown: () => { events.push("shutdown"); },
    },
  }, { clock });
  try {
    const initializing = database.init();
    while (!releaseInit) await Promise.resolve();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(events, ["init-start"]);
    releaseInit();
    await initializing;
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    await database.shutdown();
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.deepEqual(events, ["init-start", "init-end", "job", "shutdown"]);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }

  const failedDir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-init-failed-"));
  const failedClock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let ran = false;
  const failed = await openDevDatabase(path.join(failedDir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => { ran = true; return null; }) }, schedules: { hooked: schedule({ expression: "* * * * *", job: "work" }) }, hooks: { init: () => { throw new Error("init failed"); } },
  }, { clock: failedClock });
  try {
    await assert.rejects(failed.init(), /init failed/);
    failedClock.advanceBy(60_000);
    await failedClock.runDueTimers();
    assert.equal(ran, false);
  } finally { failed.close(); await rm(failedDir, { recursive: true, force: true }); }
});

test("invalid Schedule declarations reject Capsule startup as one unit", async () => {
  const cases = [
    ["invalid name", { "1bad": schedule({ expression: "* * * * *", job: "record" }) }],
    ["missing handler", { valid: schedule({ expression: "* * * * *", job: "missing" }) }],
    ["six fields", { valid: schedule({ expression: "0 * * * * *", job: "record" }) }],
    ["nickname", { valid: schedule({ expression: "@daily", job: "record" }) }],
    ["invalid payload", { valid: schedule({ expression: "* * * * *", job: "record", payload: Symbol("invalid") }) }],
    ["blank factory payload version", { valid: schedule({ expression: "* * * * *", job: "record", payload: () => null, payloadVersion: " " }) }],
    ["oversized factory payload version", { valid: schedule({ expression: "* * * * *", job: "record", payload: () => null, payloadVersion: "x".repeat(129) }) }],
    ["static payload version", { valid: schedule({ expression: "* * * * *", job: "record", payload: null, payloadVersion: "not-a-factory" }) }],
    ["invalid retry", { valid: schedule({ expression: "* * * * *", job: "record", retry: { maxAttempts: 0 } }) }],
    ["invalid missed-run policy", { valid: schedule({ expression: "* * * * *", job: "record", missedRun: "all" }) }],
  ];
  for (const [label, schedules] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-invalid-"));
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, { jobs: { record: job(() => null) }, schedules }), { name: "Error" }, label);
    await rm(dir, { recursive: true, force: true });
  }
});
