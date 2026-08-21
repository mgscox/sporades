import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";

const auth = { userId: "user-a", displayName: "user-a", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };

test("the full runtime can advance delayed Job timers without sleeping or replacing globals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-runtime-clock-"));
  const clock = createControllableRuntimeClock("2029-12-31T23:59:00.000Z");
  clock.setInstant("2030-01-01T00:00:00.000Z");
  let attempts = 0;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "clock" }, {
    jobs: {
      retry: job(() => {
        attempts += 1;
        if (attempts === 1) throw new Error("retry me");
        return { attempt: attempts };
      }),
    },
    mutations: {
      enqueue: mutation((ctx) => ctx.jobs.enqueue("retry", {}, {
        availableAt: "2030-01-01T00:01:00.000Z",
        retry: { maxAttempts: 2, delayMs: 30_000 },
      })),
      get: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  }, { clock });
  await database.init();

  try {
    database.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("user-a", clock.now().toISOString(), "user-a", null, null, 0, 1, "anonymous");

    const queued = await runMutation(database, auth, "enqueue", []);
    assert.equal(queued.data.status, "delayed");
    await clock.runDueTimers();
    assert.equal(attempts, 0);

    clock.advanceBy(60_001);
    await clock.runDueTimers();
    assert.equal(attempts, 1);
    assert.equal((await runMutation(database, auth, "get", [queued.data.id])).data.status, "delayed");

    clock.advanceBy(30_001);
    await clock.runDueTimers();
    assert.equal(attempts, 2);
    const completed = (await runMutation(database, auth, "get", [queued.data.id])).data;
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { attempt: 2 });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
