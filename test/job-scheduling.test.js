import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, openDevDatabase } from "../dist/server-runtime-source.js";
import { job, schedule } from "../dist/server.js";

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
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [{ userId: "__privileged__", payload: { source: "static" } }]);

    const rows = database.sqlite.prepare("SELECT * FROM sporades_jobs").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduleName, "everyMinute");
    assert.equal(rows[0].scheduledFor, "2030-01-01T00:01:00.000Z");
  } finally {
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
    assert.deepEqual(database.schedules.map(({ name, enabled }) => ({ name, enabled })), [{ name: "active", enabled: true }, { name: "dormant", enabled: false }]);
    clock.advanceBy(30_000);
    await clock.runDueTimers();
    assert.deepEqual(seen, [null]);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
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
