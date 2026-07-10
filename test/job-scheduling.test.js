import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, openDevDatabase } from "../dist/server-runtime-source.js";
import { job, mutation, schedule } from "../dist/server.js";
import { runMutation } from "../dist/server-runtime-source.js";

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

    const rows = database.sqlite.prepare("SELECT * FROM sporades_jobs").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduleName, "everyMinute");
    assert.equal(rows[0].scheduledFor, "2030-01-01T00:01:00.000Z");
  } finally {
    await database.shutdown();
    database.close();
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

test("Scheduled provenance is present at the atomic enqueue boundary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-provenance-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  let database;
  let observed;
  database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { inspect: job(() => { observed = database.sqlite.prepare("SELECT scheduleName, scheduledFor FROM sporades_jobs").get(); return null; }) },
    schedules: { atomic: schedule({ expression: "* * * * *", job: "inspect" }) },
  }, { clock });
  try {
    const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
    database.sqlite.prepare = (sql) => {
      if (String(sql).startsWith("UPDATE sporades_jobs SET scheduleName=")) throw new Error("post-enqueue provenance write is forbidden");
      return originalPrepare(sql);
    };
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual({ ...observed }, { scheduleName: "atomic", scheduledFor: "2030-01-01T00:01:00.000Z" });
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
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
    const row = database.sqlite.prepare("SELECT scheduleName, scheduledFor FROM sporades_jobs WHERE id=?").get(result.data.id);
    assert.deepEqual({ ...row }, { scheduleName: null, scheduledFor: null });
    assert.deepEqual(result.data.enqueuedBy, { mode: "user", userId: "attacker" });
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Scheduled idempotent returns reject an existing Job without matching private provenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-idempotency-conflict-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const occurrenceKey = "schedule:collision:2030-01-01T00:01:00.000Z";
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
    const rows = database.sqlite.prepare("SELECT scheduleName, scheduledFor FROM sporades_jobs").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ scheduleName: null, scheduledFor: null }]);
    const logs = await database.sqlite.readRecentLogEvents(20);
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
  }, { clock });
  try {
    const originalPrepare = database.sqlite.prepare.bind(database.sqlite);
    let rejectOnce = true;
    database.sqlite.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (rejectOnce && String(sql).startsWith("INSERT INTO sporades_jobs")) return { ...statement, run() { rejectOnce = false; throw new Error("queue unavailable"); } };
      return statement;
    };
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.equal(runs, 0);
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.equal(runs, 1);
    const logs = await database.sqlite.readRecentLogEvents(20);
    assert.equal(logs.some((entry) => entry.event === "schedule.occurrence.enqueue_failed"), true);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown stops future occurrences and awaits an active occurrence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-shutdown-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { work: job(() => null) }, schedules: { stopping: schedule({ expression: "* * * * *", job: "work" }) },
  }, { clock });
  let release;
  try {
    const originalEmit = database.audit.emit.bind(database.audit);
    database.audit.emit = async (details) => {
      if (details.operation === "schedules.enqueue" && details.outcome === "started") await new Promise((resolve) => { release = resolve; });
      return originalEmit(details);
    };
    await database.init();
    clock.advanceBy(30_000);
    const occurrence = clock.runDueTimers();
    while (!release) await Promise.resolve();
    let stopped = false;
    const shutdown = database.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await occurrence;
    await shutdown;
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
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
    ["invalid payload", { valid: schedule({ expression: "* * * * *", job: "record", payload: () => null }) }],
    ["invalid retry", { valid: schedule({ expression: "* * * * *", job: "record", retry: { maxAttempts: 0 } }) }],
  ];
  for (const [label, schedules] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-invalid-"));
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, { jobs: { record: job(() => null) }, schedules }), { name: "Error" }, label);
    await rm(dir, { recursive: true, force: true });
  }
});
