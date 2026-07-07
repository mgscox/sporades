import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctorShouldExitNonZero } from "../dist/cli/doctor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDI9R+ElI6awrzqT1DDZjMa6q7iH+jF5bughycSLBOa/ test@example";
const TEST_PROCESS_EVENT_TIMEOUT_MS = 10000;

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-doctor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withHttpServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "::1", resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function startCli(args, options = {}) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.trim());
      if (line) {
        cleanup();
        resolve(JSON.parse(line));
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before stdout line.\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)));
}

async function installFakeReact(projectDir) {
  await writePackage(
    projectDir,
    "react",
    {
      ".": "./index.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
  await writePackage(
    projectDir,
    "react-dom",
    {
      "./client": "./client.js",
    },
    {
      "client.js": "export function createRoot() { return { render() {} }; }\n",
    },
  );
}

async function createProject(dir, name = "doctor-island") {
  const result = await runCli(["create", name, "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  return path.join(dir, name);
}

async function writeCapsuleProject(dir, serverSource) {
  await Promise.all([
    mkdir(path.join(dir, "server"), { recursive: true }),
    mkdir(path.join(dir, "client"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(dir, "sporades.json"),
      `${JSON.stringify({ name: "doctor-acl-test", client: { framework: "react" } }, null, 2)}\n`,
    ),
    writeFile(path.join(dir, "server", "index.ts"), serverSource),
    writeFile(path.join(dir, "client", "index.tsx"), "console.log('client');\n"),
    writeFile(path.join(dir, "index.html"), "<div id=\"root\"></div>\n"),
  ]);
}

async function updateSporadesConfig(projectDir, update) {
  const configPath = path.join(projectDir, "sporades.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  update(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function hostEnv(configDir) {
  return { SPORADES_CONFIG_DIR: configDir };
}

async function writeHostProfileConfig(configDir, config) {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "hosts.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function writeRemoteBinding(projectDir, binding) {
  await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
  await writeFile(path.join(projectDir, ".sporades", "remote-binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
}

async function installDoctorFakeSsh(dir, scriptBody) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const fakeRemoteDir = path.join(dir, "fake-remote", "bin");
  const logPath = path.join(dir, "ssh-contract-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  const helperPath = path.join(fakeRemoteDir, "sporades-host-helper");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(fakeRemoteDir, { recursive: true });
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  ${scriptBody}
});
`,
  );
  await chmod(helperPath, 0o755);
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  const result = spawnSync(process.env.FAKE_REMOTE_HELPER, { input: stdin, encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 0);
});
`,
  );
  await chmod(sshPath, 0o755);
  return {
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
      FAKE_REMOTE_HELPER: helperPath,
    },
  };
}

async function readJsonl(filePath) {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findCheck(envelope, id) {
  const check = envelope.data.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `Expected doctor check ${id}`);
  return check;
}

function hostedDoctorFixtureScript(overrides = {}) {
  const releaseFingerprint = Object.hasOwn(overrides, "releaseFingerprint") ? overrides.releaseFingerprint : "0123456789abcdef";
  const hostFingerprint = Object.hasOwn(overrides, "hostFingerprint") ? overrides.hostFingerprint : releaseFingerprint;
  const currentRelease = Object.hasOwn(overrides, "currentRelease")
    ? overrides.currentRelease
    : {
        id: "20260703T120000Z-abc12345",
        sealedServerEnv: releaseFingerprint ? { publicKeyFingerprint: releaseFingerprint } : null,
      };
  const registryStatus = overrides.registryStatus ?? "running";
  const dockerRunning = Object.hasOwn(overrides, "dockerRunning") ? overrides.dockerRunning : true;
  const healthOk = Object.hasOwn(overrides, "healthOk") ? overrides.healthOk : true;
  const healthFailure = overrides.healthFailure ?? "runtime-health-failed";
  const statsOk = Object.hasOwn(overrides, "statsOk") ? overrides.statsOk : true;
  const ssh = overrides.ssh ?? {
    enabled: true,
    running: true,
    host: "127.0.0.1",
    port: 32222,
    user: "sporades",
    keyCount: 1,
    fingerprints: ["SHA256:test"],
    reason: null,
  };
  const includeCapsule = Object.hasOwn(overrides, "includeCapsule") ? overrides.includeCapsule : true;
  const listCapsules = includeCapsule
    ? [
        {
          subname: "team-notes",
          domain: "localhost",
          hostedUrl: "http://team-notes.localhost",
          registry: { remoteCapsuleId: "localhost/team-notes", status: registryStatus, sealedServerEnv: { currentKeyFingerprint: hostFingerprint } },
          currentRelease,
          sealedServerEnv: hostFingerprint
            ? {
                publicKeyFingerprint: hostFingerprint,
                status: overrides.hostKeyAvailable === false ? "missing-key-material" : "available",
                publicKeyAvailable: overrides.hostKeyAvailable !== false,
                privateKeyAvailable: overrides.hostKeyAvailable !== false,
              }
            : null,
          docker: overrides.docker === null ? null : { containerName: "sporades-localhost-team-notes", state: dockerRunning ? "running" : "exited", running: dockerRunning },
        },
      ]
    : [];
  return `
const request = JSON.parse(stdin);
const write = (envelope) => process.stdout.write(JSON.stringify(envelope) + "\\n");
const listCapsules = ${JSON.stringify(listCapsules)};
const ssh = ${JSON.stringify(ssh)};
if (request.action === "capsule.list") {
  write({ ok: true, data: { host: request.host, capsules: listCapsules }, error: null });
  return;
}
if (request.action === "capsule.health") {
  if (${JSON.stringify(healthOk)}) {
    write({ ok: true, data: { capsule: { subname: request.capsule.subname, domain: request.host.domain, registered: true }, release: ${JSON.stringify(currentRelease)}, container: { name: request.health.container.name, running: true }, route: { url: request.health.runtimeHealthUrl, responding: true }, runtime: { ready: true, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } } }, error: null });
  } else {
    write({ ok: false, data: { failure: ${JSON.stringify(healthFailure)}, capsule: { subname: request.capsule.subname }, route: { url: request.health.runtimeHealthUrl, responding: false }, container: { name: request.health.container.name, running: false } }, error: { message: "Hosted Capsule health failed.", hint: "Check Hosted Capsule logs, then retry health." } });
  }
  return;
}
if (request.action === "host.stats") {
  write({ ok: true, data: { host: request.host, disk: { availableBytes: 1024 }, memory: { availableBytes: 2048 }, docker: { available: true }, caddy: { available: true } }, error: null });
  return;
}
if (request.action === "host.logs") {
  write({ ok: true, data: { source: request.logs.source, subname: request.capsule?.subname ?? null, lines: ["ready"] }, error: null });
  return;
}
if (request.action === "capsule.stats") {
  if (${JSON.stringify(statsOk)}) {
    write({ ok: true, data: { capsule: { subname: request.capsule.subname }, container: { name: request.stats.container.name, running: ${JSON.stringify(dockerRunning)} }, stats: { CPUPerc: "0.01%", MemUsage: "10MiB / 1GiB" }, lifecycle: { registryStatus: ${JSON.stringify(registryStatus)}, running: ${JSON.stringify(dockerRunning)} } }, error: null });
  } else {
    write({ ok: false, data: { failure: "stats-unavailable", capsule: { subname: request.capsule.subname } }, error: { message: "Hosted Capsule Docker stats unavailable.", hint: "Check Docker on the Host server and retry stats." } });
  }
  return;
}
if (request.action === "capsule.ssh") {
  write({ ok: true, data: { capsule: { subname: request.capsule.subname }, ...ssh }, error: null });
  return;
}
write({ ok: false, data: null, error: { message: "Unexpected action.", hint: request.action } });
`;
}

test("sporades doctor warns when Capsule app tables have no ACL declarations", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, capsule, table } from "sporades/server";
        export default capsule({
          schema: {
            notes: table({ title: String() }),
            users: table({ name: String() }),
          },
        });
      `,
    );

    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.acl-posture");

    assert.equal(check.status, "warn");
    assert.equal(check.severity, "warning");
    assert.match(check.message, /not deny-by-default today/);
    assert.match(check.hint, /Add \.acl\(\{ read, write \}\)/);
    assert.deepEqual(check.details.tables, [
      { name: "notes", missing: ["declaration", "read", "write"] },
      { name: "users", missing: ["declaration", "read", "write"] },
    ]);
  });
});

test("sporades doctor distinguishes partial table ACL declarations", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, capsule, table } from "sporades/server";
        export default capsule({
          schema: {
            readOnlyNotes: table({ title: String() }).acl({ read: () => true }),
            writeOnlyNotes: table({ title: String() }).acl({ write: () => true }),
            insertOnlyNotes: table({ title: String() }).acl({ insert: () => true }),
          },
        });
      `,
    );

    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.acl-posture");

    assert.equal(check.status, "warn");
    assert.deepEqual(check.details.tables, [
      { name: "readOnlyNotes", missing: ["write"] },
      { name: "writeOnlyNotes", missing: ["read"] },
      { name: "insertOnlyNotes", missing: ["read", "write"] },
    ]);
  });
});

test("sporades doctor passes Capsule app tables with complete read and write ACL declarations", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, capsule, table } from "sporades/server";
        export default capsule({
          schema: {
            notes: table({ title: String() }).acl({ read: () => true, write: () => true }),
          },
        });
      `,
    );

    const result = await runCli(["doctor", "--strict", "--json"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.acl-posture");

    assert.equal(check.status, "pass");
    assert.equal(check.severity, "info");
    assert.deepEqual(check.details, { tableCount: 1, inspectedResource: "app-tables" });
  });
});

test("sporades doctor reports Capsule metadata load failures with an actionable hint", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, capsule, table } from "sporades/server";
        export default capsule({
          schema: {
            notes: table({ title: String() }),
          },
      `,
    );

    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.metadata-load");

    assert.equal(check.status, "fail");
    assert.equal(check.severity, "error");
    assert.match(check.message, /Capsule schema metadata could not be loaded/);
    assert.match(check.hint, /Fix server\/index\.ts/);
  });
});

test("sporades doctor fails when the bundled server module has no default Capsule export", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, table } from "sporades/server";
        export const schema = {
          notes: table({ title: String() }),
        };
      `,
    );

    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.metadata-load");

    assert.equal(check.status, "fail");
    assert.equal(check.severity, "error");
    assert.match(check.message, /default Capsule definition/);
    assert.match(check.hint, /export default capsule/);
  });
});

test("sporades doctor reports unsupported ACL operations as Capsule metadata load failures", async () => {
  await withTempDir(async (dir) => {
    await writeCapsuleProject(
      dir,
      `
        import { String, capsule, table } from "sporades/server";
        export default capsule({
          schema: {
            notes: table({ title: String() }).acl({
              read: () => true,
              write: () => true,
              admin: () => true,
            }),
          },
        });
      `,
    );

    const result = await runCli(["doctor", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const check = findCheck(JSON.parse(result.stdout), "doctor.capsule-authoring.metadata-load");

    assert.equal(check.status, "fail");
    assert.equal(check.severity, "error");
    assert.match(check.message, /Unsupported Capsule table ACL operation: notes\.admin/);
    assert.match(check.hint, /Supported ACL operations are read, write, insert, update, and delete/);
  });
});

test("sporades doctor --help documents the diagnostic command options", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--help"], { cwd: dir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: sporades doctor \[options\]/);
    assert.match(result.stdout, /--session <name>/);
    assert.match(result.stdout, /public-dev/);
    assert.match(result.stdout, /--host <alias>/);
    assert.match(result.stdout, /--subname <name>/);
    assert.match(result.stdout, /--strict/);
    assert.match(result.stdout, /--json/);
  });
});

test("sporades doctor --json returns a stable diagnostic envelope", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const result = await runCli(["doctor", "--json"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");

    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.error, null);
    assert.equal(envelope.data.command, "doctor");
    assert.equal(envelope.data.version, 1);
    assert.equal(envelope.data.strict, false);
    assert.equal(envelope.data.session, null);
    assert.deepEqual(envelope.data.summary, {
      pass: 5,
      warn: 0,
      fail: 0,
      skip: 0,
      info: 5,
      warning: 0,
      error: 0,
    });
    assert.equal(findCheck(envelope, "doctor.command-surface").status, "pass");
    assert.equal(findCheck(envelope, "doctor.project-config").status, "pass");
    assert.equal(findCheck(envelope, "doctor.security-policy").status, "pass");
    assert.equal(findCheck(envelope, "doctor.ssh-authorized-keys").status, "pass");
    assert.equal(findCheck(envelope, "doctor.capsule-authoring.acl-posture").status, "pass");
  });
});

test("sporades doctor human output groups checks by severity", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const result = await runCli(["doctor", "--session", "dev"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Sporades doctor/);
    assert.match(result.stdout, /\nINFO\n/);
    assert.match(result.stdout, /- \[skip\] Dev session diagnostics pending:/);
    assert.match(result.stdout, /\nINFO\n- \[pass\] Doctor command surface:/);
    assert.doesNotMatch(result.stdout, /WARNING/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

test("sporades doctor hosted human output includes exact follow-up commands", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        currentRelease: null,
        registryStatus: "stopped",
        dockerRunning: false,
        healthOk: false,
        healthFailure: "unavailable-response",
        statsOk: false,
        ssh: { enabled: false, running: false, reason: "no-authorized-keys" },
      }),
    );

    await withHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      await writeRemoteBinding(projectDir, {
        hostAlias: "personal",
        domain: `localhost:${port}`,
        scheme: "http",
        subname: "team-notes",
        hostedUrl: `http://team-notes.localhost:${port}`,
        remoteCapsuleId: `localhost:${port}/team-notes`,
      });

      const result = await runCli(["doctor", "--session", "hosted"], {
        cwd: projectDir,
        env: { ...hostEnv(configDir), ...fakeSsh.env },
      });

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /sporades host health --host personal/);
      assert.match(result.stdout, /sporades host stats --host personal/);
      assert.match(result.stdout, /sporades host logs stdout --host personal --subname team-notes/);
      assert.doesNotMatch(result.stdout, /sporades host logs team-notes --host personal/);
      assert.match(result.stdout, /sporades host ssh team-notes --host personal/);
      assert.match(result.stdout, /sporades host push --host personal --subname team-notes --verify/);

      const logs = await runCli(["host", "logs", "stdout", "--host", "personal", "--subname", "team-notes", "--json"], {
        cwd: projectDir,
        env: { ...hostEnv(configDir), ...fakeSsh.env },
      });
      assert.equal(logs.code, 0, logs.stderr);
      assert.equal(JSON.parse(logs.stdout).data.source, "stdout");
    });
  });
});

test("sporades doctor skips placeholder session checks without failing strict mode", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const normal = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).data.summary.skip, 1);

    const strict = await runCli(["doctor", "--session", "container", "--strict", "--json"], { cwd: projectDir });
    assert.equal(strict.code, 0, strict.stderr);
    assert.equal(strict.stderr, "");
    const envelope = JSON.parse(strict.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.strict, true);
    assert.equal(envelope.data.summary.warn, 0);
    assert.equal(envelope.data.summary.fail, 0);
    assert.equal(envelope.data.summary.skip, 1);
  });
});

test("sporades doctor fails malformed project config and unsupported project-level keys", async () => {
  await withTempDir(async (dir) => {
    const missing = await runCli(["doctor", "--json"], { cwd: dir });
    assert.equal(missing.code, 1);
    assert.equal(findCheck(JSON.parse(missing.stdout), "doctor.project-config").status, "fail");

    const projectDir = await createProject(dir, "malformed-island");
    await writeFile(path.join(projectDir, "sporades.json"), "{ not-json");
    const malformed = await runCli(["doctor", "--json"], { cwd: projectDir });
    assert.equal(malformed.code, 1);
    assert.match(findCheck(JSON.parse(malformed.stdout), "doctor.project-config").message, /Invalid project configuration/);

    await writeFile(path.join(projectDir, "sporades.json"), `${JSON.stringify({ name: "malformed-island", mystery: true })}\n`);
    const unsupported = await runCli(["doctor", "--json"], { cwd: projectDir });
    assert.equal(unsupported.code, 1);
    const check = findCheck(JSON.parse(unsupported.stdout), "doctor.project-config");
    assert.equal(check.status, "fail");
    assert.deepEqual(check.details.unsupportedKeys, ["mystery"]);
  });
});

test("sporades doctor reports effective security policy for the requested session", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "security-island");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(dir, hostedDoctorFixtureScript({ includeCapsule: false }));
    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });
    await updateSporadesConfig(projectDir, (config) => {
      config.security.cors.allowedOrigins = ["https://example.com"];
      config.security.csp.mode = "enforce";
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "security-island", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 1, result.stderr);
    const policy = findCheck(JSON.parse(result.stdout), "doctor.security-policy");
    assert.equal(policy.status, "pass");
    assert.equal(policy.details.session, "hosted");
    assert.equal(policy.details.security.cors.publicDev, false);
    assert.deepEqual(policy.details.security.cors.allowedOrigins, ["https://example.com"]);
    assert.equal(policy.details.security.csp.header, "content-security-policy");
  });
});

test("sporades doctor warns for requested or running Public Dev posture", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "public-dev-island");

    const requested = await runCli(["doctor", "--session", "public-dev", "--json"], { cwd: projectDir });
    assert.equal(requested.code, 0, requested.stderr);
    const requestedEnvelope = JSON.parse(requested.stdout);
    assert.equal(findCheck(requestedEnvelope, "doctor.security-policy").details.security.cors.publicDev, true);
    assert.equal(findCheck(requestedEnvelope, "doctor.public-dev-posture").status, "warn");

    await updateSporadesConfig(projectDir, (config) => {
      config.dev.port = 0;
    });
    await installFakeReact(projectDir);

    const child = startCli(["dev", "--public", "--json"], { cwd: projectDir });
    try {
      const started = await waitForJsonLine(child);
      assert.equal(started.ok, true, JSON.stringify(started.error));

      const running = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir });
      assert.equal(running.code, 0, running.stderr);
      assert.equal(findCheck(JSON.parse(running.stdout), "doctor.public-dev-posture").status, "warn");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});

test("sporades doctor warns on permissive Container and Hosted security posture", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "permissive-island");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(dir, hostedDoctorFixtureScript({ includeCapsule: false }));
    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });
    await updateSporadesConfig(projectDir, (config) => {
      config.security = {
        cors: { allowedOrigins: ["*"] },
        csp: {
          mode: "report-only",
          directives: {
            "default-src": ["*"],
            "script-src": ["*", "'unsafe-inline'"],
          },
        },
      };
    });

    const container = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(container.code, 0, container.stderr);
    const containerCheck = findCheck(JSON.parse(container.stdout), "doctor.security-policy");
    assert.equal(containerCheck.status, "warn");
    assert.match(containerCheck.hint, /Restrict security\.cors\.allowedOrigins/);
    assert.match(containerCheck.hint, /security\.csp\.mode/);

    const hosted = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "permissive-island", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(hosted.code, 1, hosted.stderr);
    assert.equal(findCheck(JSON.parse(hosted.stdout), "doctor.security-policy").status, "warn");
  });
});

test("sporades doctor validates valid SSH config without printing full public keys", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [{ key: TEST_PUBLIC_KEY }],
      };
    });

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(TEST_PUBLIC_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "pass");
    assert.equal(check.details.keyCount, 1);
    assert.match(check.details.fingerprints[0], /^SHA256:/);
    assert.deepEqual(check.commands, ["sporades deploy ssh"]);
  });
});

test("sporades doctor fails malformed SSH config without leaking key material", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "bad-ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [{ key: "ssh-ed25519 definitely-not-valid test@example" }],
      };
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "bad-ssh-island", "--json"], {
      cwd: projectDir,
    });

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /definitely-not-valid/);
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "fail");
    assert.match(check.message, /Malformed SSH authorized key material/);
    assert.deepEqual(check.commands, ["sporades host ssh bad-ssh-island --host personal"]);
  });
});

test("sporades doctor warns when SSH block resolves to no effective authorized keys", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "empty-ssh-island");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = { authorizedKeys: [] };
    });

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });

    assert.equal(result.code, 0, result.stderr);
    const check = findCheck(JSON.parse(result.stdout), "doctor.ssh-authorized-keys");
    assert.equal(check.status, "warn");
    assert.equal(check.details.keyCount, 0);
    assert.match(check.hint, /Add public keys to `ssh\.authorizedKeys`/);
  });
});

test("sporades doctor diagnoses a healthy Hosted Capsule through Host inspection surfaces and remote binding", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(dir, hostedDoctorFixtureScript());

    await withHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    }, async (port) => {
      await writeHostProfileConfig(configDir, {
        currentHostAlias: "personal",
        profiles: {
          personal: {
            server: "root@example.test",
            domain: `localhost:${port}`,
            scheme: "http",
            remoteRoot: "/opt/sporades",
            tls: { mode: "automatic" },
          },
        },
      });
      await writeRemoteBinding(projectDir, {
        hostAlias: "personal",
        domain: `localhost:${port}`,
        scheme: "http",
        subname: "team-notes",
        hostedUrl: `http://team-notes.localhost:${port}`,
        remoteCapsuleId: `localhost:${port}/team-notes`,
      });

      const result = await runCli(["doctor", "--session", "hosted", "--json"], {
        cwd: projectDir,
        env: { ...hostEnv(configDir), ...fakeSsh.env },
      });

      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.data.host, "personal");
      assert.equal(envelope.data.subname, "team-notes");
      assert.equal(findCheck(envelope, "doctor.hosted.target").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.host-health").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.registry").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.release").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.runtime-health").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.stats").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.sealed-server-env").status, "pass");
      assert.equal(findCheck(envelope, "doctor.hosted.ssh").status, "pass");
      assert.deepEqual(findCheck(envelope, "doctor.ssh-authorized-keys").commands, ["sporades host ssh team-notes --host personal"]);
      assert.deepEqual(findCheck(envelope, "doctor.hosted.ssh").commands, ["sporades host ssh team-notes --host personal"]);
      assert.doesNotMatch(result.stdout, /PRIVATE KEY|ssh-ed25519 AAAA/);

      const calls = await readJsonl(fakeSsh.logPath);
      assert.deepEqual(calls.map((call) => JSON.parse(call.stdin).action).sort(), [
        "capsule.list",
        "capsule.health",
        "capsule.stats",
        "capsule.ssh",
        "host.stats",
      ].sort());
    });
  });
});

test("sporades doctor treats rotated retained sealed-env keys as healthy when availability remains true", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        releaseFingerprint: "old-release-key",
        hostFingerprint: "new-current-key",
        hostKeyAvailable: true,
      }),
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 0, result.stderr);
    const sealedEnv = findCheck(JSON.parse(result.stdout), "doctor.hosted.sealed-server-env");
    assert.equal(sealedEnv.status, "pass");
    assert.match(sealedEnv.message, /rotated/i);
    assert.doesNotMatch(sealedEnv.message, /unavailable/i);
  });
});

test("sporades doctor warns only when sealed-env inspection reports unavailable key material", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        releaseFingerprint: "current-release-key",
        hostFingerprint: "current-release-key",
        hostKeyAvailable: false,
      }),
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 0, result.stderr);
    const sealedEnv = findCheck(JSON.parse(result.stdout), "doctor.hosted.sealed-server-env");
    assert.equal(sealedEnv.status, "warn");
    assert.match(sealedEnv.message, /unavailable/);
  });
});

test("sporades doctor reports missing Host profile and remote binding as structured hosted checks", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "missing-hosted");
    const noBinding = await runCli(["doctor", "--session", "hosted", "--json"], {
      cwd: projectDir,
      env: hostEnv(path.join(dir, "machine-config")),
    });

    assert.equal(noBinding.code, 1);
    let envelope = JSON.parse(noBinding.stdout);
    let target = findCheck(envelope, "doctor.hosted.target");
    assert.equal(target.status, "fail");
    assert.match(target.message, /No Hosted Capsule binding/);
    assert.deepEqual(target.commands, ["sporades host bind <subname> --host <alias>", "sporades host register <subname> --host <alias>"]);

    await writeRemoteBinding(projectDir, { hostAlias: "missing", subname: "team-notes" });
    const missingProfile = await runCli(["doctor", "--session", "hosted", "--json"], {
      cwd: projectDir,
      env: hostEnv(path.join(dir, "machine-config")),
    });

    assert.equal(missingProfile.code, 1);
    envelope = JSON.parse(missingProfile.stdout);
    target = findCheck(envelope, "doctor.hosted.target");
    assert.equal(target.status, "fail");
    assert.match(target.message, /Unknown Host profile alias: missing/);
    assert.deepEqual(target.commands, ["sporades host add missing --server <ssh-target> --domain <hosted-domain>"]);
  });
});

test("sporades doctor reports missing Hosted Capsule registry state", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(dir, hostedDoctorFixtureScript({ includeCapsule: false }));

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 1);
    const registry = findCheck(JSON.parse(result.stdout), "doctor.hosted.registry");
    assert.equal(registry.status, "fail");
    assert.match(registry.message, /not present in the Host server registry/);
    assert.deepEqual(registry.commands, ["sporades host list --host personal", "sporades host register team-notes --host personal"]);
  });
});

test("sporades doctor reports Hosted Capsule release, health, route, stats, sealed-env, and SSH mismatches", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        currentRelease: null,
        registryStatus: "stopped",
        dockerRunning: false,
        healthOk: false,
        healthFailure: "unavailable-response",
        statsOk: false,
        releaseFingerprint: "missing-release-key",
        hostFingerprint: "host-current-key",
        hostKeyAvailable: false,
        ssh: { enabled: false, running: false, reason: "no-authorized-keys" },
      }),
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(findCheck(envelope, "doctor.hosted.release").status, "fail");
    assert.equal(findCheck(envelope, "doctor.hosted.runtime-health").status, "warn");
    assert.equal(findCheck(envelope, "doctor.hosted.stats").status, "warn");
    assert.equal(findCheck(envelope, "doctor.hosted.sealed-server-env").status, "warn");
    assert.equal(findCheck(envelope, "doctor.hosted.ssh").status, "warn");
    assert.match(findCheck(envelope, "doctor.hosted.runtime-health").message, /unavailable response/);
    assert.match(findCheck(envelope, "doctor.hosted.registry").message, /stopped/);
    assert.match(findCheck(envelope, "doctor.hosted.sealed-server-env").message, /fingerprint.*unavailable/);
  });
});

test("sporades doctor does not claim an old release sealed-env key is unavailable when current Host key material is missing", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        releaseFingerprint: "0123456789abcdef",
        hostFingerprint: "fedcba9876543210",
        hostKeyAvailable: false,
      }),
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 0, result.stderr);
    const sealedEnv = findCheck(JSON.parse(result.stdout), "doctor.hosted.sealed-server-env");
    assert.equal(sealedEnv.status, "warn");
    assert.match(sealedEnv.message, /Current Host sealed-env key fingerprint fedcba9876543210 is unavailable/);
    assert.doesNotMatch(sealedEnv.message, /Release metadata references sealed-env key fingerprint 0123456789abcdef/);
    assert.doesNotMatch(sealedEnv.message, /matching Host key material is unavailable/);
  });
});

test("sporades doctor warns for Hosted Capsule route and container mismatches plus SSH unavailable state", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "team-notes");
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installDoctorFakeSsh(
      dir,
      hostedDoctorFixtureScript({
        docker: null,
        healthOk: false,
        healthFailure: "route-container-mismatch",
        ssh: { enabled: true, running: false, keyCount: 1, fingerprints: ["SHA256:test"], reason: "capsule-stopped" },
      }),
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: { personal: { server: "root@example.test", domain: "capsules.example.dev", scheme: "https", remoteRoot: "/opt/sporades" } },
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(findCheck(envelope, "doctor.hosted.runtime-health").status, "warn");
    assert.match(findCheck(envelope, "doctor.hosted.runtime-health").message, /route.*container/i);
    assert.equal(findCheck(envelope, "doctor.hosted.ssh").status, "warn");
    assert.match(findCheck(envelope, "doctor.hosted.ssh").message, /capsule-stopped/);
  });
});

test("doctor exit contract fails normal mode only for failed checks", () => {
  const passingChecks = [{ id: "doctor.pass", status: "pass" }];
  const skippedChecks = [{ id: "doctor.skip", status: "skip" }];
  const warningChecks = [{ id: "doctor.warn", status: "warn" }];
  const failingChecks = [{ id: "doctor.fail", status: "fail" }];

  assert.equal(doctorShouldExitNonZero(passingChecks, false), false);
  assert.equal(doctorShouldExitNonZero(skippedChecks, false), false);
  assert.equal(doctorShouldExitNonZero(warningChecks, false), false);
  assert.equal(doctorShouldExitNonZero(warningChecks, true), true);
  assert.equal(doctorShouldExitNonZero(failingChecks, false), true);
});

test("sporades doctor rejects unknown sessions with structured errors and hints", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(["doctor", "--session", "staging", "--json"], { cwd: dir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid doctor session.",
        hint: "Use one of: dev, public-dev, container, hosted.",
        diagnostics: { session: "staging" },
      },
    });
  });
});

test("sporades doctor rejects incompatible hosted option combinations", async () => {
  await withTempDir(async (dir) => {
    const localWithHost = await runCli(["doctor", "--session", "dev", "--host", "personal", "--json"], { cwd: dir });
    assert.equal(localWithHost.code, 1);
    assert.match(JSON.parse(localWithHost.stdout).error.hint, /--session hosted/);

    const projectDir = await createProject(dir, "hosted-options-island");
    const hostedWithoutSubname = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--json"], {
      cwd: projectDir,
    });
    assert.equal(hostedWithoutSubname.code, 1);
    assert.equal(JSON.parse(hostedWithoutSubname.stdout).error, null);
    assert.match(findCheck(JSON.parse(hostedWithoutSubname.stdout), "doctor.hosted.target").hint, /--host <alias> --subname <name>/);
  });
});
