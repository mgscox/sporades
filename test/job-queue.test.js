import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createControllableRuntimeClock, inspectRuntimeJobs, openDevDatabase as openStoppedDevDatabase, runAppMessage, runCurrentUserJobWorker, runEndpoint, runMutation } from "../dist/server-runtime-source.js";
import { deleteCurrentAuthUser } from "../dist/auth-runtime.js";
import { applyFileAcl } from "../dist/acl-runtime.js";
import { Boolean as BooleanField, String, job, mutation, requireAuth, table } from "../dist/server.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

function auth(userId) {
  return { userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
}

async function openDevDatabase(...args) {
  const database = await openStoppedDevDatabase(...args);
  await database.init();
  return database;
}

async function waitForJobCondition(read, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
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
        seen.push({
          provider: ctx.auth.provider,
          credential: ctx.credential,
          credentialFrozen: Object.isFrozen(ctx.credential),
          authFrozen: Object.isFrozen(ctx.auth),
        });
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

    assert.deepEqual(seen, [
      { provider: "google", credential: { kind: "session" }, credentialFrozen: true, authFrozen: true },
      { provider: "google", credential: { kind: "session" }, credentialFrozen: true, authFrozen: true },
    ]);
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

test("Access-key Jobs preserve bounded admission provenance through deletion, retry, restart, and child enqueue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-access-key-"));
  const databasePath = path.join(dir, "data.db");
  const owner = {
    userId: "job-key-owner",
    displayName: "Original Owner",
    email: "owner@example.com",
    picture: "https://example.com/original.png",
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const seen = [];
  let parentAttempts = 0;
  let database;
  const teamId = randomUUID();
  const fileRow = {
    id: randomUUID(), ownerUserId: owner.userId, path: "/jobs/protected.txt", name: "protected.txt",
    type: "text/plain", size: 9, status: "ready", version: 1,
    createdAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z",
  };
  const definition = {
    accessKeys: { scopes: ["jobs:enqueue"] },
    schema: {
      visibleItems: table({ ownerId: String(), visible: BooleanField() }).acl({ read: ({ row }) => row.visible }),
      teamItems: table({ teamId: String(), body: String() }).acl({ read: ({ row, ctx }) => ctx.acl.teams.isMember(row.teamId) }),
    },
    files: { acl: { read: ({ ctx }) => ctx.acl.teams.isMember(teamId) } },
    jobs: {
      parent: job(async (ctx) => {
        seen.push({
          handler: "parent", auth: ctx.auth, credential: ctx.credential,
          visibleCount: (await ctx.db.visibleItems.all()).length,
          teamCount: (await ctx.db.teamItems.all()).length,
          fileAllowed: await applyFileAcl(database, "read", fileRow, ctx.auth, ctx.credential),
        });
        ctx.log.info("durable parent");
        parentAttempts += 1;
        if (parentAttempts === 1) throw new Error("retry once");
        return await ctx.jobs.enqueue("child", null, { availableAt: "2999-01-01T00:00:00.000Z" });
      }),
      child: job(async (ctx) => {
        seen.push({
          handler: "child", auth: ctx.auth, credential: ctx.credential,
          visibleCount: (await ctx.db.visibleItems.all()).length,
          teamCount: (await ctx.db.teamItems.all()).length,
          fileAllowed: await applyFileAcl(database, "read", fileRow, ctx.auth, ctx.credential),
        });
        ctx.log.info("durable child");
        return null;
      }),
    },
    mutations: {
      createVisible: mutation((ctx) => ctx.db.visibleItems.insert({ ownerId: ctx.auth.userId, visible: true })),
      createTeamItem: mutation((ctx) => ctx.db.teamItems.insert({ teamId, body: "current membership only" })),
      issue: mutation((ctx) => ctx.accessKeys.issue({ name: "automation", grants: ["jobs:enqueue"] })),
      revoke: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
      remove: mutation((ctx, id) => ctx.accessKeys.delete(id)),
    },
  };
  const endpointHandler = requireAuth({ credentials: ["access-key"], scopes: ["jobs:enqueue"] }, (ctx) =>
    ctx.jobs.enqueue("parent", null, {
      availableAt: "2999-01-01T00:00:00.000Z",
      retry: { maxAttempts: 2, delayMs: 0 },
    }));
  database = await openDevDatabase(databasePath, "", {}, { name: "job-access-key" }, definition);
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId,
      createdAt: "2026-08-20T12:00:00.000Z",
      displayName: owner.displayName,
      email: owner.email,
      picture: owner.picture,
      isAuthenticated: 1,
      isGuest: 0,
      provider: owner.provider,
    });
    database.adapter.prepare("INSERT INTO sporades_teams (id, name, createdAt, createdByUserId) VALUES (?, ?, ?, ?)")
      .run(teamId, "Job authority team", "2026-08-20T12:00:00.000Z", owner.userId);
    database.adapter.prepare("INSERT INTO sporades_team_memberships (teamId, userId, role, createdAt) VALUES (?, ?, 'member', ?)")
      .run(teamId, owner.userId, "2026-08-20T12:00:00.000Z");
    await runMutation(database, owner, "createVisible", []);
    await runMutation(database, owner, "createTeamItem", []);
    const issued = await runMutation(database, owner, "issue", []);
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const admitted = await runEndpoint(database, { handler: endpointHandler }, new URL("http://capsule.test/jobs"), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.data.token}` },
      async *[Symbol.asyncIterator]() {},
    });
    assert.deepEqual(admitted.enqueuedBy, {
      mode: "user",
      userId: owner.userId,
      credential: { kind: "access-key", id: issued.data.accessKey.id, name: "automation" },
    });
    const operatorState = (await inspectRuntimeJobs(database.adapter)).find((jobState) => jobState.id === admitted.id);
    assert.deepEqual(operatorState.enqueuedBy, admitted.enqueuedBy);
    assert.deepEqual(operatorState.actor, { mode: "current-user", userId: owner.userId });
    const stored = database.adapter.prepare(
      "SELECT authSnapshotJson, credentialJson FROM sporades_jobs WHERE id = ?",
    ).get(admitted.id);
    assert.deepEqual(JSON.parse(stored.authSnapshotJson), { ...owner, provider: "access-key" });
    assert.deepEqual(JSON.parse(stored.credentialJson), {
      kind: "access-key",
      id: issued.data.accessKey.id,
      name: "automation",
    });
    assert.equal(JSON.stringify(stored).includes(issued.data.token), false);
    assert.equal(/selector|verifier|grant|scope/i.test(JSON.stringify(stored)), false);

    await runMutation(database, owner, "revoke", [issued.data.accessKey.id]);
    await runMutation(database, owner, "remove", [issued.data.accessKey.id]);
    const replacement = await runMutation(database, owner, "issue", []);
    assert.notEqual(replacement.data.accessKey.id, issued.data.accessKey.id);
    database.adapter.prepare("UPDATE visibleItems SET visible = 0 WHERE ownerId = ?").run(owner.userId);
    database.adapter.prepare("DELETE FROM sporades_team_memberships WHERE teamId = ? AND userId = ?").run(teamId, owner.userId);
    await deleteCurrentAuthUser(database, { kind: "mutation", auth: owner, credential: { kind: "session" } });
    assert.equal(database.adapter.prepare("SELECT id FROM sporades_auth_users WHERE id = ?").get(owner.userId), undefined);
    database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", admitted.id);
    database.close();

    database = await openDevDatabase(databasePath, "", {}, { name: "job-access-key" }, definition);
    await runCurrentUserJobWorker(database);
    const child = database.adapter.prepare("SELECT * FROM sporades_jobs WHERE handler = 'child'").get();
    assert.ok(child);
    assert.deepEqual(JSON.parse(child.authSnapshotJson), { ...owner, provider: "access-key" });
    assert.deepEqual(JSON.parse(child.credentialJson), {
      kind: "access-key",
      id: issued.data.accessKey.id,
      name: "automation",
    });
    database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", child.id);
    await runCurrentUserJobWorker(database);

    assert.equal(parentAttempts, 2);
    assert.equal(seen.length, 3);
    for (const entry of seen) {
      assert.deepEqual(entry.auth, { ...owner, provider: "access-key" });
      assert.deepEqual(entry.credential, {
        kind: "access-key",
        id: issued.data.accessKey.id,
        name: "automation",
      });
      assert.equal(entry.visibleCount, 0, "Job ACLs must read current resource state");
      assert.equal(entry.teamCount, 0, "Job Team ACLs must read current membership state");
      assert.equal(entry.fileAllowed, false, "Job File ACLs must read current membership state");
      assert.equal(Object.isFrozen(entry.auth), true);
      assert.equal(Object.isFrozen(entry.credential), true);
    }
    const events = await database.adapter.readRecentLogEvents(50);
    for (const event of events.filter((entry) => entry.message?.startsWith("durable "))) {
      assert.deepEqual(event.data.actor, { userId: owner.userId });
      assert.deepEqual(event.data.credential, {
        kind: "access-key",
        id: issued.data.accessKey.id,
        name: "automation",
      });
    }
  } finally {
    database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retained Job provenance must match its actor and fails terminally before handler claim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-invalid-provenance-"));
  let handlerCalls = 0;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-job-provenance" }, {
    jobs: { work: job(() => { handlerCalls += 1; return null; }) },
  });
  try {
    const now = new Date().toISOString();
    const insert = database.adapter.prepare(
      "INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, actorProvider, authSnapshotJson, credentialJson, payload, status, availableAt, attempts, createdAt, retryJson, attemptHistory, scheduleName) " +
      "VALUES (?, 'work', ?, ?, 'email', ?, ?, 'null', 'queued', ?, 0, ?, ?, '[]', ?)",
    );
    insert.run(
      "mismatched-actor", "actor-a", "actor-a",
      JSON.stringify({ userId: "actor-b", displayName: "Actor B", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "email" }),
      JSON.stringify({ kind: "session" }), now, now, JSON.stringify({ maxAttempts: 3, delayMs: 0 }), null,
    );
    insert.run(
      "malformed-credential", "actor-a", "actor-a",
      JSON.stringify({ userId: "actor-a", displayName: "Actor A", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "email" }),
      JSON.stringify({ kind: "access-key", id: "key-a", name: "automation", token: "must-not-be-accepted" }),
      now, now, JSON.stringify({ maxAttempts: 3, delayMs: 0 }), null,
    );
    insert.run(
      "mismatched-scheduled-actor", "actor-a", "actor-a",
      JSON.stringify({ userId: "actor-b", displayName: "Actor B", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "email" }),
      JSON.stringify({ kind: "session" }), now, now, JSON.stringify({ maxAttempts: 3, delayMs: 0 }), "forged-schedule",
    );
    insert.run(
      "ordinary-scheduled-actor", "actor-a", "actor-a",
      JSON.stringify({ userId: "actor-a", displayName: "Actor A", email: null, picture: null, isAuthenticated: true, isGuest: false, provider: "email" }),
      JSON.stringify({ kind: "session" }), now, now, JSON.stringify({ maxAttempts: 3, delayMs: 0 }), "forged-schedule",
    );

    await runCurrentUserJobWorker(database);
    assert.equal(handlerCalls, 0);
    const rows = database.adapter.prepare("SELECT id, status, attempts, failure, attemptHistory FROM sporades_jobs ORDER BY id").all();
    assert.deepEqual(rows.map((row) => ({
      id: row.id,
      status: row.status,
      attempts: Number(row.attempts),
      failure: JSON.parse(row.failure),
      attemptHistory: JSON.parse(row.attemptHistory),
    })), [
      {
        id: "malformed-credential", status: "failed", attempts: 0,
        failure: { code: "JOB_CREDENTIAL_INVALID", message: "Stored Job Credential provenance is invalid." },
        attemptHistory: [],
      },
      {
        id: "mismatched-actor", status: "failed", attempts: 0,
        failure: { code: "JOB_ACTOR_SNAPSHOT_INVALID", message: "Stored Job actor provenance is invalid." },
        attemptHistory: [],
      },
      {
        id: "mismatched-scheduled-actor", status: "failed", attempts: 0,
        failure: { code: "JOB_ACTOR_SNAPSHOT_INVALID", message: "Stored Job actor provenance is invalid." },
        attemptHistory: [],
      },
      {
        id: "ordinary-scheduled-actor", status: "failed", attempts: 0,
        failure: { code: "JOB_ACTOR_SNAPSHOT_INVALID", message: "Stored Job actor provenance is invalid." },
        attemptHistory: [],
      },
    ]);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function proveAccessKeyJobLifecycleAcrossEngine({ databasePath, serverEnv = {}, config }) {
  const owner = {
    userId: `cross-engine-job-owner-${randomUUID()}`,
    displayName: "Cross-engine owner",
    email: null,
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  const keyName = `automation-${randomUUID()}`;
  const seen = [];
  let parentAttempts = 0;
  const definition = {
    accessKeys: { scopes: ["jobs:enqueue"] },
    jobs: {
      parent: job(async (ctx) => {
        seen.push({ handler: "parent", auth: ctx.auth, credential: ctx.credential });
        parentAttempts += 1;
        if (parentAttempts === 1) throw new Error("retry once");
        return await ctx.jobs.enqueue("child", null, { availableAt: "2999-01-01T00:00:00.000Z" });
      }),
      child: job((ctx) => seen.push({ handler: "child", auth: ctx.auth, credential: ctx.credential })),
    },
    mutations: {
      issue: mutation((ctx) => ctx.accessKeys.issue({ name: keyName, grants: ["jobs:enqueue"] })),
      revoke: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
      remove: mutation((ctx, id) => ctx.accessKeys.delete(id)),
      enqueueThenFail: mutation(async (ctx) => {
        await ctx.jobs.enqueue("child", null, { idempotencyKey: "must-roll-back" });
        throw new Error("roll back enqueue");
      }),
    },
  };
  const endpointHandler = requireAuth({ credentials: ["access-key"], scopes: ["jobs:enqueue"] }, (ctx) =>
    ctx.jobs.enqueue("parent", null, {
      availableAt: "2999-01-01T00:00:00.000Z",
      retry: { maxAttempts: 2, delayMs: 0 },
    }));
  let database = await openDevDatabase(databasePath, "", serverEnv, config, definition);
  try {
    await database.adapter.insertAuthUser({
      id: owner.userId,
      createdAt: "2026-08-20T12:00:00.000Z",
      displayName: owner.displayName,
      email: owner.email,
      picture: owner.picture,
      isAuthenticated: 1,
      isGuest: 0,
      provider: owner.provider,
    });
    const rolledBack = await runMutation(database, owner, "enqueueThenFail", []);
    assert.equal(rolledBack.ok, false);
    assert.equal((await database.adapter.prepare("SELECT id FROM sporades_jobs WHERE idempotencyKey = ?").get("must-roll-back")) ?? null, null);

    const issued = await runMutation(database, owner, "issue", []);
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const admitted = await runEndpoint(database, { handler: endpointHandler }, new URL("http://capsule.test/jobs"), {
      method: "POST",
      headers: { authorization: `Bearer ${issued.data.token}` },
      async *[Symbol.asyncIterator]() {},
    });
    await runMutation(database, owner, "revoke", [issued.data.accessKey.id]);
    await runMutation(database, owner, "remove", [issued.data.accessKey.id]);
    const replacement = await runMutation(database, owner, "issue", []);
    assert.equal(replacement.ok, true, JSON.stringify(replacement));
    assert.notEqual(replacement.data.accessKey.id, issued.data.accessKey.id);
    await deleteCurrentAuthUser(database, { kind: "mutation", auth: owner, credential: { kind: "session" } });
    await database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", admitted.id);

    await database.close();
    database = await openDevDatabase(databasePath, "", serverEnv, config, definition);
    await runCurrentUserJobWorker(database);
    await waitForJobCondition(async () => {
      const parent = await database.adapter.prepare("SELECT status FROM sporades_jobs WHERE id = ?").get(admitted.id);
      return parent?.status !== "running" ? parent : null;
    }, "parent Job did not finish its first attempt");
    let child = await database.adapter.prepare("SELECT * FROM sporades_jobs WHERE handler = 'child'").get();
    if (!child) {
      await runCurrentUserJobWorker(database);
      child = await waitForJobCondition(
        () => database.adapter.prepare("SELECT * FROM sporades_jobs WHERE handler = 'child'").get(),
        "parent Job did not enqueue its child after retry",
      );
    }
    assert.ok(child);

    assert.equal(parentAttempts, 2);
    assert.deepEqual(seen.map((entry) => entry.handler), ["parent", "parent"]);
    for (const entry of seen) {
      assert.deepEqual(entry.auth, { ...owner, provider: "access-key" });
      assert.deepEqual(entry.credential, { kind: "access-key", id: issued.data.accessKey.id, name: keyName });
    }
    assert.deepEqual(JSON.parse(child.authSnapshotJson), { ...owner, provider: "access-key" });
    assert.deepEqual(JSON.parse(child.credentialJson), {
      kind: "access-key", id: issued.data.accessKey.id, name: keyName,
    });
    const inspected = (await inspectRuntimeJobs(database.adapter)).find((entry) => entry.id === admitted.id);
    assert.deepEqual(inspected.enqueuedBy, {
      mode: "user",
      userId: owner.userId,
      credential: { kind: "access-key", id: issued.data.accessKey.id, name: keyName },
    });
    assert.equal(JSON.stringify(inspected).includes(issued.data.token), false);
    assert.equal(JSON.stringify(inspected).includes(replacement.data.token), false);
  } finally {
    await database?.close();
  }
}

test("Access-key Job lifecycle is stable across SQLite restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-lifecycle-sqlite-"));
  try {
    await proveAccessKeyJobLifecycleAcrossEngine({
      databasePath: path.join(dir, "data.db"),
      config: { name: "job-lifecycle-sqlite" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Access-key Job lifecycle is stable across service-backed libSQL restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-lifecycle-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "data.db"), {}, async ({ url }) => {
      await proveAccessKeyJobLifecycleAcrossEngine({
        databasePath: path.join(dir, "unused.db"),
        serverEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
        config: { name: "job-lifecycle-libsql", services: { database: { engine: "libsql" } } },
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Access-key Job lifecycle is stable across PostgreSQL restart", { skip: POSTGRES_SKIP_REASON }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-lifecycle-postgres-"));
  try {
    await withPostgresAdapter(async () => {});
    await proveAccessKeyJobLifecycleAcrossEngine({
      databasePath: path.join(dir, "unused.db"),
      serverEnv: {
        SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
        SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
      },
      config: { name: "job-lifecycle-postgres", services: { database: { engine: "postgres" } } },
    });
  } finally {
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
      enqueuedBy: { mode: "user", userId: "user-a", credential: { kind: "session" } },
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
