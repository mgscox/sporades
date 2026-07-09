import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";

function auth(userId) {
  return { userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
}

test("current users can enqueue, execute, get, and list their own durable jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-"));
  const seen = [];
  const capsule = {
    jobs: {
      record: job(async (ctx, input) => {
        seen.push({ userId: ctx.auth.userId, input });
        return { recorded: input.value };
      }),
      explode: job(() => { throw new Error("TOKEN=super-secret Cookie=session-cookie request-body=private"); }),
    },
    mutations: {
      enqueue: mutation((ctx, input) => ctx.jobs.enqueue("record", input, { idempotencyKey: "once" })),
      enqueueThenFail: mutation(async (ctx) => {
        await ctx.jobs.enqueue("record", { value: "survives-rollback" });
        throw new Error("app mutation rolled back");
      }),
      enqueueFailure: mutation((ctx) => ctx.jobs.enqueue("explode", { value: "secret-payload" })),
      getJob: mutation((ctx, id) => ctx.jobs.get(id)),
      listJobs: mutation((ctx, options) => ctx.jobs.list(options)),
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, capsule);
  try {
    database.sqlite.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("user-a", new Date().toISOString(), "user-a", null, null, 0, 1, "anonymous");
    const first = await runMutation(database, auth("user-a"), "enqueue", [{ value: "hello" }]);
    const duplicate = await runMutation(database, auth("user-a"), "enqueue", [{ value: "ignored" }]);
    assert.equal(first.ok, true);
    assert.equal(first.data.id, duplicate.data.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const completed = await runMutation(database, auth("user-a"), "getJob", [first.data.id]);
    assert.deepEqual(completed.data, {
      id: first.data.id,
      handler: "record",
      status: "succeeded",
      enqueuedBy: { userId: "user-a" },
      actor: { mode: "current-user", userId: "user-a" },
      attempts: 1,
      result: { recorded: "hello" },
    });
    assert.deepEqual(seen, [{ userId: "user-a", input: { value: "hello" } }]);
    const hidden = await runMutation(database, auth("user-b"), "getJob", [first.data.id]);
    assert.equal(hidden.data, null);
    const list = await runMutation(database, auth("user-a"), "listJobs", []);
    assert.deepEqual(list.data, { jobs: [{ id: first.data.id, handler: "record", status: "succeeded", attempts: 1 }], nextCursor: null });

    const rolledBack = await runMutation(database, auth("user-a"), "enqueueThenFail", []);
    assert.equal(rolledBack.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterRollback = await runMutation(database, auth("user-a"), "listJobs", []);
    assert.equal(afterRollback.data.jobs.some((entry) => entry.handler === "record"), true);
    assert.equal(seen.some((entry) => entry.input.value === "survives-rollback"), true);

    const failed = await runMutation(database, auth("user-a"), "enqueueFailure", []);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failedState = await runMutation(database, auth("user-a"), "getJob", [failed.data.id]);
    assert.equal(failedState.data.failure.code, "JOB_FAILED");
    assert.equal(failedState.data.failure.message, "Job handler failed.");
    assert.equal(JSON.stringify(failedState.data).includes("super-secret"), false);

    await runMutation(database, auth("user-a"), "enqueue", [{ value: "other" }]);
    const firstPage = await runMutation(database, auth("user-a"), "listJobs", [{ limit: 1 }]);
    assert.equal(firstPage.data.jobs.length, 1);
    assert.ok(firstPage.data.nextCursor);
    const secondPage = await runMutation(database, auth("user-a"), "listJobs", [{ limit: 10, cursor: firstPage.data.nextCursor }]);
    assert.equal(secondPage.data.jobs.some((entry) => entry.id === firstPage.data.jobs[0].id), false);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
