import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "sporades.js");
const envelope = { ok: true, data: { capsule: { name: "jobs" }, jobs: [] }, error: null };
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
const runAsync = (args, cwd, env = {}) => new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let stdout="",stderr=""; child.stdout.on("data",c=>stdout+=c); child.stderr.on("data",c=>stderr+=c); child.on("close",status=>resolve({status,stdout,stderr})); });

test("sporades jobs does not trust adapter credentials or inspection tokens in Dev metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-dev-"));
  try {
    await mkdir(path.join(dir, ".sporades", "build"), { recursive: true });
    await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "jobs" }));
    await writeFile(path.join(dir, ".sporades", "dev-session.json"), JSON.stringify({ pid: process.pid, inspectionToken: "must-not-pass", serviceEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: "postgres://secret" } }));
    await writeFile(path.join(dir, ".sporades", "build", "server.mjs"), `if(process.env.SPORADES_SERVICE_DATABASE_ENGINE||process.env.SPORADES_SERVICE_DATABASE_URL||process.env.SPORADES_INSPECTION_TOKEN)process.exit(8);console.log(${JSON.stringify(JSON.stringify(envelope))})`);
    const result = run(["jobs"], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades jobs reconstructs the current Dev database service after configuration changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-current-adapter-"));
  try {
    await withFakeLibsqlService(path.join(dir, "remote.db"), async ({ url }) => {
      const servicePort = new URL(url).port, bin = path.join(dir, "bin");
      await mkdir(path.join(dir, ".sporades", "build"), { recursive: true }); await mkdir(bin);
      await writeFile(path.join(dir, "sporades.json"), JSON.stringify({ name: "jobs", services: { database: { kind: "database", engine: "libsql" } } }));
      await writeFile(path.join(dir, ".sporades", "dev-session.json"), JSON.stringify({ pid: process.pid, serviceEnv: { SPORADES_SERVICE_DATABASE_URL: "http://stale.invalid" } }));
      await writeFile(path.join(dir, ".sporades", "build", "server.mjs"), `if(process.env.SPORADES_SERVICE_DATABASE_ENGINE!=="libsql"||process.env.SPORADES_SERVICE_DATABASE_URL!==${JSON.stringify(url)})process.exit(8);console.log(${JSON.stringify(JSON.stringify(envelope))})`);
      const docker = path.join(bin, "docker"); await writeFile(docker, `#!/bin/sh\nif printf '%s' "$*" | grep -q ' port '; then echo '127.0.0.1:${servicePort}'; exit 0; fi\nif printf '%s' "$*" | grep -q ' ps '; then echo '{"State":"running","Health":"healthy"}'; exit 0; fi\nexit 0\n`); await chmod(docker, 0o755);
      const result = await runAsync(["jobs"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades deploy jobs invokes the one-shot action through fake Docker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-docker-"));
  try {
    const bin = path.join(dir, "bin"); await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "capsule-1" }));
    const docker = path.join(bin, "docker");
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ] && [ "$4" = /app/server.mjs ] && [ "$5" = --sporades-action ] && [ "$6" = jobs.inspect ]; then echo '${JSON.stringify(envelope)}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const result = run(["deploy", "jobs"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), envelope);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades host jobs guides upgrade when fake SSH reports an old helper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-host-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ currentHostAlias: "live", profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const ssh = path.join(bin, "ssh"); await writeFile(ssh, `#!/bin/sh\necho '{"ok":false,"data":null,"error":{"message":"Unsupported Host helper action.","hint":"old"}}'\n`); await chmod(ssh, 0o755);
    const result = run(["host", "jobs", "--host", "live", "--subname", "team-notes"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config });
    assert.equal(result.status, 1); const body = JSON.parse(result.stdout); assert.equal(body.error.code, "HOST_HELPER_UPGRADE_REQUIRED"); assert.match(body.error.hint, /sporades host upgrade/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sporades host jobs sends the action and propagates Host-helper docker exec success", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-host-success-"));
  try {
    const bin = path.join(dir, "bin"), config = path.join(dir, "config"), requestLog = path.join(dir, "request.json"), dockerLog = path.join(dir, "docker.log"); await mkdir(bin); await mkdir(config);
    await writeFile(path.join(config, "hosts.json"), JSON.stringify({ profiles: { live: { server: "host", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } } }));
    const docker = path.join(bin, "docker"); await writeFile(docker, `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify(envelope)}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const ssh = path.join(bin, "ssh"); await writeFile(ssh, `#!/bin/sh\nread input\necho "$input" > ${JSON.stringify(requestLog)}\nprintf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "bin", "sporades-host-helper.js"))}\n`); await chmod(ssh, 0o755);
    const result = run(["host", "jobs", "--host", "live", "--subname", "team-notes"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.deepEqual(JSON.parse(result.stdout), envelope);
    const request = JSON.parse(await (await import("node:fs/promises")).readFile(requestLog, "utf8")); assert.equal(request.action, "jobs.inspect"); assert.deepEqual(request.capsule, { subname: "team-notes" });
    const dockerCall = await (await import("node:fs/promises")).readFile(dockerLog, "utf8"); assert.match(dockerCall, /exec sporades-example-test-team-notes node \/app\/server\.mjs --sporades-action jobs\.inspect/);
    await writeFile(docker, `#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nif [ "$1" = exec ]; then echo '${JSON.stringify({ ok: false, data: null, error: { message: "Job inspection failed.", hint: "Retry.", diagnostics: { token: "raw-secret" } } })}'; exit 0; fi\nexit 9\n`); await chmod(docker, 0o755);
    const hostile = run(["host", "jobs", "--host", "live", "--subname", "team-notes"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config });
    assert.equal(hostile.status, 1); assert.doesNotMatch(hostile.stdout, /diagnostics|raw-secret/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Job CLI commands preserve structured unavailable-target errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-jobs-unavailable-"));
  try {
    const dev = run(["jobs"], dir); assert.equal(dev.status, 1); assert.match(JSON.parse(dev.stdout).error.hint, /sporades dev/);
    const bin = path.join(dir, "bin"); await mkdir(path.join(dir, ".sporades"), { recursive: true }); await mkdir(bin);
    await writeFile(path.join(dir, ".sporades", "binding.json"), JSON.stringify({ containerId: "stopped" }));
    const docker = path.join(bin, "docker"); await writeFile(docker, "#!/bin/sh\necho false\n"); await chmod(docker, 0o755);
    const deployed = run(["deploy", "jobs"], dir, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(deployed.status, 1); assert.match(JSON.parse(deployed.stdout).error.hint, /deploy restart/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
