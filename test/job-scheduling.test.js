import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, createPostgresDatabaseAdapter, enqueueScheduledOccurrence, openDevDatabase } from "../dist/server-runtime-source.js";
import { job, mutation, schedule } from "../dist/server.js";
import { runMutation } from "../dist/server-runtime-source.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

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
    assert.equal(database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2030-01-01T17:00:00.000Z");
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
      assert.equal(database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, expected, label);
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
    assert.equal(database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2104-02-29T00:00:00.000Z");
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
    assert.equal(database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2030-06-03T00:00:00.000Z");
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
    assert.equal(database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs").get().scheduledFor, "2024-03-11T06:30:00.000Z");
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
    const occurrences = database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs ORDER BY scheduledFor").all().map((row) => row.scheduledFor);
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
      plain: schedule({ expression: "* * * * *", job: "record", payload: () => ({ kind: "plain" }) }),
      explicit: schedule({ expression: "* * * * *", job: "record", payload: (_occurrence, ctx) => ctx.privileged.run({ operation: "schedules.payload.read", targetResourceKind: "database" }, () => ({ kind: "explicit" })) }),
    },
  }, { clock });
  try {
    const audits = [];
    const originalEmit = database.audit.emit.bind(database.audit);
    database.audit.emit = async (details) => { audits.push(details); return originalEmit(details); };
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(audits.filter((event) => event.outcome === "started" && event.operation.startsWith("schedules.")).map((event) => event.operation), [
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
    schedules: { resilient: schedule({ expression: "* * * * *", job: "record", payload: async () => { calls += 1; if (calls === 1) throw new Error("secret detail"); return { calls }; } }) },
  }, { clock });
  try {
    await database.init();
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, []);
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [{ calls: 2 }]);
    const logs = await database.sqlite.readRecentLogEvents(20);
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
      rejected: schedule({ expression: "* * * * *", job: "record", payload: () => Promise.reject(new Error("private rejection")) }),
      invalid: schedule({ expression: "* * * * *", job: "record", payload: () => ({ value: 1n }) }),
    },
  }, { clock });
  try {
    await Promise.all(database.schedules.map((definition) => enqueueScheduledOccurrence(database, definition, new Date("2030-01-01T00:01:00.000Z"))));
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    assert.equal(database.schedulePayloadFactoryLanes.size, 0);
    const failures = (await database.sqlite.readRecentLogEvents(20)).filter((entry) => entry.event === "schedule.occurrence.payload_failed");
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
    schedules: { slow: schedule({ expression: "* * * * *", job: "record", payload: (_occurrence, ctx) => { signal = ctx.signal; return new Promise((resolve) => { resolveFactory = resolve; }); } }) },
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
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
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
    schedules[name] = schedule({ expression: "* * * * *", job: name, payload: () => new Promise((resolve) => { started.push(name); releases.push(() => resolve({ name })); }) });
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

test("concurrent occurrences of one Schedule serialize payload factory evaluation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-factory-lane-"));
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, {
    jobs: { record: job(() => null) },
    schedules: { serial: schedule({ expression: "* * * * *", job: "record", payload: () => new Promise((resolve) => {
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
      const rows = await database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs WHERE scheduleName='recurring' ORDER BY scheduledFor").all();
      assert.deepEqual(rows.map((row) => row.scheduledFor), expected);
      const state = await database.sqlite.prepare("SELECT nextOccurrence, missedRunPolicy, enabled FROM sporades_schedules WHERE name='recurring'").get();
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
    const row = await database.sqlite.prepare("SELECT scheduledFor FROM sporades_jobs WHERE scheduleName='late'").get();
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
  let state = await database.sqlite.prepare("SELECT enabled, nextOccurrence FROM sporades_schedules WHERE name='kept'").get();
  assert.deepEqual({ ...state }, { enabled: 1, nextOccurrence: "2030-01-01T00:04:00.000Z" });
  await database.shutdown(); database.close();
  database = await open({ renamed: schedule({ expression: "* * * * *", job: "record" }) });
  try {
    await database.init();
    const names = await database.sqlite.prepare("SELECT name FROM sporades_schedules ORDER BY name").all();
    assert.deepEqual(names.map((row) => row.name), ["renamed"]);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
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
    const rows = await database.sqlite.prepare("SELECT name, expression, nextOccurrence FROM sporades_schedules ORDER BY name").all();
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
    schedules: { active: schedule({ expression: "* * * * *", job: "record", payload: (_occurrence, ctx) => {
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
    assert.equal((await database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_jobs").get()).count, 0);
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
      const state = await database.sqlite.prepare("SELECT expression, nextOccurrence FROM sporades_schedules WHERE name=?").get("durable");
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
    assert.equal((await database.sqlite.prepare("SELECT nextOccurrence FROM sporades_schedules WHERE name=?").get("durable")).nextOccurrence, "2030-01-01T00:01:00.000Z");
  } finally { await database.shutdown(); await database.close(); }
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
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    database.close();

    clock.advanceBy(31_000);
    database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock });
    await database.init();
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
    const occurrence = database.sqlite.prepare("SELECT status, jobId FROM sporades_schedule_occurrences").get();
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
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    clock.advanceBy(30_000); await clock.runDueTimers();
    assert.equal(database.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
  } finally { await database.shutdown(); database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a restart after enqueue reuses one deterministic occurrence Job", async () => {
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
    const firstId = database.sqlite.prepare("SELECT id FROM sporades_jobs").get().id;
    database.close();
    clock.advanceBy(31_000);
    database = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock });
    await database.init();
    const jobs = database.sqlite.prepare("SELECT id FROM sporades_jobs").all();
    assert.deepEqual(jobs.map((row) => row.id), [firstId]);
    assert.equal(database.sqlite.prepare("SELECT jobId FROM sporades_schedule_occurrences").get().jobId, firstId);
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
    const jobs = first.sqlite.prepare("SELECT id FROM sporades_jobs").all();
    const occurrences = first.sqlite.prepare("SELECT id, jobId, status FROM sporades_schedule_occurrences").all();
    assert.equal(jobs.length, 1);
    assert.deepEqual(occurrences.map(({ jobId, status }) => ({ jobId, status })), [{ jobId: jobs[0].id, status: "enqueued" }]);
  } finally { await Promise.all([first.shutdown(), second.shutdown()]); first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an overlapping loser recovers after the winner crashes with an active claim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-overlap-winner-crash-"));
  const file = path.join(dir, "data.db");
  const clockA = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const clockB = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const capsule = { jobs: { work: job(() => null) }, schedules: { shared: schedule({ expression: "* * * * *", job: "work" }) } };
  let first;
  first = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockA, scheduleOccurrenceFault: (boundary) => {
    if (boundary === "after-pending") { first.__scheduleStopped = true; throw new Error("winner crashed"); }
  } });
  const second = await openDevDatabase(file, "", {}, { name: "capsule-a" }, capsule, { clock: clockB });
  try {
    await first.init(); await second.init();
    clockA.advanceBy(30_000); clockB.advanceBy(30_000);
    await clockA.runDueTimers(); await clockB.runDueTimers();
    assert.equal(second.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 0);
    clockB.advanceBy(30_000); await clockB.runDueTimers();
    assert.equal(second.sqlite.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count, 1);
  } finally { first.close(); await second.shutdown(); second.close(); await rm(dir, { recursive: true, force: true }); }
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
    ["invalid payload", { valid: schedule({ expression: "* * * * *", job: "record", payload: Symbol("invalid") }) }],
    ["invalid retry", { valid: schedule({ expression: "* * * * *", job: "record", retry: { maxAttempts: 0 } }) }],
    ["invalid missed-run policy", { valid: schedule({ expression: "* * * * *", job: "record", missedRun: "all" }) }],
  ];
  for (const [label, schedules] of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedule-invalid-"));
    await assert.rejects(openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "scheduled" }, { jobs: { record: job(() => null) }, schedules }), { name: "Error" }, label);
    await rm(dir, { recursive: true, force: true });
  }
});
