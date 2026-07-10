import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createBundle } from "../dist/bundle-pipeline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "sporades.js");
const run = (cwd) => spawnSync(process.execPath, [cli, "schedules"], { cwd, encoding: "utf8" });
const runCommand = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
const remoteEnvelope = { ok: true, data: { capsule: { name: "scheduled" }, schedules: [{ name: "daily", expression: "0 9 * * *", timezone: "UTC", missedRun: "skip", enabled: true, nextOccurrence: "2030-01-02T09:00:00.000Z", latestOccurrence: null }] }, error: null };

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

test("sporades deploy schedules invokes the shared one-shot action through Docker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-docker-"));
  try {
    const bin = path.join(dir, "bin"); await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "capsule-1" }));
    const docker = path.join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ] && [ "$4" = /app/server.mjs ] && [ "$5" = --sporades-action ] && [ "$6" = schedules.inspect ]; then echo '${JSON.stringify(remoteEnvelope)}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const result = runCommand(["deploy", "schedules"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), remoteEnvelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades host schedules sends the explicit target and preserves the bounded envelope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-host-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"), requestLog = path.join(dir, "request.json"), dockerLog = path.join(dir, "docker.log"); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const docker = path.join(bin, "docker"); await writeFile(docker, `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify(remoteEnvelope)}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const ssh = path.join(bin, "ssh"); await writeFile(ssh, `#!/bin/sh\nread input\necho "$input" > ${JSON.stringify(requestLog)}\nprintf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "sporades-host-helper.js"))}\n`); await chmod(ssh, 0o755);
    const result = runCommand(["host", "schedules", "--host", "live", "--subname", "team-notes"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.deepEqual(JSON.parse(result.stdout), remoteEnvelope);
    const request = JSON.parse(await readFile(requestLog, "utf8")); assert.equal(request.action, "schedules.inspect"); assert.deepEqual(request.capsule, { subname: "team-notes" });
    assert.match(await readFile(dockerLog, "utf8"), /exec sporades-example-test-team-notes node \/app\/server\.mjs --sporades-action schedules\.inspect/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades host schedules guides a Host-helper upgrade when the action is unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-old-host-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", remoteRoot: "/srv/sporades" } } }));
    const ssh = path.join(bin, "ssh"); await writeFile(ssh, "#!/bin/sh\necho '{\"ok\":false,\"data\":null,\"error\":{\"message\":\"Unsupported Host helper action.\",\"hint\":\"old\"}}'\n"); await chmod(ssh, 0o755);
    const result = runCommand(["host", "schedules", "--host", "live", "--subname", "team-notes"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config });
    assert.equal(result.status, 1); const body = JSON.parse(result.stdout); assert.equal(body.error.code, "HOST_HELPER_UPGRADE_REQUIRED"); assert.match(body.error.hint, /sporades host upgrade --host live/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remote Schedule inspection preserves unavailable targets and bounded malformed-state errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-errors-"));
  try {
    const missing = runCommand(["deploy", "schedules"], dir); assert.equal(missing.status, 1); assert.match(JSON.parse(missing.stdout).error.hint, /sporades deploy/);
    const bin = path.join(dir, "bin"); await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "stopped" }));
    const docker = path.join(bin, "docker"); await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = inspect ]; then echo false; exit 0; fi\n"); await chmod(docker, 0o755);
    const stopped = runCommand(["deploy", "schedules"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }); assert.equal(stopped.status, 1); assert.match(JSON.parse(stopped.stdout).error.hint, /deploy restart/);
    const malformed = { ok: false, data: null, error: { code: "SCHEDULE_INSPECTION_INVALID_STATE", message: "Persisted Schedule state is malformed.", hint: "Repair Schedule state.", scheduleName: "broken", field: "nextOccurrence" } };
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify(malformed)}'; exit 0; fi\n`); await chmod(docker, 0o755);
    const corrupt = runCommand(["deploy", "schedules"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }); assert.equal(corrupt.status, 1); const body = JSON.parse(corrupt.stdout);
    assert.deepEqual({ code: body.error.diagnostics.code, scheduleName: body.error.diagnostics.scheduleName, field: body.error.diagnostics.field }, { code: "SCHEDULE_INSPECTION_INVALID_STATE", scheduleName: "broken", field: "nextOccurrence" });
    assert.doesNotMatch(corrupt.stdout, /payload|definitionFingerprint|raw-secret/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("generated Host helper preserves stopped and malformed Schedule inspection failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-schedules-host-errors-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", remoteRoot: "/srv/sporades" } } }));
    const ssh = path.join(bin, "ssh"); await writeFile(ssh, `#!/bin/sh\nread input\nprintf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "sporades-host-helper.js"))}\n`); await chmod(ssh, 0o755);
    const docker = path.join(bin, "docker"); await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = inspect ]; then echo false; exit 0; fi\n"); await chmod(docker, 0o755);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config };
    const stopped = runCommand(["host", "schedules", "--host", "live", "--subname", "team-notes"], dir, env); assert.equal(stopped.status, 1); assert.match(JSON.parse(stopped.stdout).error.hint, /sporades host start/);
    const malformed = { ok: false, data: null, error: { code: "SCHEDULE_INSPECTION_INVALID_STATE", message: "Persisted Schedule state is malformed.", hint: "Repair Schedule state.", scheduleName: "broken", field: "nextOccurrence" } };
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify(malformed)}'; exit 0; fi\n`); await chmod(docker, 0o755);
    const corrupt = runCommand(["host", "schedules", "--host", "live", "--subname", "team-notes"], dir, env); assert.equal(corrupt.status, 1); const body = JSON.parse(corrupt.stdout);
    assert.deepEqual({ code: body.error.diagnostics.code, scheduleName: body.error.diagnostics.scheduleName, field: body.error.diagnostics.field }, { code: "SCHEDULE_INSPECTION_INVALID_STATE", scheduleName: "broken", field: "nextOccurrence" });
    assert.doesNotMatch(corrupt.stdout, /payload|definitionFingerprint|raw-secret/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
