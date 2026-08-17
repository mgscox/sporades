import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, openDevDatabase as openStoppedDevDatabase, runAppMessage, runCurrentUserJobWorker, runEndpoint, runMutation } from "../dist/server-runtime-source.js";
import { String, job, mutation, table } from "../dist/server.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";

function auth(userId) {
  return { userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
}

async function openDevDatabase(...args) {
  const database = await openStoppedDevDatabase(...args);
  await database.init();
  return database;
}

test("concurrent Postgres mutations converge one idempotent Job inside their handler transactions", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-postgres-race-"));
  const appTableName = "ticket04_postgres_job_race_writes";
  const definition = {
    schema: { [appTableName]: table({ mutationId: String() }) },
    jobs: { record: job((_ctx, payload) => payload) },
    mutations: {
      enqueueSame: mutation(async (ctx, mutationId) => {
        await ctx.db[appTableName].insert({ mutationId });
        const queued = await ctx.jobs.enqueue("record", { mutationId }, {
          idempotencyKey: "shared-postgres-race",
          availableAt: "2999-01-01T00:00:00.000Z",
        });
        return { jobId: queued.id };
      }),
      inspectRace: mutation(async (ctx) => ({
        writes: await ctx.db[appTableName].all(),
        jobs: (await ctx.jobs.list({ handler: "record" })).jobs,
      })),
    },
  };
  const config = { name: "job-postgres-race", services: { database: { engine: "postgres" } } };
  const env = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  let firstDatabase;
  let secondDatabase;
  try {
    await withPostgresAdapter(async () => {}, { appTableNames: [appTableName] });
    const initializer = await openDevDatabase(path.join(dir, "initializer.db"), "", env, config, definition, {
      clock: createControllableRuntimeClock("2030-01-01T00:00:00.000Z"),
    });
    await initializer.close();
    firstDatabase = await openDevDatabase(path.join(dir, "first.db"), "", env, config, definition, {
      clock: createControllableRuntimeClock("2030-01-01T00:00:00.000Z"),
    });
    secondDatabase = await openDevDatabase(path.join(dir, "second.db"), "", env, config, definition, {
      clock: createControllableRuntimeClock("2030-01-01T00:00:00.000Z"),
    });
    const actor = auth(`postgres-job-${randomUUID()}`);
    const [first, second] = await Promise.all([
      runMutation(firstDatabase, actor, "enqueueSame", ["first"]),
      runMutation(secondDatabase, actor, "enqueueSame", ["second"]),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.data.jobId, second.data.jobId);
    const inspection = await runMutation(firstDatabase, actor, "inspectRace", []);
    assert.deepEqual(inspection.data.writes.map((row) => row.mutationId).sort(), ["first", "second"]);
    assert.equal(inspection.data.jobs.length, 1);
    assert.equal(inspection.data.jobs[0].id, first.data.jobId);
  } finally {
    await Promise.all([firstDatabase?.close(), secondDatabase?.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed mutation drops deferred Job enqueues with its rolled-back data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-mutation-rollback-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "job-mutation-rollback" }, {
    schema: { effects: table({ source: String() }) },
    jobs: { shouldNotRun: job((_ctx, payload) => payload) },
    mutations: {
      failAfterEnqueue: mutation(async (ctx) => {
        await ctx.db.effects.insert({ source: "mutation" });
        await ctx.jobs.enqueue("shouldNotRun", { source: "mutation" });
        throw new Error("mutation failed after enqueue");
      }),
      inspectRollback: mutation(async (ctx) => ({
        effects: await ctx.db.effects.all(),
        jobs: (await ctx.jobs.list({ handler: "shouldNotRun" })).jobs,
      })),
    },
  });
  try {
    const failed = await runMutation(database, auth("rollback-user"), "failAfterEnqueue", []);
    assert.equal(failed.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inspection = await runMutation(database, auth("rollback-user"), "inspectRollback", []);
    assert.deepEqual(inspection.data, { effects: [], jobs: [] });
    const audit = await database.adapter.readRecentLogEvents(50);
    assert.equal(audit.some((event) => event.data?.operation === "jobs.execute"), false);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("multiple Job enqueues cannot partially persist when a later enqueue fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-multiple-rollback-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "job-multiple-rollback" }, {
    jobs: { record: job((_ctx, payload) => payload) },
    mutations: {
      enqueueTwice: mutation(async (ctx) => {
        await ctx.jobs.enqueue("record", { sequence: 1 });
        await ctx.jobs.enqueue("record", { sequence: 2 });
        return true;
      }),
      inspectJobs: mutation(async (ctx) => (await ctx.jobs.list({ handler: "record" })).jobs),
    },
  });
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000004",
    });
    const failed = await runMutation(database, auth("rollback-user"), "enqueueTwice", []);
    assert.equal(failed.ok, false);
    delete globalThis.crypto.randomUUID;
    const jobs = await runMutation(database, auth("rollback-user"), "inspectJobs", []);
    assert.deepEqual(jobs.data, []);
  } finally {
    delete globalThis.crypto.randomUUID;
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a post-commit dispatch failure does not misreport committed handler work and can be retried", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-dispatch-retry-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "job-dispatch-retry" }, {
    schema: { effects: table({ source: String() }) },
    jobs: { record: job((_ctx, payload) => payload) },
    mutations: {
      enqueue: mutation(async (ctx, source) => {
        await ctx.db.effects.insert({ source });
        return await ctx.jobs.enqueue("record", { source }, { idempotencyKey: source });
      }),
      inspect: mutation(async (ctx) => ({
        effects: await ctx.db.effects.all(),
        jobs: (await ctx.jobs.list({ handler: "record" })).jobs,
      })),
    },
  });
  database.adapter.prepare(
    "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("dispatch-user", new Date().toISOString(), "Dispatch User", null, null, 0, 1, "anonymous");
  const setTimer = database.clock.setTimer.bind(database.clock);
  let failNextDispatch = true;
  database.clock.setTimer = (callback, delay) => {
    if (failNextDispatch) {
      failNextDispatch = false;
      throw new Error("dispatch timer unavailable");
    }
    return setTimer(callback, delay);
  };
  try {
    const first = await runMutation(database, auth("dispatch-user"), "enqueue", ["first"]);
    assert.equal(first.ok, true);
    const second = await runMutation(database, auth("dispatch-user"), "enqueue", ["second"]);
    assert.equal(second.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inspection = await runMutation(database, auth("dispatch-user"), "inspect", []);
    assert.deepEqual(inspection.data.effects.map((row) => row.source).sort(), ["first", "second"]);
    assert.deepEqual(inspection.data.jobs.map((row) => row.status).sort(), ["succeeded", "succeeded"]);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed message drops deferred Job enqueues with its rolled-back data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-message-rollback-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "job-message-rollback" }, {
    schema: { effects: table({ source: String() }) },
    jobs: { shouldNotRun: job((_ctx, payload) => payload) },
    mutations: {
      inspectRollback: mutation(async (ctx) => ({
        effects: await ctx.db.effects.all(),
        jobs: (await ctx.jobs.list({ handler: "shouldNotRun" })).jobs,
      })),
    },
  });
  try {
    database.messages = [{
      name: "failAfterEnqueue",
      handlerSource: `async (ctx) => {
        await ctx.db.effects.insert({ source: "message" });
        await ctx.jobs.enqueue("shouldNotRun", { source: "message" });
        throw new Error("message failed after enqueue");
      }`,
    }];
    const failed = await runAppMessage(database, auth("rollback-user"), "failAfterEnqueue", null);
    assert.match(failed.error.message, /message failed after enqueue/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inspection = await runMutation(database, auth("rollback-user"), "inspectRollback", []);
    assert.deepEqual(inspection.data, { effects: [], jobs: [] });
    const audit = await database.adapter.readRecentLogEvents(50);
    assert.equal(audit.some((event) => event.data?.operation === "jobs.execute"), false);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed endpoint rolls back its Job enqueue with its handler data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-endpoint-rollback-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "job-endpoint-rollback" }, {
    schema: { effects: table({ source: String() }) },
    jobs: { shouldNotRun: job((_ctx, payload) => payload) },
    mutations: {
      inspectRollback: mutation(async (ctx) => ({
        effects: await ctx.db.effects.all(),
        jobs: (await ctx.jobs.list({ handler: "shouldNotRun" })).jobs,
      })),
    },
  });
  try {
    await assert.rejects(
      runEndpoint(database, {
        handlerSource: `async (ctx) => {
          await ctx.db.effects.insert({ source: "endpoint" });
          await ctx.jobs.enqueue("shouldNotRun", { source: "endpoint" });
          throw new Error("endpoint failed after enqueue");
        }`,
      }, new URL("http://capsule.test/failing-job"), {
        method: "POST",
        headers: {},
        async *[Symbol.asyncIterator]() {},
      }),
      /endpoint failed after enqueue/,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const inspection = await runMutation(database, auth("rollback-user"), "inspectRollback", []);
    assert.deepEqual(inspection.data, { effects: [], jobs: [] });
    const audit = await database.adapter.readRecentLogEvents(50);
    assert.equal(audit.some((event) => event.data?.operation === "jobs.execute"), false);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("Jobs capture enqueue-time Session provider provenance across later provider switches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-provider-"));
  const seen = [];
  const capsule = {
    jobs: {
      recordProvider: job((ctx) => {
        seen.push(ctx.auth.provider);
        if (seen.length === 1) throw new Error("retry once");
        return ctx.auth.provider;
      }),
    },
    mutations: {
      enqueue: mutation((ctx) =>
        ctx.jobs.enqueue("recordProvider", null, {
          availableAt: "2999-01-01T00:00:00.000Z",
          retry: { maxAttempts: 2, delayMs: 0 },
        })),
    },
  };
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, capsule, { clock });
  try {
    const now = new Date().toISOString();
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("provider-user", now, "Provider User", null, null, 1, 0, "anonymous");
    database.adapter.prepare(
      "INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
    ).run("google-session", "provider-user", "google", now, "2999-01-01T00:00:00.000Z");

    const enqueued = await runMutation(database, {
      userId: "provider-user",
      displayName: "Provider User",
      email: null,
      picture: null,
      isAuthenticated: true,
      isGuest: false,
      provider: "google",
    }, "enqueue", []);
    assert.equal(enqueued.ok, true);

    database.adapter.prepare(
      "INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
    ).run("microsoft-session", "provider-user", "microsoft", new Date(Date.now() + 1_000).toISOString(), "2999-01-01T00:00:00.000Z");
    database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", enqueued.data.id);
    await runCurrentUserJobWorker(database);

    assert.deepEqual(seen, ["google", "google"]);
    assert.equal(database.adapter.prepare("SELECT actorProvider FROM sporades_jobs WHERE id = ?").get(enqueued.data.id).actorProvider, "google");
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable Jobs replay captured provider provenance after runtime restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-provider-restart-"));
  const databasePath = path.join(dir, "data.db");
  const seen = [];
  const capsule = {
    jobs: { recordProvider: job((ctx) => seen.push(ctx.auth.provider)) },
    mutations: {
      enqueue: mutation((ctx) =>
        ctx.jobs.enqueue("recordProvider", null, { availableAt: "2999-01-01T00:00:00.000Z" })),
    },
  };
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let database = await openDevDatabase(databasePath, "", {}, { name: "jobs" }, capsule, { clock });
  try {
    const now = clock.now().toISOString();
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("restart-user", now, "Restart User", null, null, 1, 0, "anonymous");
    const enqueued = await runMutation(database, {
      userId: "restart-user",
      displayName: "Restart User",
      email: null,
      picture: null,
      isAuthenticated: true,
      isGuest: false,
      provider: "facebook",
    }, "enqueue", []);
    database.close();

    database = await openDevDatabase(databasePath, "", {}, { name: "jobs" }, capsule, { clock });
    database.adapter.prepare(
      "INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
    ).run("later-email-session", "restart-user", "email", new Date(clock.now().getTime() + 1_000).toISOString(), "2999-01-01T00:00:00.000Z");
    database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", enqueued.data.id);
    await runCurrentUserJobWorker(database);

    assert.deepEqual(seen, ["facebook"]);
    assert.equal(database.adapter.prepare("SELECT actorProvider FROM sporades_jobs WHERE id = ?").get(enqueued.data.id).actorProvider, "facebook");
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy Jobs migrate to bounded anonymous provider provenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-provider-legacy-"));
  const databasePath = path.join(dir, "data.db");
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(databasePath);
  const now = "2030-01-01T00:00:00.000Z";
  try {
    legacy.exec(
      "CREATE TABLE sporades_jobs (" +
      "id TEXT PRIMARY KEY, handler TEXT NOT NULL, enqueuedByUserId TEXT NOT NULL, actorUserId TEXT NOT NULL, " +
      "payload TEXT NOT NULL, status TEXT NOT NULL, availableAt TEXT NOT NULL, attempts INTEGER NOT NULL, " +
      "idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT, failedAt TEXT)",
    );
    legacy.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("legacy-job", "recordProvider", "legacy-user", "legacy-user", "null", "queued", "2000-01-01T00:00:00.000Z", 0, now);
  } finally {
    legacy.close();
  }

  const seen = [];
  const clock = createControllableRuntimeClock(now);
  const database = await openDevDatabase(databasePath, "", {}, { name: "jobs" }, {
    jobs: { recordProvider: job((ctx) => seen.push(ctx.auth.provider)) },
  }, { clock });
  try {
    database.adapter.prepare(
      "INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("legacy-user", now, "Legacy User", null, null, 1, 0, "google");
    await runCurrentUserJobWorker(database);
    assert.deepEqual(seen, ["anonymous"]);
    assert.equal(database.adapter.prepare("SELECT actorProvider FROM sporades_jobs WHERE id = 'legacy-job'").get().actorProvider, "anonymous");
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
      enqueueTwice: mutation(async (ctx) => {
        const first = await ctx.jobs.enqueue("record", { value: "same-transaction" }, { idempotencyKey: "same-transaction" });
        const second = await ctx.jobs.enqueue("record", { value: "ignored" }, { idempotencyKey: "same-transaction" });
        return { first, second };
      }),
      enqueueThenFail: mutation(async (ctx) => {
        await ctx.jobs.enqueue("record", { value: "dropped-on-rollback" });
        throw new Error("app mutation rolled back");
      }),
      enqueueFailure: mutation((ctx) => ctx.jobs.enqueue("explode", { value: "secret-payload" })),
      getJob: mutation((ctx, id) => ctx.jobs.get(id)),
      listJobs: mutation((ctx, options) => ctx.jobs.list(options)),
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, capsule);
  try {
    database.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("user-a", new Date().toISOString(), "user-a", null, null, 0, 1, "anonymous");
    const first = await runMutation(database, auth("user-a"), "enqueue", [{ value: "hello" }]);
    const duplicate = await runMutation(database, auth("user-a"), "enqueue", [{ value: "ignored" }]);
    assert.equal(first.ok, true);
    assert.equal(first.data.id, duplicate.data.id);
    const repeated = await runMutation(database, auth("user-a"), "enqueueTwice", []);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.data.first.id, repeated.data.second.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const completed = await runMutation(database, auth("user-a"), "getJob", [first.data.id]);
    assert.deepEqual({ ...completed.data, attemptHistory: undefined }, {
      id: first.data.id,
      handler: "record",
      status: "succeeded",
      enqueuedBy: { mode: "user", userId: "user-a" },
      actor: { mode: "current-user", userId: "user-a" },
      attempts: 1,
      result: { recorded: "hello" },
      attemptHistory: undefined,
    });
    assert.equal(seen.some((entry) => entry.userId === "user-a" && entry.input.value === "hello"), true);
    const hidden = await runMutation(database, auth("user-b"), "getJob", [first.data.id]);
    assert.equal(hidden.data, null);
    const list = await runMutation(database, auth("user-a"), "listJobs", []);
    assert.deepEqual(list.data.jobs.find((entry) => entry.id === first.data.id), { id: first.data.id, handler: "record", status: "succeeded", attempts: 1 });

    const rolledBack = await runMutation(database, auth("user-a"), "enqueueThenFail", []);
    assert.equal(rolledBack.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterRollback = await runMutation(database, auth("user-a"), "listJobs", []);
    assert.equal(afterRollback.data.jobs.some((entry) => entry.handler === "record"), true);
    assert.equal(seen.some((entry) => entry.input.value === "dropped-on-rollback"), false);
    assert.equal((await runMutation(database, auth("user-a"), "listJobs", [])).data.jobs.filter((entry) => entry.id === repeated.data.first.id).length, 1);

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

    const endpointJob = await runEndpoint(database, { handlerSource: "async (ctx) => ctx.jobs.enqueue('record', { value: 'endpoint' })" }, new URL("http://capsule.test/jobs"), { method: "POST", headers: {}, async *[Symbol.asyncIterator]() {} });
    database.messages = [{ name: "enqueueMessage", handlerSource: "async (ctx, data) => ctx.jobs.enqueue('record', data)" }];
    const messageJob = await runAppMessage(database, auth("user-a"), "enqueueMessage", { value: "message" });
    assert.ok(endpointJob.id);
    assert.ok(messageJob.data.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(seen.some((entry) => entry.input.value === "endpoint"), true);
    assert.equal(seen.some((entry) => entry.input.value === "message"), true);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
