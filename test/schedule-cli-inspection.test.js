import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createBundle } from "../dist/bundle-pipeline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "sporades.js");
const run = (cwd) => spawnSync(process.execPath, [cli, "schedules"], { cwd, encoding: "utf8" });

async function project(name = "scheduled") {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-cli-"));
  await mkdir(path.join(dir, "server"), { recursive: true });
  await mkdir(path.join(dir, "client"), { recursive: true });
  const config = { name, client: { framework: "react" } };
  await writeFile(path.join(dir, "sporades.json"), JSON.stringify(config));
  await writeFile(path.join(dir, "server", "index.ts"), "throw new Error('Capsule code evaluated'); export default {};\n");
  await writeFile(path.join(dir, "client", "index.tsx"), "\n");
  await writeFile(path.join(dir, "index.html"), "<div id=app></div>\n");
  await createBundle(dir, config);
  await writeFile(path.join(dir, ".sporades", "dev-session.json"), JSON.stringify({ pid: process.pid }));
  return dir;
}

test("sporades schedules inspects the real generated Bundle for an active Dev session", async () => {
  const dir = await project();
  try {
    const file = path.join(dir, ".sporades", "data.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE sporades_schedules (name TEXT PRIMARY KEY, definitionFingerprint TEXT NOT NULL, expression TEXT NOT NULL, effectiveTimezone TEXT NOT NULL, missedRunPolicy TEXT NOT NULL, enabled INTEGER NOT NULL, nextOccurrence TEXT, latestScheduledFor TEXT, latestOutcome TEXT, latestJobId TEXT, latestErrorCode TEXT); CREATE TABLE sporades_jobs (id TEXT PRIMARY KEY, scheduleName TEXT, scheduledFor TEXT)");
    const insert = db.prepare("INSERT INTO sporades_schedules (name,definitionFingerprint,expression,effectiveTimezone,missedRunPolicy,enabled,nextOccurrence) VALUES (?,?,?,?,?,?,?)");
    insert.run("zeta", "hidden", "*/5 * * * *", "UTC", "latest", 1, "2030-01-01T00:05:00.000Z");
    insert.run("alpha", "hidden", "0 9 * * *", "Europe/London", "skip", 0, null);
    db.close();
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { capsule: { name: "scheduled" }, schedules: [
      { name: "alpha", expression: "0 9 * * *", timezone: "Europe/London", missedRun: "skip", enabled: false, nextOccurrence: null, latestOccurrence: null },
      { name: "zeta", expression: "*/5 * * * *", timezone: "UTC", missedRun: "latest", enabled: true, nextOccurrence: "2030-01-01T00:05:00.000Z", latestOccurrence: null },
    ] }, error: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades schedules succeeds without creating an absent store", async () => {
  const dir = await project("empty");
  try {
    const file = path.join(dir, ".sporades", "data.db");
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, { capsule: { name: "empty" }, schedules: [] });
    assert.equal(existsSync(file), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades schedules fails closed with bounded Schedule corruption details", async () => {
  const dir = await project();
  try {
    const db = new DatabaseSync(path.join(dir, ".sporades", "data.db"));
    db.exec("CREATE TABLE sporades_schedules (name TEXT PRIMARY KEY, definitionFingerprint TEXT NOT NULL, expression TEXT NOT NULL, effectiveTimezone TEXT NOT NULL, missedRunPolicy TEXT NOT NULL, enabled INTEGER NOT NULL, nextOccurrence TEXT, latestScheduledFor TEXT, latestOutcome TEXT, latestJobId TEXT, latestErrorCode TEXT); CREATE TABLE sporades_jobs (id TEXT PRIMARY KEY, scheduleName TEXT, scheduledFor TEXT)");
    db.prepare("INSERT INTO sporades_schedules (name,definitionFingerprint,expression,effectiveTimezone,missedRunPolicy,enabled,nextOccurrence) VALUES (?,?,?,?,?,?,?)").run("broken", "secret", "* * * * *", "UTC", "skip", 1, "raw-secret-value");
    db.close();
    const result = run(dir), body = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.deepEqual({ code: body.error.diagnostics.code, scheduleName: body.error.diagnostics.scheduleName, field: body.error.diagnostics.field }, { code: "SCHEDULE_INSPECTION_INVALID_STATE", scheduleName: "broken", field: "nextOccurrence" });
    assert.doesNotMatch(result.stdout, /raw-secret-value|definitionFingerprint/);
    assert.equal(body.data, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades schedules reuses the inactive Dev target error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-inactive-"));
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.hint, /sporades dev/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
