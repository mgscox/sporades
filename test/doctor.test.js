import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

async function installFakeDocker(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const call = { args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(call) + "\\n");
if (process.env.FAKE_DOCKER_MISSING === "1") {
  process.stderr.write("docker missing\\n");
  process.exit(127);
}
if (call.args[0] === "version") {
  process.stdout.write("Docker version 27.0.0\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args[1] === "version") {
  if (process.env.FAKE_DOCKER_COMPOSE_MISSING === "1") {
    process.stderr.write("compose missing\\n");
    process.exit(1);
  }
  process.stdout.write("Docker Compose version v2.29.0\\n");
  process.exit(0);
}
if (call.args[0] === "inspect") {
  if (process.env.FAKE_DOCKER_INSPECT_MISSING === "1") {
    process.stderr.write("Error response from daemon: No such container\\n");
    process.exit(1);
  }
  process.stdout.write((process.env.FAKE_DOCKER_INSPECT_JSON || JSON.stringify({
    State: { Running: true },
    Config: {
      User: "501:20",
      Labels: {
        "com.sporades.base-image.name": "sporades-base",
        "com.sporades.base-image.version": "0.1.0-node22-alpine",
        "com.sporades.base-image.update-policy": "host-managed"
      }
    },
    HostConfig: {
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "unless-stopped" }
    },
    Mounts: [
      { Source: "/tmp/build/server.mjs", Destination: "/app/server.mjs", Mode: "ro", RW: false },
      { Source: "/tmp/build/client.js", Destination: "/app/client.js", Mode: "ro", RW: false },
      { Source: "/tmp/index.html", Destination: "/app/index.html", Mode: "ro", RW: false },
      { Source: "/tmp/sporades.json", Destination: "/app/sporades.json", Mode: "ro", RW: false },
      { Source: "/tmp/data", Destination: "/app/data", Mode: "rw", RW: true }
    ],
    NetworkSettings: {
      Ports: {
        "4000/tcp": [{ HostIp: "127.0.0.1", HostPort: "4000" }],
        "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "49162" }]
      },
      Networks: { "sporades-doctor-island-services": {} }
    }
  })) + "\\n");
  process.exit(0);
}
if (call.args[0] === "network" && call.args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_STATUS || "0"));
}
if (call.args[0] === "compose" && call.args.includes("ps")) {
  process.stdout.write((process.env.FAKE_DOCKER_COMPOSE_PS_OUTPUT || JSON.stringify({ State: "running", Health: "healthy" })) + "\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("port")) {
  process.stdout.write(process.env.FAKE_DOCKER_COMPOSE_PORT_OUTPUT || "127.0.0.1:49170\\n");
  process.exit(0);
}
process.stderr.write("unexpected docker call: " + call.args.join(" ") + "\\n");
process.exit(1);
`,
  );
  await chmod(dockerPath, 0o755);

  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_MISSING: options.missing ? "1" : "",
      FAKE_DOCKER_COMPOSE_MISSING: options.composeMissing ? "1" : "",
      FAKE_DOCKER_INSPECT_MISSING: options.inspectMissing ? "1" : "",
      FAKE_DOCKER_NETWORK_STATUS: String(options.networkStatus ?? 0),
      FAKE_DOCKER_INSPECT_JSON: options.inspectJson ? JSON.stringify(options.inspectJson) : "",
      FAKE_DOCKER_COMPOSE_PS_OUTPUT: options.composePsOutput ?? "",
      FAKE_DOCKER_COMPOSE_PORT_OUTPUT: options.composePortOutput ?? "",
    },
    async calls() {
      let raw = "";
      try {
        raw = await readFile(logPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

async function withListeningPort(fn) {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writeDevSession(projectDir, overrides = {}) {
  await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".sporades", "dev-session.json"),
    `${JSON.stringify(
      {
        url: "http://localhost:4000",
        port: 4000,
        pid: 12345,
        session: "dev",
        publicDev: false,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeContainerBinding(projectDir, overrides = {}) {
  await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".sporades", "binding.json"),
    `${JSON.stringify({ containerId: "container-doctor", containerName: "sporades-doctor-island", ...overrides }, null, 2)}\n`,
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

function findCheck(envelope, id) {
  const check = envelope.data.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `Expected doctor check ${id}`);
  return check;
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
    assert.match(result.stdout, /\nINFO\n(?:- .+\n)*- \[skip\] Dev session binding:/);
    assert.match(result.stdout, /\nINFO\n- \[pass\] Doctor command surface:/);
    assert.doesNotMatch(result.stdout, /WARNING/);
    assert.doesNotMatch(result.stdout, /ERROR/);
  });
});

test("sporades doctor skips unavailable local runtime checks without failing strict mode", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir);
    const normal = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).data.summary.skip, 2);

    const strict = await runCli(["doctor", "--session", "container", "--strict", "--json"], { cwd: projectDir });
    assert.equal(strict.code, 0, strict.stderr);
    assert.equal(strict.stderr, "");
    const envelope = JSON.parse(strict.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.strict, true);
    assert.equal(envelope.data.summary.warn, 0);
    assert.equal(envelope.data.summary.fail, 0);
    assert.equal(envelope.data.summary.skip, 2);
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
    await updateSporadesConfig(projectDir, (config) => {
      config.security.cors.allowedOrigins = ["https://example.com"];
      config.security.csp.mode = "enforce";
    });

    const result = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--subname", "security-island", "--json"], {
      cwd: projectDir,
    });

    assert.equal(result.code, 0, result.stderr);
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

test("sporades doctor reports healthy Dev session binding and port reachability", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "dev-runtime-island");
    await withListeningPort(async (port) => {
      await writeDevSession(projectDir, {
        url: `http://localhost:${port}`,
        port,
        publicDev: false,
      });

      const result = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir });

      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      const binding = findCheck(envelope, "doctor.dev.binding");
      const reachability = findCheck(envelope, "doctor.dev.port-reachability");
      assert.equal(binding.status, "pass");
      assert.equal(reachability.status, "pass");
      assert.deepEqual(binding.commands, ["sporades dev status"]);
      assert.equal(reachability.details.port, port);
      assert.equal(findCheck(envelope, "doctor.public-dev-posture").details.runningPublicDev, false);
    });
  });
});

test("sporades doctor warns on missing and stale Dev session bindings", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "stale-dev-island");

    const missing = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir });
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(findCheck(JSON.parse(missing.stdout), "doctor.dev.binding").status, "skip");

    await writeDevSession(projectDir, { port: 9, url: "http://localhost:9" });
    const stale = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir });
    assert.equal(stale.code, 0, stale.stderr);
    const reachability = findCheck(JSON.parse(stale.stdout), "doctor.dev.port-reachability");
    assert.equal(reachability.status, "warn");
    assert.match(reachability.hint, /sporades dev status/);
  });
});

test("sporades doctor warns on permissive Container and Hosted security posture", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "permissive-island");
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
    });
    assert.equal(hosted.code, 0, hosted.stderr);
    assert.equal(findCheck(JSON.parse(hosted.stdout), "doctor.security-policy").status, "warn");
  });
});

test("sporades doctor reports healthy local Container runtime hardening with fake Docker", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "container-runtime-island");
    await writeContainerBinding(projectDir);
    const docker = await installFakeDocker(dir);

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(findCheck(envelope, "doctor.container.binding").status, "pass");
    assert.equal(findCheck(envelope, "doctor.container.running-state").status, "pass");
    const policy = findCheck(envelope, "doctor.container.runtime-policy");
    assert.equal(policy.status, "pass");
    assert.deepEqual(policy.commands, ["sporades deploy status", "sporades deploy ssh"]);
    assert.deepEqual(policy.details.baseImageLabels, {
      name: "sporades-base",
      version: "0.1.0-node22-alpine",
      updatePolicy: "host-managed",
    });
    assert.equal(policy.details.runtimeUser, "501:20");
    assert.equal(policy.details.readOnlyReleaseMounts, true);
    assert.equal(policy.details.writableDataMount, true);
    assert.equal(policy.details.loopbackOnlyPublishedPorts, true);

    const mutatingDockerCommands = new Set(["run", "start", "stop", "restart", "rm", "pull", "build", "rmi"]);
    const calls = await docker.calls();
    assert.equal(calls.some((call) => mutatingDockerCommands.has(call.args[0])), false);
    assert.equal(calls.some((call) => call.args[0] === "compose" && ["up", "down", "build", "pull"].some((verb) => call.args.includes(verb))), false);
  });
});

test("sporades doctor warns when a required release mount is missing", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "missing-release-mount-island");
    await writeContainerBinding(projectDir);
    const docker = await installFakeDocker(dir, {
      inspectJson: {
        State: { Running: true },
        Config: {
          User: "501:20",
          Labels: {
            "com.sporades.base-image.name": "sporades-base",
            "com.sporades.base-image.version": "0.1.0-node22-alpine",
            "com.sporades.base-image.update-policy": "host-managed",
          },
        },
        HostConfig: {
          ReadonlyRootfs: true,
          RestartPolicy: { Name: "unless-stopped" },
        },
        Mounts: [
          { Source: "/tmp/build/server.mjs", Destination: "/app/server.mjs", Mode: "ro", RW: false },
          { Source: "/tmp/build/client.js", Destination: "/app/client.js", Mode: "ro", RW: false },
          { Source: "/tmp/index.html", Destination: "/app/index.html", Mode: "ro", RW: false },
          { Source: "/tmp/data", Destination: "/app/data", Mode: "rw", RW: true },
        ],
        NetworkSettings: {
          Ports: {
            "4000/tcp": [{ HostIp: "127.0.0.1", HostPort: "4000" }],
          },
        },
      },
    });

    const result = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(result.code, 0, result.stderr);
    const policy = findCheck(JSON.parse(result.stdout), "doctor.container.runtime-policy");
    assert.equal(policy.status, "warn");
    assert.equal(policy.details.readOnlyReleaseMounts, false);
    assert.equal(policy.details.writableDataMount, true);
  });
});

test("sporades doctor reports missing binding, stopped container, stale binding, and missing Docker", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "container-problem-island");

    const missingBinding = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir });
    assert.equal(missingBinding.code, 0, missingBinding.stderr);
    assert.equal(findCheck(JSON.parse(missingBinding.stdout), "doctor.container.binding").status, "skip");

    await writeContainerBinding(projectDir);
    const stoppedDocker = await installFakeDocker(path.join(dir, "stopped"), {
      inspectJson: {
        State: { Running: false },
        Config: { User: "501:20", Labels: {} },
        HostConfig: { ReadonlyRootfs: false, RestartPolicy: { Name: "no" }, Mounts: [] },
        NetworkSettings: { Ports: {} },
      },
    });
    const stopped = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir, env: stoppedDocker.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(findCheck(JSON.parse(stopped.stdout), "doctor.container.running-state").status, "warn");

    const staleDocker = await installFakeDocker(path.join(dir, "stale"), { inspectMissing: true });
    const stale = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir, env: staleDocker.env });
    assert.equal(stale.code, 1, stale.stderr);
    assert.equal(findCheck(JSON.parse(stale.stdout), "doctor.container.running-state").status, "fail");

    const missingDocker = await installFakeDocker(path.join(dir, "missing-docker"), { missing: true });
    const missing = await runCli(["doctor", "--session", "container", "--json"], { cwd: projectDir, env: missingDocker.env });
    assert.equal(missing.code, 1, missing.stderr);
    const availability = findCheck(JSON.parse(missing.stdout), "doctor.container.docker-availability");
    assert.equal(availability.status, "fail");
    assert.match(availability.hint, /Install or start Docker/);
  });
});

test("sporades doctor reports Capsule services, drift, unhealthy services, missing Compose, and no declarations", async () => {
  await withTempDir(async (dir) => {
    const projectDir = await createProject(dir, "doctor-island");
    const docker = await installFakeDocker(dir, {
      composePsOutput: JSON.stringify({ State: "running", Health: "healthy" }),
      composePortOutput: "127.0.0.1:49170\n",
    });

    const noServices = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(noServices.code, 0, noServices.stderr);
    assert.equal(findCheck(JSON.parse(noServices.stdout), "doctor.services.declarations").status, "skip");

    await updateSporadesConfig(projectDir, (config) => {
      config.services = {
        database: { kind: "database", engine: "libsql" },
        storage: { kind: "storage", engine: "minio" },
      };
    });
    await mkdir(path.join(projectDir, ".sporades", "compose"), { recursive: true });
    await writeFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "# stale generated state\n");
    await mkdir(path.join(projectDir, ".sporades", "services", "storage"), { recursive: true });

    const drift = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(drift.code, 0, drift.stderr);
    const driftEnvelope = JSON.parse(drift.stdout);
    assert.equal(findCheck(driftEnvelope, "doctor.services.declarations").status, "pass");
    assert.equal(findCheck(driftEnvelope, "doctor.services.generated-compose").status, "warn");
    const runtime = findCheck(driftEnvelope, "doctor.services.runtime-state");
    assert.equal(runtime.status, "warn");
    assert.equal(runtime.details.services.database.volume.exists, false);
    assert.equal(runtime.details.services.storage.health, "healthy");
    assert.deepEqual(runtime.commands, ["sporades deploy status", "sporades deploy restart", "sporades deploy reset"]);

    const unhealthyDocker = await installFakeDocker(path.join(dir, "unhealthy"), {
      composePsOutput: JSON.stringify({ State: "running", Health: "unhealthy" }),
    });
    const unhealthy = await runCli(["doctor", "--session", "dev", "--json"], { cwd: projectDir, env: unhealthyDocker.env });
    assert.equal(unhealthy.code, 0, unhealthy.stderr);
    assert.equal(findCheck(JSON.parse(unhealthy.stdout), "doctor.services.runtime-state").status, "warn");

    const missingComposeDocker = await installFakeDocker(path.join(dir, "missing-compose"), { composeMissing: true });
    const missingCompose = await runCli(["doctor", "--session", "dev", "--json"], {
      cwd: projectDir,
      env: missingComposeDocker.env,
    });
    assert.equal(missingCompose.code, 0, missingCompose.stderr);
    assert.equal(findCheck(JSON.parse(missingCompose.stdout), "doctor.services.compose-availability").status, "skip");
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

    const hostedWithoutSubname = await runCli(["doctor", "--session", "hosted", "--host", "personal", "--json"], {
      cwd: dir,
    });
    assert.equal(hostedWithoutSubname.code, 1);
    assert.match(JSON.parse(hostedWithoutSubname.stdout).error.hint, /--host <alias> --subname <name>/);
  });
});
