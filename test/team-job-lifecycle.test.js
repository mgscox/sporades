import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createControllableRuntimeClock, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { createPostgresDatabaseAdapter, createSqliteDatabaseAdapter } from "../dist/database-runtime.js";
import { job, mutation, schedule, table, String as Text } from "../dist/server.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from "./support/database-adapter-engines.js";

const teamId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const missingTeamId = "33333333-3333-4333-8333-333333333333";
const options = { resource: { table: "anchors", id: teamId }, operationId: "daily", input: null };
const actor = { userId: "owner", displayName: "Owner", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(handler, run, engine = "sqlite") {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-team-job-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:30.000Z");
  const env = engine === "postgres" ? { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: postgresTestUrl() } : {};
  const config = { name: "team-job", ...(engine === "postgres" ? { services: { database: { engine } } } : {}) };
  if (engine === "postgres") {
    const reset = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
    try { await resetPostgresSchema(reset, ["anchors", "reminders", "sporades_resource_receipts", "sporades_resource_locks"]); }
    finally { await reset.close(); }
  }
  const database = await openDevDatabase(file, "", env, config, {
    schema: { anchors: table({ teamId: Text() }), reminders: table({ teamId: Text() }) },
    jobs: { remind: job(handler) },
    schedules: { daily: schedule({ expression: "* * * * *", timezone: "UTC", job: "remind" }) },
    mutations: { enqueue: mutation(ctx => ctx.jobs.enqueue("remind", null)) },
  }, { clock });
  const captures = [];
  database.observability = { capture(error, surface) { captures.push({ code: error.code, cause: error.cause?.code, surface }); }, close() {} };
  const sql = statement => database.adapter.dialect.sql(statement);
  const all = async tableName => {
    if (tableName === "sporades_resource_receipts" && !(await database.adapter.listInspectableTables()).includes(tableName)) return [];
    return database.adapter.prepare(`SELECT * FROM ${database.adapter.dialect.quoteIdentifier(tableName)}`).all();
  };
  try {
    await database.init();
    await database.adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)"))
      .run(teamId, "Reminders", clock.now().toISOString(), "owner");
    await database.adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)"))
      .run(teamId, memberId, "admin", clock.now().toISOString());
    await database.adapter.prepare(sql("INSERT INTO [anchors] ([id], [createdAt], [updatedAt], [teamId]) VALUES (?, ?, ?, ?)"))
      .run(teamId, clock.now().toISOString(), clock.now().toISOString(), teamId);
    await run({ database, clock, captures, all, file, async tick() { clock.advanceBy(30_000); await clock.runDueTimers(); } });
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("0.9.45 reproduction: nontransactional scheduled Team locks fail opaquely", async () => {
  await fixture(ctx => ctx.teams.lockLifecycle(teamId, memberId), async ({ tick, all, captures, database }) => {
    await tick();
    const rows = await all("sporades_jobs");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scheduleName, "daily");
    assert.equal(rows[0].status, "failed");
    assert.deepEqual(captures, [{ code: "PRIVILEGED_RUN_FAILED", cause: "TEAM_POLICY_DENIED", surface: "job" }]);
    const audits = await database.adapter.readRecentLogEvents(100);
    assert.equal(audits.find(event => event.event === "privileged.errored").data.safeErrorCode, "TEAM_POLICY_DENIED");
  });
});

for (const engine of ["sqlite", "postgres"]) {
  const skip = engine === "postgres" && POSTGRES_SKIP_REASON;
  test(`${engine}: scheduled privileged resource scope locks Team lifecycle and caps reminders atomically`, { skip }, async () => {
    let leaked;
    let calls = 0;
    await fixture(ctx => ctx.resources.run(options, async scope => {
      calls++;
      leaked = scope.teams;
      assert.deepEqual(Object.keys(scope.teams), ["lockLifecycle"]);
      const snapshot = await scope.teams.lockLifecycle(teamId, memberId);
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.member));
      assert.equal((await scope.db.reminders.where("teamId", teamId).all()).length, 0);
      await scope.db.reminders.insert({ teamId });
      return { teamId: snapshot.teamId, member: snapshot.member };
    }), async ({ tick, clock, all, captures }) => {
      await tick();
      let rows = await all("sporades_jobs");
      assert.equal(rows[0].status, "succeeded", JSON.stringify(captures));
      assert.deepEqual(JSON.parse(rows[0].result), { teamId, member: { userId: memberId, role: "admin" } });
      await assert.rejects(async () => leaked.lockLifecycle(teamId), { code: "RESOURCE_SCOPE_INACTIVE" });
      clock.advanceBy(60_000);
      await clock.runDueTimers();
      rows = await all("sporades_jobs");
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.status === "succeeded"));
      assert.equal(calls, 1, "the durable receipt prevents repeated work for this Team/operation");
      assert.equal((await all("reminders")).length, 1);
    }, engine);
  });

  test(`${engine}: caught invalid/missing Team locks roll back writes and receipts`, { skip }, async () => {
    for (const [id, member] of [["malformed", undefined], [missingTeamId, undefined], [teamId, {}]]) {
      await fixture(ctx => ctx.resources.run(options, async scope => {
        await scope.db.reminders.insert({ teamId });
        try { await scope.teams.lockLifecycle(id, member); } catch (error) { assert.equal(error.code, "TEAM_POLICY_DENIED"); }
        return true;
      }), async ({ tick, all, captures }) => {
        await tick();
        assert.equal((await all("sporades_jobs"))[0].status, "failed");
        assert.equal((await all("reminders")).length, 0);
        assert.equal((await all("sporades_resource_receipts")).length, 0);
        assert.equal(captures[0].cause, "TEAM_POLICY_DENIED");
      }, engine);
    }
  });

  test(`${engine}: resource transactions enforce runtime precommit refusal`, { skip }, async () => {
    await fixture(() => null, async ({ database, all }) => {
      await assert.rejects(database.adapter.withResourceTransaction(async tx => {
        await tx.prepare(tx.dialect.sql("INSERT INTO [reminders] ([id], [createdAt], [updatedAt], [teamId]) VALUES (?, ?, ?, ?)"))
          .run("rolled-back", "2030-01-01T00:00:30.000Z", "2030-01-01T00:00:30.000Z", teamId);
        // Team locks register their final admission checks on this runtime slot.
        tx[Symbol.for("sporades.database.transactionBeforeCommitChecks")] = [() => {
          throw Object.assign(new Error("Team operation denied."), { code: "TEAM_POLICY_DENIED" });
        }];
      }, undefined, { table: "anchors", id: teamId }), { code: "TEAM_POLICY_DENIED" });
      assert.equal((await all("reminders")).length, 0);
    }, engine);
  });
}

test("throwing after a Team lock rolls back and a later occurrence can acquire it", async () => {
  let fail = true;
  await fixture(ctx => ctx.resources.run(options, async scope => {
    await scope.teams.lockLifecycle(teamId);
    await scope.db.reminders.insert({ teamId });
    if (fail) throw new Error("private responsibility detail");
    return true;
  }), async ({ tick, clock, all }) => {
    await tick();
    assert.equal((await all("reminders")).length, 0);
    assert.equal((await all("sporades_resource_receipts")).length, 0);
    fail = false;
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    assert.equal((await all("reminders")).length, 1);
    assert.equal((await all("sporades_resource_receipts")).length, 1);
  });
});

test("current-user Job resource scopes do not acquire userless Team authority", async () => {
  await fixture(ctx => ctx.resources.run(options, scope => {
    assert.equal(scope.teams, undefined);
    return true;
  }), async ({ database, clock, all }) => {
    assert.equal((await runMutation(database, actor, "enqueue", [])).ok, true);
    await clock.runDueTimers();
    assert.equal((await all("sporades_jobs"))[0].status, "succeeded");
  });
});

test("a later occurrence rechecks removed recipient membership under the Team lock", async () => {
  let occurrence = 0;
  await fixture(ctx => ctx.resources.run({ ...options, operationId: `recipient-${++occurrence}` }, async scope => {
    const snapshot = await scope.teams.lockLifecycle(teamId, memberId);
    if (snapshot.member?.role !== "admin") return { queued: false };
    await scope.db.reminders.insert({ teamId });
    return { queued: true };
  }), async ({ tick, clock, database, all }) => {
    await tick();
    await database.adapter.prepare("DELETE FROM sporades_team_memberships WHERE teamId=? AND userId=?").run(teamId, memberId);
    clock.advanceBy(60_000);
    await clock.runDueTimers();
    const rows = await all("sporades_jobs");
    assert.ok(rows.every(row => row.status === "succeeded"));
    assert.deepEqual(JSON.parse(rows.find(row => row.scheduledFor === "2030-01-01T00:02:00.000Z").result), { queued: false });
    assert.equal((await all("reminders")).length, 1);
  });
});

test("a Team lock excludes independent deletion until commit, then deleted Teams fail closed", { timeout: 30_000 }, async () => {
  const entered = deferred();
  const release = deferred();
  let occurrence = 0;
  await fixture(ctx => ctx.resources.run({ ...options, operationId: `occurrence-${++occurrence}` }, async scope => {
    await scope.teams.lockLifecycle(teamId, memberId);
    entered.resolve();
    await release.promise;
    await scope.db.reminders.insert({ teamId });
    return true;
  }), async ({ tick, clock, all, file }) => {
    const independent = await createSqliteDatabaseAdapter(file);
    const running = tick();
    try {
      await Promise.race([entered.promise, running.then(() => assert.fail("Job settled before acquiring its Team lock"))]);
      await assert.rejects(async () => independent.prepare("DELETE FROM sporades_teams WHERE id=?").run(teamId), /locked|busy/i);
      release.resolve();
      await running;
      assert.equal((await all("reminders")).length, 1);
      await independent.prepare("DELETE FROM sporades_teams WHERE id=?").run(teamId);
      clock.advanceBy(60_000);
      await clock.runDueTimers();
      assert.equal((await all("sporades_jobs")).filter(row => row.status === "failed").length, 1);
      assert.equal((await all("reminders")).length, 1);
    } finally { release.resolve(); await running; await independent.close(); }
  });
});

test("Job deadline revokes a held Team lock and rolls back detached work", { timeout: 30_000 }, async () => {
  const entered = deferred();
  const release = deferred();
  let late;
  await fixture(ctx => ctx.resources.run(options, async scope => {
    await scope.teams.lockLifecycle(teamId);
    await scope.db.reminders.insert({ teamId });
    entered.resolve();
    await release.promise;
    try { await scope.teams.lockLifecycle(teamId); } catch (error) { late = error.code; }
    return true;
  }), async ({ tick, clock, all }) => {
    const running = tick();
    try {
      await Promise.race([entered.promise, running.then(() => assert.fail("Job settled before acquiring its Team lock"))]);
      clock.advanceBy(30_000);
      await clock.runDueTimers();
      await running;
      assert.equal((await all("reminders")).length, 0);
      assert.equal((await all("sporades_resource_receipts")).length, 0);
      release.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(late, "RESOURCE_SCOPE_INACTIVE");
    } finally { release.resolve(); await running; }
  });
});
