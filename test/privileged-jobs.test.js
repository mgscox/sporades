import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";

const auth = (userId) => ({ userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" });

test("privileged runs enqueue, execute, inspect, and audit system-owned jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-privileged-jobs-"));
  const seen = [];
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    jobs: { maintain: job((ctx, payload) => { seen.push(ctx.auth.userId); return payload; }) },
    mutations: {
      enqueue: mutation((ctx) => ctx.privileged.run({ operation: "jobs.enqueue", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.enqueue("maintain", { ok: true }))),
      get: mutation((ctx, id) => ctx.privileged.run({ operation: "jobs.get", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.get(id))),
      list: mutation((ctx) => ctx.privileged.run({ operation: "jobs.list", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.list())),
    },
  });
  try {
    const queued = await runMutation(database, auth("user-a"), "enqueue", []);
    assert.equal(queued.ok, true);
    assert.deepEqual(queued.data.actor, { mode: "privileged-server-role" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(seen, ["__privileged__"]);
    assert.equal((await runMutation(database, auth("user-a"), "get", [queued.data.id])).data.id, queued.data.id);
    assert.equal((await runMutation(database, auth("user-a"), "list", [])).data.jobs.some((entry) => entry.id === queued.data.id), true);
    const audit = await database.sqlite.readRecentLogEvents(20);
    assert.equal(audit.some((event) => event.event === "privileged.started" && JSON.stringify(event).includes(queued.data.id)), true);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});
