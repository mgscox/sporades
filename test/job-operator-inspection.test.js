import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLibsqlDatabaseAdapter, createPostgresDatabaseAdapter, createSqliteDatabaseAdapter, inspectRuntimeJobs } from "../dist/server-runtime-source.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

test("operator Job inspection returns one deterministic bounded snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-operator-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    await adapter.exec("CREATE TABLE sporades_jobs (id TEXT, handler TEXT, enqueuedByUserId TEXT, actorUserId TEXT, payload TEXT, status TEXT, availableAt TEXT, attempts INTEGER, idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT, startedAt TEXT, completedAt TEXT, failedAt TEXT, retryJson TEXT, attemptHistory TEXT, cancelRequestedAt TEXT, leaseExpiresAt TEXT)");
    const insert = adapter.prepare("INSERT INTO sporades_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    await insert.run("a", "email", "u1", "u1", JSON.stringify({ secret: true }), "succeeded", "2026-01-01T00:00:00.000Z", 1, "secret-key", JSON.stringify({ ok: true }), null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", null, JSON.stringify({ maxAttempts: 3, delayMs: 10 }), JSON.stringify([{ attempt: 1, outcome: "succeeded" }]), null, null);
    await insert.run("b", "cleanup", "u2", "__privileged__", "{}", "queued", "2026-01-02T00:00:00.000Z", 0, null, null, null, "2026-01-02T00:00:00.000Z", null, null, null, JSON.stringify({ maxAttempts: 1, delayMs: 0 }), "[]", null, null);

    const jobs = await inspectRuntimeJobs(adapter);
    assert.deepEqual(jobs.map((job) => job.id), ["b", "a"]);
    assert.deepEqual(Object.keys(jobs[0]), ["id", "handler", "status", "enqueuedBy", "actor", "attempts", "retry", "idempotencyKeyPresent", "availableAt", "createdAt", "startedAt", "completedAt", "failedAt", "cancelRequestedAt", "leaseExpiresAt", "attemptHistory", "result", "failure"]);
    assert.deepEqual(jobs[0].actor, { mode: "privileged-server-role" });
    assert.deepEqual(jobs[0].enqueuedBy, { mode: "user", userId: "u2", credential: { kind: "session" } });
    assert.equal("payload" in jobs[1], false);
    assert.equal("idempotencyKey" in jobs[1], false);
    assert.equal(jobs[1].idempotencyKeyPresent, true);
    assert.equal(jobs[1].result, null, "operator inspection must not disclose arbitrary Capsule result JSON");
    await assert.rejects(() => adapter.withReadOnlySnapshot((snapshot) => snapshot.prepare("DELETE FROM sporades_jobs").run()), /readonly|read-only/i);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator Job inspection reads through the configured libSQL adapter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "remote.db"), async ({ url }) => {
      const adapter = await createLibsqlDatabaseAdapter({ url });
      try { assert.deepEqual(await inspectRuntimeJobs(adapter), []); await assert.rejects(() => adapter.withReadOnlySnapshot((snapshot) => snapshot.exec("CREATE TABLE forbidden (id TEXT)")), /readonly|read-only/i); }
      finally { await adapter.close(); }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator Job inspection reads sporades_jobs through Postgres", { skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the Postgres adapter integration test." }, async () => {
  const adapter = await createPostgresDatabaseAdapter({ url: process.env.SPORADES_POSTGRES_TEST_URL });
  try {
    const sql = adapter.dialect.sql;
    await adapter.exec(sql("DROP TABLE IF EXISTS [sporades_jobs]"));
    await adapter.exec(sql("CREATE TABLE [sporades_jobs] ([id] TEXT, [handler] TEXT, [enqueuedByUserId] TEXT, [actorUserId] TEXT, [payload] TEXT, [status] TEXT, [availableAt] TEXT, [attempts] INTEGER, [idempotencyKey] TEXT, [result] TEXT, [failure] TEXT, [createdAt] TEXT, [startedAt] TEXT, [completedAt] TEXT, [failedAt] TEXT, [retryJson] TEXT, [attemptHistory] TEXT, [cancelRequestedAt] TEXT, [leaseExpiresAt] TEXT)"));
    await adapter.prepare(sql("INSERT INTO [sporades_jobs] VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")).run("pg-1", "work", "u", "u", "{}", "queued", "2026-01-01T00:00:00.000Z", 0, null, null, null, "2026-01-01T00:00:00.000Z", null, null, null, '{"maxAttempts":1,"delayMs":0}', "[]", null, null);
    assert.deepEqual((await inspectRuntimeJobs(adapter)).map((job) => job.id), ["pg-1"]);
  } finally { await adapter.exec(adapter.dialect.sql("DROP TABLE IF EXISTS [sporades_jobs]")); await adapter.close(); }
});

test("one-shot Bundle action does not evaluate Capsule code", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-action-"));
  const marker = path.join(dir, "capsule-evaluated");
  const bundle = await createServerBundleModuleSource({
    config: { name: "team-notes" }, serverEnv: {}, serverSource: "",
    serverModuleSource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes"); export default {};`,
  });
  await writeFile(path.join(dir, "server.mjs"), bundle);
  const result = spawnSync(process.execPath, [path.join(dir, "server.mjs"), "--sporades-action", "jobs.inspect"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { capsule: { name: "team-notes" }, jobs: [] }, error: null });
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  await assert.rejects(stat(path.join(dir, "data")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(dir, "data", "data.db")), { code: "ENOENT" });
  await rm(dir, { recursive: true, force: true });
});

test("operator Job inspection treats missing storage as empty and rejects malformed state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-job-operator-invalid-"));
  const adapter = await createSqliteDatabaseAdapter(path.join(dir, "data.db"));
  try {
    assert.deepEqual(await inspectRuntimeJobs(adapter), []);
    await adapter.exec("CREATE TABLE sporades_jobs (id TEXT, handler TEXT, enqueuedByUserId TEXT, actorUserId TEXT, payload TEXT, status TEXT, availableAt TEXT, attempts INTEGER, idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT, startedAt TEXT, completedAt TEXT, failedAt TEXT, retryJson TEXT, attemptHistory TEXT, cancelRequestedAt TEXT, leaseExpiresAt TEXT)");
    await adapter.prepare("INSERT INTO sporades_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("bad", "x", "u", "u", "{}", "queued", "now", 0, null, null, null, "now", null, null, null, "not-json", "[]", null, null);
    await assert.rejects(() => inspectRuntimeJobs(adapter), (error) => error.code === "JOB_INSPECTION_INVALID_STATE" && error.jobId === "bad" && error.field === "retry");
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});
