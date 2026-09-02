import assert from "node:assert/strict";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

import { createWebSocketHub, openDevDatabase, prepareHttpSecurity, routeRuntimeHealth } from "../dist/server-runtime-source.js";
import { CLIENT_CAPABILITIES, CLIENT_TEMPLATES } from "../dist/client-capabilities.js";
import { validateReleaseArchive } from "../dist/cli/host-helper-archive.js";
import { createHostLifecycleRequest } from "../dist/cli/host-request-builders.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const hostHelperPath = path.join(repoRoot, "bin", "sporades-host-helper.js");
const rootPackageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const TEST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDI9R+ElI6awrzqT1DDZjMa6q7iH+jF5bughycSLBOa/ test@example";
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

function buildHostLifecycle(remoteRoot, domain, subname, scheme = "https") {
  return createHostLifecycleRequest(
    "personal",
    { domain, scheme, remoteRoot, tls: "automatic" },
    subname,
    { updatePolicyMode: "manual" },
  );
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), "sporades-host-"));
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

async function withHostedRuntimeTransportServer(dir, config, fn) {
  const database = await openDevDatabase(
    path.join(dir, "runtime.db"),
    `export default capsule({ name: "hosted-origin-test" });`,
    {},
    {
      __sporadesSession: "hosted",
      __sporadesPublicOrigin: "https://team-notes.capsules.example.dev",
      ...config,
    },
    { name: "hosted-origin-test", schema: {}, queries: {}, mutations: {}, endpoints: {}, messages: {} },
  );
  const websocketHub = createWebSocketHub(() => database);
  const server = createServer((request, response) => {
    if (prepareHttpSecurity(database, request, response)) {
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/__sporades/ws") {
      socket.destroy();
      return;
    }
    websocketHub.accept(request, socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await fn(`http://127.0.0.1:${address.port}`, () => websocketHub.createConnectionToken());
  } finally {
    websocketHub.disconnectAll();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
  }
}

async function reserveUnusedPort() {
  let port;
  await withHttpServer((request, response) => {
    response.writeHead(500);
    response.end();
  }, async (reservedPort) => {
    port = reservedPort;
  });
  return port;
}

function openRawWebSocketHandshake(baseUrl, headers = {}, connectionToken = null) {
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    if (connectionToken) {
      url.searchParams.set("connectionToken", connectionToken);
    }
    const socket = connect(Number(url.port), url.hostname);
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out opening raw WebSocket."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    }
    function settle(response) {
      cleanup();
      socket.destroy();
      resolve(response);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onEnd() {
      settle(buffer.toString("utf8"));
    }
    function onClose() {
      settle(buffer.toString("utf8"));
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker !== -1) {
        settle(buffer.subarray(0, marker).toString("utf8"));
      }
    }

    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("connect", () => {
      const requestHeaders = {
        host: url.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...headers,
      };
      socket.write(
        [`GET ${url.pathname}${url.search} HTTP/1.1`, ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`), "", ""].join(
          "\r\n",
        ),
      );
    });
  });
}

test("Hosted Capsule CORS checks use the configured public origin instead of spoofed forwarded headers", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(
      dir,
      { security: { cors: { allowedOrigins: ["https://ops.example.test"] } } },
      async (baseUrl) => {
        const publicOrigin = await fetch(baseUrl, {
          headers: { origin: "https://team-notes.capsules.example.dev" },
        });
        assert.equal(publicOrigin.headers.get("access-control-allow-origin"), "https://team-notes.capsules.example.dev");

        const explicitOrigin = await fetch(baseUrl, {
          headers: { origin: "https://ops.example.test" },
        });
        assert.equal(explicitOrigin.headers.get("access-control-allow-origin"), "https://ops.example.test");

        const spoofedForwardedOrigin = await fetch(baseUrl, {
          headers: {
            origin: "https://evil.example.test",
            "x-forwarded-host": "evil.example.test",
            "x-forwarded-proto": "https",
          },
        });
        assert.equal(spoofedForwardedOrigin.headers.get("access-control-allow-origin"), null);
      },
    );
  });
});

test("Hosted Capsule WebSocket upgrades reject missing and cross-site origins before activating transport", async () => {
  await withTempDir(async (dir) => {
    await withHostedRuntimeTransportServer(dir, {}, async (baseUrl, createConnectionToken) => {
      const missingOrigin = await openRawWebSocketHandshake(baseUrl, {}, createConnectionToken());
      assert.doesNotMatch(missingOrigin, /^HTTP\/1\.1 101/m);

      const crossSiteOrigin = await openRawWebSocketHandshake(baseUrl, {
        origin: "https://evil.example.test",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      }, createConnectionToken());
      assert.doesNotMatch(crossSiteOrigin, /^HTTP\/1\.1 101/m);

      const publicOrigin = await openRawWebSocketHandshake(baseUrl, {
        origin: "https://team-notes.capsules.example.dev",
      }, createConnectionToken());
      assert.match(publicOrigin, /^HTTP\/1\.1 101/m);
    });
  });
});

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

function startHostHelper(input, options = {}) {
  const child = spawn(process.execPath, [hostHelperPath], {
    cwd: options.cwd,
    env: {
      ...process.env,
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const result = new Promise((resolve) => {
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
  child.stdin.end(`${JSON.stringify(input)}\n`);
  return { child, result };
}

function runHostHelper(input, options = {}) {
  return startHostHelper(input, options).result;
}

function startExecutable(executable, args = [], options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: options.detached === true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  return { child, result, output: () => ({ stdout, stderr }) };
}

async function writeFakeProcEntry(procRoot, pid, target, environment = []) {
  const processDir = path.join(procRoot, String(pid));
  await mkdir(processDir, { recursive: true });
  await writeFile(path.join(processDir, "cmdline"), Buffer.from(`${process.execPath}\0${target}\0`, "utf8"));
  await writeFile(path.join(processDir, "environ"), Buffer.from(`${environment.join("\0")}\0`, "utf8"));
}

async function waitForFileText(filePath, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(filePath, "utf8");
      if (predicate(contents)) return contents;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for expected contents in ${filePath}`);
}

async function waitForPath(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

async function waitForChildPid(parentPid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const children = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const childLine = children.status === 0
      ? children.stdout.split("\n").find((line) => Number(line.trim().split(/\s+/)[1]) === parentPid)
      : null;
    const candidate = childLine ? Number(childLine.trim().split(/\s+/)[0]) : NaN;
    if (Number.isSafeInteger(candidate) && candidate > 0) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for child of ${parentPid}`);
}

function hostEnv(configDir) {
  return { SPORADES_CONFIG_DIR: configDir };
}

async function writeHostProfileConfig(configDir, config) {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "hosts.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function installFakeSsh(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "ssh-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(42);
`,
  );
  await chmod(sshPath, 0o755);

  return {
    fakeBinDir,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
    },
    async assertNotCalled() {
      await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
    },
  };
}

async function installFakeShellSsh(dir) {
  const fakeBinDir = path.join(dir, "fake-shell-ssh-bin");
  const logPath = path.join(dir, "ssh-shell-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_SHELL_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_SSH_SHELL_STATUS) {
  process.exit(Number(process.env.FAKE_SSH_SHELL_STATUS));
}
process.exit(0);
`,
  );
  await chmod(sshPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_SHELL_LOG: logPath,
    },
  };
}

async function installContractFakeSsh(dir, scriptBody) {
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
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
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
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  const result = spawnSync(process.env.FAKE_REMOTE_HELPER, {
    input: stdin,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) {
    process.stderr.write(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
});
`,
  );
  await chmod(sshPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SSH_LOG: logPath,
      FAKE_REMOTE_HELPER: helperPath,
    },
  };
}

async function installFakeScp(dir) {
  const fakeBinDir = path.join(dir, "fake-scp-bin");
  const logPath = path.join(dir, "scp-calls.jsonl");
  const uploadDir = path.join(dir, "fake-uploads");
  const scpPath = path.join(fakeBinDir, "scp");
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });
  await writeFile(
    scpPath,
    `#!/usr/bin/env node
const { appendFileSync, copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const source = args[0];
const target = args[1];
mkdirSync(process.env.FAKE_SCP_UPLOAD_DIR, { recursive: true });
const copiedTo = path.join(process.env.FAKE_SCP_UPLOAD_DIR, path.basename(source));
copyFileSync(source, copiedTo);
appendFileSync(process.env.FAKE_SCP_LOG, JSON.stringify({ args, source, target, copiedTo, cwd: process.cwd() }) + "\\n");
process.exit(0);
`,
  );
  await chmod(scpPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    uploadDir,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_SCP_LOG: logPath,
      FAKE_SCP_UPLOAD_DIR: uploadDir,
    },
  };
}

async function installFakeDocker(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-docker-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const caddyLogPath = path.join(dir, "caddy-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  const caddyPath = path.join(fakeBinDir, "caddy");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "run") {
  process.stdout.write(process.env.FAKE_DOCKER_CONTAINER_ID || "hosted-container-1");
  if (process.env.FAKE_DOCKER_RUN_STATUSES) {
    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const statePath = process.env.FAKE_DOCKER_RUN_STATE;
    const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
    const statuses = process.env.FAKE_DOCKER_RUN_STATUSES.split(",");
    if (statePath) writeFileSync(statePath, String(count + 1));
    process.exit(Number(statuses[Math.min(count, statuses.length - 1)]));
  }
  process.exit(Number(process.env.FAKE_DOCKER_RUN_STATUS || "0"));
}
if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
  process.stdout.write(process.env.FAKE_DOCKER_RUNNING || "true");
  process.exit(Number(process.env.FAKE_DOCKER_RUNNING_STATUS || "0"));
}
if (args[0] === "inspect" && args.includes("{{json .}}")) {
  process.stdout.write(process.env.FAKE_DOCKER_INSPECT_JSON || "{}");
  process.exit(Number(process.env.FAKE_DOCKER_INSPECT_STATUS || "0"));
}
if (args[0] === "inspect" && args.some((arg) => arg.includes("NetworkSettings.Ports"))) {
  process.stdout.write(process.env.FAKE_DOCKER_PUBLISHED_PORT || "127.0.0.1:49153");
  process.exit(Number(process.env.FAKE_DOCKER_PUBLISHED_PORT_STATUS || "0"));
}
if (args[0] === "stats") {
  process.stdout.write(process.env.FAKE_DOCKER_STATS_JSON || "{}");
  process.exit(Number(process.env.FAKE_DOCKER_STATS_STATUS || "0"));
}
if (args[0] === "logs") {
  process.stdout.write(process.env.FAKE_DOCKER_LOGS_STDOUT || "");
  process.stderr.write(process.env.FAKE_DOCKER_LOGS_STDERR || "");
  process.exit(Number(process.env.FAKE_DOCKER_LOGS_STATUS || "0"));
}
if (args[0] === "ps") {
  process.stdout.write(process.env.FAKE_DOCKER_PS_JSONL || "");
  process.exit(Number(process.env.FAKE_DOCKER_PS_STATUS || "0"));
}
if (args[0] === "image" && args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_IMAGE_INSPECT_STATUS || "0"));
}
if (args[0] === "pull") {
  process.exit(Number(process.env.FAKE_DOCKER_PULL_STATUS || "0"));
}
if (args[0] === "build") {
  process.exit(Number(process.env.FAKE_DOCKER_BUILD_STATUS || "0"));
}
if (args[0] === "network" && args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_INSPECT_STATUS || "0"));
}
if (args[0] === "network" && args[1] === "create") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_CREATE_STATUS || "0"));
}
process.exit(0);
`,
  );
  await chmod(dockerPath, 0o755);
  await writeFile(
    caddyPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_CADDY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const delayMs = Number(process.env.FAKE_DOCKER_CADDY_DELAY_MS || "0");
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
let status = args[0] === "validate"
  ? process.env.FAKE_DOCKER_CADDY_VALIDATE_STATUS
  : (process.env.FAKE_DOCKER_CADDY_RELOAD_STATUS || process.env.FAKE_DOCKER_CADDY_STATUS);
if (args[0] === "reload" && process.env.FAKE_DOCKER_CADDY_RELOAD_STATUSES) {
  const statePath = process.env.FAKE_DOCKER_CADDY_STATE;
  const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  const statuses = process.env.FAKE_DOCKER_CADDY_RELOAD_STATUSES.split(",");
  status = statuses[Math.min(count, statuses.length - 1)];
  if (statePath) writeFileSync(statePath, String(count + 1));
}
process.exit(Number(status || "0"));
`,
  );
  await chmod(caddyPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    caddyLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_CADDY_LOG: caddyLogPath,
      FAKE_DOCKER_CADDY_STATE: path.join(dir, "caddy-state.txt"),
      FAKE_DOCKER_RUN_STATE: path.join(dir, "docker-run-state.txt"),
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      ...options.env,
    },
    calls: () => readJsonl(logPath),
    caddyCalls: () => readJsonl(caddyLogPath),
  };
}

async function installFakeCaddy(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-caddy-bin");
  const logPath = path.join(dir, "caddy-calls.jsonl");
  const caddyPath = path.join(fakeBinDir, "caddy");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    caddyPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
let status = args[0] === "validate"
  ? process.env.FAKE_CADDY_VALIDATE_STATUS
  : process.env.FAKE_CADDY_RELOAD_STATUS;
if (args[0] === "reload" && process.env.FAKE_CADDY_RELOAD_STATUSES) {
  const statePath = process.env.FAKE_CADDY_STATE;
  const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  const statuses = process.env.FAKE_CADDY_RELOAD_STATUSES.split(",");
  status = statuses[Math.min(count, statuses.length - 1)];
  if (statePath) writeFileSync(statePath, String(count + 1));
}
process.exit(Number(status || process.env.FAKE_CADDY_STATUS || "0"));
`,
  );
  await chmod(caddyPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CADDY_LOG: logPath,
      FAKE_CADDY_STATE: path.join(dir, "caddy-state.txt"),
      ...options.env,
    },
    calls: () => readJsonl(logPath),
  };
}

async function installFakeJournalctl(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-journalctl-bin");
  const logPath = path.join(dir, "journalctl-calls.jsonl");
  const journalctlPath = path.join(fakeBinDir, "journalctl");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    journalctlPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_JOURNALCTL_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
process.stdout.write(process.env.FAKE_JOURNALCTL_STDOUT || "");
process.stderr.write(process.env.FAKE_JOURNALCTL_STDERR || "");
process.exit(Number(process.env.FAKE_JOURNALCTL_STATUS || "0"));
`,
  );
  await chmod(journalctlPath, 0o755);

  return {
    fakeBinDir,
    logPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_JOURNALCTL_LOG: logPath,
      ...options.env,
    },
    calls: () => readJsonl(logPath),
  };
}

async function installFakeCaddyUserCommands(dir, options = {}) {
  const fakeBinDir = path.join(dir, "fake-caddy-user-bin");
  const idLogPath = path.join(dir, "id-calls.jsonl");
  const chownLogPath = path.join(dir, "chown-calls.jsonl");
  const idPath = path.join(fakeBinDir, "id");
  const chownPath = path.join(fakeBinDir, "chown");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    idPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_USER_ID_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "-u" && args[1] === "caddy") {
  process.stdout.write(process.env.FAKE_CADDY_UID || "123");
  process.exit(Number(process.env.FAKE_CADDY_ID_STATUS || "0"));
}
if (args[0] === "-g" && args[1] === "caddy") {
  process.stdout.write(process.env.FAKE_CADDY_GID || "456");
  process.exit(Number(process.env.FAKE_CADDY_ID_STATUS || "0"));
}
process.exit(1);
`,
  );
  await writeFile(
    chownPath,
    `#!/usr/bin/env node
const { appendFileSync, chownSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CADDY_USER_CHOWN_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_CADDY_APPLY_CHOWN === "1") {
  const [uid, gid] = args[0].split(":").map(Number);
  for (const target of args.slice(1)) chownSync(target, uid, gid);
}
process.exit(Number(process.env.FAKE_CADDY_CHOWN_STATUS || "0"));
`,
  );
  await chmod(idPath, 0o755);
  await chmod(chownPath, 0o755);
  await writeFile(chownLogPath, "", { mode: 0o600 });

  return {
    fakeBinDir,
    idLogPath,
    chownLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CADDY_USER_ID_LOG: idLogPath,
      FAKE_CADDY_USER_CHOWN_LOG: chownLogPath,
      FAKE_CADDY_UID: String(process.getuid?.() ?? 123),
      FAKE_CADDY_GID: String(process.getgid?.() ?? 456),
      ...options.env,
    },
    idCalls: () => readJsonl(idLogPath),
    chownCalls: () => readJsonl(chownLogPath),
  };
}

async function setupRootCapsuleHttpLogFixture(dir, routeKind) {
  const domain = "capsules.example.dev";
  const subname = "team-notes";
  let remoteRoot;
  if (routeKind === "running") {
    ({ remoteRoot } = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] }));
  } else {
    remoteRoot = path.join(dir, "remote-root");
  }
  await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
  await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
  await writeFile(path.join(remoteRoot, "caddy", "hosts", `${domain}.caddy`), `import ./${domain}/*.caddy\n`);
  const docker = await installFakeDocker(path.join(dir, "docker"));
  const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"), {
    env: { FAKE_CADDY_UID: "12345", FAKE_CADDY_GID: "12346", FAKE_CADDY_APPLY_CHOWN: "1" },
  });
  const env = {
    ...docker.env,
    ...caddyUser.env,
    PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
  };
  const host = { alias: "personal", domain, scheme: "https", remoteRoot };
  const capsule = { subname };
  let request;
  let first;
  if (routeKind === "running") {
    request = { action: "capsule.start", host, capsule };
    first = await runHostHelper(request, { cwd: dir, env });
  } else {
    first = await runHostHelper({ action: "capsule.register", host, capsule }, { cwd: dir, env });
    request = { action: "capsule.stop", host, capsule };
  }
  assert.equal(JSON.parse(first.stdout).ok, true, `${routeKind} first: ${first.stdout}\n${first.stderr}`);
  return {
    request,
    env,
    caddyUser,
    logFile: path.join(remoteRoot, "hosts", domain, "capsules", subname, "logs", "http.log"),
  };
}

async function readJsonl(filePath) {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readProjectAuditEvents(projectDir) {
  const eventsPath = path.join(projectDir, ".sporades", "data", "logs", "events.jsonl");
  return (await readJsonl(eventsPath)).filter((entry) => entry.category === "audit");
}

async function writeHostedCapsuleRollbackFixture(dir, options = {}) {
  const remoteRoot = path.join(dir, "remote-root");
  const domain = "capsules.example.dev";
  const subname = "team-notes";
  const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const releasesDir = path.join(capsuleDir, "releases");
  const dataDir = path.join(capsuleDir, "data");
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`);
  const currentReleaseId = Object.hasOwn(options, "currentReleaseId") ? options.currentReleaseId : "20260630T221500Z-feedface";
  const rollbackReleaseId = Object.hasOwn(options, "rollbackReleaseId") ? options.rollbackReleaseId : "20260629T120000Z-deadbeef";
  const releaseIds = options.releaseIds ?? [currentReleaseId, rollbackReleaseId];
  const missingFiles = new Set(options.missingFiles ?? []);
  const sealedReleaseFingerprints = options.sealedReleaseFingerprints ?? {};
  const missingPrivateKeyFingerprints = new Set(options.missingPrivateKeyFingerprints ?? []);
  await mkdir(path.join(dataDir, "uploads"), { recursive: true });
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  for (const releaseId of releaseIds) {
    const releaseDir = path.join(releasesDir, releaseId);
    await mkdir(releaseDir, { recursive: true });
    const files = {
      "server.mjs": `export default ${JSON.stringify(releaseId)};\n`,
      "public/client.js": "console.log('client bundle');\n",
      "public/index.html": "<div id=\"root\"></div>\n",
      "sporades.json": "{\"name\":\"team-notes\"}\n",
    };
    for (const [file, contents] of Object.entries(files)) {
      if (!missingFiles.has(`${releaseId}/${file}`) && !missingFiles.has(file)) {
        const target = path.join(releaseDir, ...file.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
    }
    const fingerprint = sealedReleaseFingerprints[releaseId];
    if (fingerprint) {
      await mkdir(path.join(releaseDir, ".sporades", "sealed-server-env"), { recursive: true });
      await writeFile(
        path.join(releaseDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
        `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: fingerprint, entries: {} })}\n`,
      );
      if (!missingPrivateKeyFingerprints.has(fingerprint)) {
        await mkdir(path.join(dataDir, "sealed-server-env", "keys"), { recursive: true });
        await writeFile(path.join(dataDir, "sealed-server-env", "keys", `${fingerprint}.private.pem`), `private key for ${fingerprint}\n`);
      }
    }
  }
  if (currentReleaseId) {
    await symlink(path.join(releasesDir, currentReleaseId), path.join(capsuleDir, "current"));
  }
  await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
  await writeFile(path.join(dataDir, "uploads", "photo.bin"), "uploaded bytes\n");

  const releases = options.noReleaseHistory
    ? []
    : releaseIds.map((releaseId) => ({
        id: releaseId,
        createdAt: releaseId === currentReleaseId ? "2026-06-30T22:15:00.000Z" : "2026-06-29T12:00:00.000Z",
        uploadedAt: releaseId === currentReleaseId ? "2026-06-30T22:15:00.000Z" : "2026-06-29T12:00:00.000Z",
        state: releaseId === currentReleaseId ? "started" : "verified",
        current: releaseId === currentReleaseId,
        source: {
          hostedUrl: `https://${subname}.${domain}`,
          remoteCapsuleId: `${domain}/${subname}`,
          files: [
            "server.mjs",
            "public/client.js",
            "public/index.html",
            "sporades.json",
            ...(sealedReleaseFingerprints[releaseId] ? [".sporades/sealed-server-env/server-env.sealed.json"] : []),
          ],
          ...(sealedReleaseFingerprints[releaseId]
            ? {
                sealedServerEnvIncluded: true,
                sealedServerEnv: { publicKeyFingerprint: sealedReleaseFingerprints[releaseId] },
              }
            : {}),
        },
        startAttempts: releaseId === currentReleaseId ? [{ startedAt: "2026-06-30T22:16:00.000Z" }] : [],
        verificationAttempts: releaseId === currentReleaseId ? [] : [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
        failure: null,
      }));
  await writeFile(
    registryRecordPath,
    `${JSON.stringify({
      subname,
      domain,
      remoteCapsuleId: `${domain}/${subname}`,
      hostedUrl: `https://${subname}.${domain}`,
      status: options.status ?? "running",
      currentRelease: currentReleaseId ? { id: currentReleaseId } : null,
      ...(options.currentRegistryFingerprint ? { sealedServerEnv: { currentKeyFingerprint: options.currentRegistryFingerprint } } : {}),
      releases,
    })}\n`,
  );
  return {
    remoteRoot,
    domain,
    subname,
    capsuleDir,
    releasesDir,
    dataDir,
    registryRecordPath,
    currentReleaseId,
    rollbackReleaseId,
    rollbackReleaseDir: path.join(releasesDir, rollbackReleaseId),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readHostBootstrapSmokeEnv() {
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const server = values.SPORADES_HOST_SMOKE_SSH_TARGET;
  const domain = values.SPORADES_HOST_SMOKE_DOMAIN;
  const remoteRoot = values.SPORADES_HOST_SMOKE_REMOTE_ROOT;
  if (!server || !domain || !remoteRoot) {
    return null;
  }
  return {
    alias: values.SPORADES_HOST_SMOKE_ALIAS || "smoke",
    server,
    domain,
    remoteRoot,
    tls: values.SPORADES_HOST_SMOKE_TLS || "automatic",
  };
}

async function readHostRegisterSmokeEnv() {
  const smoke = await readHostBootstrapSmokeEnv();
  if (!smoke) {
    return null;
  }
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const subname = values.SPORADES_HOST_SMOKE_SUBNAME;
  const template = values.SPORADES_HOST_SMOKE_TEMPLATE || "todo";
  if (!subname) {
    return null;
  }
  if (template !== "todo" && template !== "guestbook") {
    throw new Error("SPORADES_HOST_SMOKE_TEMPLATE must be todo or guestbook.");
  }
  return { ...smoke, subname, template };
}

async function readHostPushRoutingSmokeEnv() {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    return null;
  }
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const publicUrl = values.SPORADES_HOST_SMOKE_PUBLIC_URL;
  const expectedText = values.SPORADES_HOST_SMOKE_EXPECTED_TEXT;
  if (!publicUrl || !expectedText) {
    return null;
  }
  return { ...smoke, publicUrl, expectedText };
}

async function readHostLogsSmokeEnv() {
  const dotEnv = await readDotEnv(path.join(repoRoot, ".env"));
  const values = { ...dotEnv, ...process.env };
  const server = values.SPORADES_HOST_LOGS_SMOKE_SSH_TARGET;
  const domain = values.SPORADES_HOST_LOGS_SMOKE_DOMAIN;
  const remoteRoot = values.SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT;
  const subname = values.SPORADES_HOST_LOGS_SMOKE_SUBNAME;
  if (!server || !domain || !remoteRoot || !subname) {
    return null;
  }
  return {
    alias: values.SPORADES_HOST_LOGS_SMOKE_ALIAS || "logs-smoke",
    server,
    domain,
    remoteRoot,
    subname,
    tls: values.SPORADES_HOST_LOGS_SMOKE_TLS || "automatic",
    lines: Number.parseInt(values.SPORADES_HOST_LOGS_SMOKE_LINES || "200", 10),
  };
}

async function readDotEnv(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function listArchiveEntries(archivePath, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-tzf", archivePath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}

async function listArchiveVerboseEntries(archivePath, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-tvzf", archivePath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function extractArchiveFile(archivePath, entry, cwd) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-xOzf", archivePath, entry], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

function withCacheBust(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("sporades-smoke", String(Date.now()));
  return parsed.toString();
}

async function writePublicRuntimeFiles(runtimeDir) {
  await mkdir(path.join(runtimeDir, "public"), { recursive: true });
  await writeFile(path.join(runtimeDir, "public", "index.html"), '<div id="root"></div>\n');
  await writeFile(path.join(runtimeDir, "public", "client.js"), "console.log('client bundle');\n");
}

async function createTarGz(archivePath, sourceDir, entries) {
  const result = await new Promise((resolve) => {
    const child = spawn("tar", ["-czf", archivePath, "-C", sourceDir, ...entries], { stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal(result.code, 0, result.stderr);
}

async function createTarGzWithTransforms(archivePath, sourceDir, transforms, entries) {
  const args = ["-czf", archivePath, "-C", sourceDir, ...transforms.flatMap((rule) => ["-s", rule]), ...entries];
  const result = await new Promise((resolve) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
}

async function writeArchiveSecurityFixture(dir, mode) {
  const remoteRoot = path.join(dir, mode, "remote-root");
  const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
  const runtimeDir = path.join(dir, mode, "runtime");
  const archivePath = path.join(remoteRoot, "incoming", "20260630T221500Z-feedface.tar.gz");
  await mkdir(path.join(runtimeDir, "public"), { recursive: true });
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(path.join(runtimeDir, "server.mjs"), "export default {};\n");
  await writeFile(path.join(runtimeDir, "sporades.json"), "{}\n");
  await writeFile(path.join(runtimeDir, "public", "index.html"), "<div></div>\n");
  let files = ["server.mjs", "sporades.json", "public/index.html"];
  let entries = [...files];
  if (mode === "duplicate") {
    entries.push("public/index.html");
  } else if (mode === "absolute") {
    await writeFile(path.join(runtimeDir, "absolute"), "absolute");
    await createTarGzWithTransforms(archivePath, runtimeDir, ["|^absolute$|/absolute.js|"], [...entries, "absolute"]);
  } else if (mode === "overlong") {
    const relative = `${"p".repeat(241)}.js`;
    await writeFile(path.join(runtimeDir, "public", relative), "x");
    files.push(`public/${relative}`);
    entries.push(`public/${relative}`);
  } else if (mode === "oversized") {
    await writeFile(path.join(runtimeDir, "public", "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
    files.push("public/oversized.bin");
    entries.push("public/oversized.bin");
  } else if (mode === "metadata-over-byte") {
    await writeFile(path.join(runtimeDir, "metadata-oversized"), Buffer.alloc(64 * 1024 * 1024 + 1));
    await createTarGzWithTransforms(archivePath, runtimeDir, ["|^metadata-oversized$|._oversized|"], [...entries, "metadata-oversized"]);
  } else if (mode === "metadata-over-count") {
    const metadata = Array.from({ length: 2049 }, (_, index) => `metadata-${String(index).padStart(4, "0")}`);
    await Promise.all(metadata.map((file) => writeFile(path.join(runtimeDir, file), "x")));
    await createTarGzWithTransforms(archivePath, runtimeDir, ["|^metadata-|._metadata-|"], [...entries, ...metadata]);
  } else if (mode === "excess-files") {
    const excess = Array.from({ length: 512 }, (_, index) => `asset-${String(index).padStart(3, "0")}.js`);
    await Promise.all(excess.map((file) => writeFile(path.join(runtimeDir, "public", file), "x")));
    files.push(...excess.map((file) => `public/${file}`));
    entries.push(...excess.map((file) => `public/${file}`));
  } else if (mode === "normalization-collision") {
    await writeFile(path.join(runtimeDir, "one"), "one");
    await writeFile(path.join(runtimeDir, "two"), "two");
    const composed = "café.js".normalize("NFC");
    const decomposed = "café.js".normalize("NFD");
    await createTarGzWithTransforms(
      archivePath,
      runtimeDir,
      [`|^one$|public/${composed}|`, `|^two$|public/${decomposed}|`],
      [...entries, "one", "two"],
    );
  } else if (mode === "prefix-normalization-collision") {
    files.push("public/assets/caf\u00e9/a.js", "public/assets/cafe\u0301/b.js");
  }
  if (!["absolute", "normalization-collision", "metadata-over-byte", "metadata-over-count"].includes(mode)) await createTarGz(archivePath, runtimeDir, entries);
  const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", remoteCapsuleId: "capsules.example.dev/team-notes" })}\n`);
  return {
    capsuleDir,
    request: {
      action: "capsule.release.install",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      release: {
        id: "20260630T221500Z-feedface",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        remoteArchive: archivePath,
        restart: false,
        serverEnvIncluded: false,
        files,
        directories: {
          capsule: capsuleDir,
          releases: path.join(capsuleDir, "releases"),
          release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          data: path.join(capsuleDir, "data"),
        },
        currentLink: path.join(capsuleDir, "current"),
      },
    },
  };
}

async function writeHostedCapsuleInstallFixture(dir, options = {}) {
  const remoteRoot = path.join(dir, options.rootName ?? "remote-root");
  const domain = options.domain ?? "capsules.example.dev";
  const subname = options.subname ?? "team-notes";
  const releaseId = options.releaseId ?? "20260630T221500Z-feedface";
  const previousReleaseId = options.previousReleaseId ?? "20260629T120000Z-deadbeef";
  const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", subname);
  const incomingDir = path.join(remoteRoot, "incoming");
  const runtimeDir = path.join(dir, `${options.rootName ?? "remote-root"}-runtime-files`);
  const archivePath = path.join(incomingDir, `${releaseId}.tar.gz`);
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", `${subname}.json`);
  await mkdir(incomingDir, { recursive: true });
  await mkdir(path.join(runtimeDir, "public", "assets", "fonts"), { recursive: true });
  await mkdir(path.join(runtimeDir, "public", "assets", "images"), { recursive: true });
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
  await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
  await writeFile(path.join(runtimeDir, "public", "index.html"), '<link rel="stylesheet" href="/assets/app-a1b2.css"><script type="module" src="/assets/app-a1b2.js"></script>\n');
  await writeFile(path.join(runtimeDir, "public", "assets", "app-a1b2.js"), "console.log('client bundle');\n//# sourceMappingURL=app-a1b2.js.map\n");
  await writeFile(path.join(runtimeDir, "public", "assets", "app-a1b2.js.map"), '{"version":3,"sources":[]}\n');
  await writeFile(path.join(runtimeDir, "public", "assets", "app-a1b2.css"), "body{background:url('./images/logo-a1b2.png')}\n");
  await writeFile(path.join(runtimeDir, "public", "assets", "images", "logo-a1b2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(runtimeDir, "public", "assets", "fonts", "app-a1b2.woff2"), Buffer.from("wOF2fixture"));
  const publicFiles = [
    "public/index.html",
    "public/assets/app-a1b2.js",
    "public/assets/app-a1b2.js.map",
    "public/assets/app-a1b2.css",
    "public/assets/images/logo-a1b2.png",
    "public/assets/fonts/app-a1b2.woff2",
  ];
  await createTarGz(archivePath, runtimeDir, ["server.mjs", "sporades.json", ...publicFiles]);
  await writeFile(
    registryRecordPath,
    `${JSON.stringify({
      subname,
      domain,
      remoteCapsuleId: `${domain}/${subname}`,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      status: "running",
      currentRelease: previousReleaseId ? { id: previousReleaseId } : null,
      releases: previousReleaseId
        ? [
            {
              id: previousReleaseId,
              createdAt: "2026-06-29T12:00:00.000Z",
              uploadedAt: "2026-06-29T12:00:00.000Z",
              state: "verified",
              current: true,
              verificationAttempts: [{ verifiedAt: "2026-06-29T12:01:00.000Z" }],
              failure: null,
            },
          ]
        : [],
    })}\n`,
  );
  return {
    remoteRoot,
    domain,
    subname,
    releaseId,
    previousReleaseId,
    capsuleDir,
    archivePath,
    registryRecordPath,
    release: {
      id: releaseId,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      remoteCapsuleId: `${domain}/${subname}`,
      remoteArchive: archivePath,
      restart: true,
      serverEnvIncluded: false,
      files: ["server.mjs", "sporades.json", ...publicFiles],
      directories: {
        capsule: capsuleDir,
        releases: path.join(capsuleDir, "releases"),
        release: path.join(capsuleDir, "releases", releaseId),
        data: path.join(capsuleDir, "data"),
      },
      currentLink: path.join(capsuleDir, "current"),
    },
    lifecycle: {
      domain,
      subname,
      hostedUrl: `${options.scheme ?? "https"}://${subname}.${domain}`,
      remoteCapsuleId: `${domain}/${subname}`,
      currentLink: path.join(capsuleDir, "current"),
      directories: {
        capsule: capsuleDir,
        releases: path.join(capsuleDir, "releases"),
        release: path.join(capsuleDir, "releases", releaseId),
        data: path.join(capsuleDir, "data"),
      },
      mounts: {
        files: [
          { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
          { host: path.join(capsuleDir, "current", "public"), container: "/app/public", mode: "ro" },
          { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
        ],
        data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
      },
      container: { name: `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}` },
      routes: {
        running: {
          hostname: `${subname}.${domain}`,
          target: "container",
          containerName: `sporades-${domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}-${subname}`,
          port: 4000,
          routeFile: path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`),
          tls: { mode: "automatic" },
        },
        unavailable: {
          hostname: `${subname}.${domain}`,
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile: path.join(remoteRoot, "caddy", "hosts", domain, `${subname}.caddy`),
          tls: { mode: "automatic" },
        },
      },
    },
  };
}

async function writeLegacySealedInstallFixture(dir, options = {}) {
  const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: options.rootName ?? "legacy-sealed-install" });
  const sealedEnvelope = ".sporades/sealed-server-env/server-env.sealed.json";
  const nextKeyFingerprint = "fedcba9876543210";
  const expanded = path.join(dir, `${options.rootName ?? "legacy-sealed-install"}-expanded`);
  await mkdir(expanded);
  const extract = spawnSync("tar", ["-xzf", fixture.archivePath, "-C", expanded], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  await mkdir(path.dirname(path.join(expanded, sealedEnvelope)), { recursive: true });
  await writeFile(path.join(expanded, sealedEnvelope), `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: nextKeyFingerprint, entries: {} })}\n`);
  fixture.release.files.push(sealedEnvelope);
  await rm(fixture.archivePath);
  await createTarGz(fixture.archivePath, expanded, fixture.release.files);

  const previousRelease = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
  await mkdir(path.join(previousRelease, "public"), { recursive: true });
  await writeFile(path.join(previousRelease, "server.mjs"), "previous server\n");
  await writeFile(path.join(previousRelease, "sporades.json"), '{"name":"previous"}\n');
  await writeFile(path.join(previousRelease, "public", "index.html"), "previous public\n");
  await symlink(previousRelease, path.join(fixture.capsuleDir, "current"));
  const privateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "server-env.private.pem");
  await mkdir(path.dirname(privateKeyPath), { recursive: true });
  await writeFile(privateKeyPath, "previous private key bytes\n", { mode: 0o640 });
  const routeFile = path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`);
  await mkdir(path.dirname(routeFile), { recursive: true });
  await writeFile(path.join(fixture.remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
  await writeFile(routeFile, "previous exact route bytes\n");
  const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
  record.status = "running";
  record.baseImage = { name: "previous-image", image: "registry.example/previous:1", version: "1", updatePolicy: { mode: "pinned" } };
  record.releases[0].source = { files: ["server.mjs", "sporades.json", "public/index.html"], sealedServerEnvIncluded: true };
  await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  fixture.release.restart = options.restart ?? false;
  fixture.release.baseImage = { name: "next-image", image: "registry.example/next:2", version: "2", updatePolicy: { mode: "pinned" } };
  fixture.release.sealedServerEnvIncluded = true;
  const nextPrivateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "releases", `${fixture.releaseId}.private.pem`);
  fixture.release.sealedServerEnv = {
    publicKeyFingerprint: nextKeyFingerprint,
    privateKey: "next private key bytes\n",
    privateKeyPath,
  };
  return { ...fixture, privateKeyPath, nextPrivateKeyPath, nextKeyFingerprint, routeFile };
}

async function alignSealedFixtureWithBuiltLifecycle(fixture) {
  const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
  const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
  record.baseImage = lifecycle.container.baseImage;
  await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  fixture.release.baseImage = lifecycle.container.baseImage;
  return lifecycle;
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

async function installFakePreact(projectDir) {
  await writePackage(
    projectDir,
    "preact",
    { ".": "./index.js", "./hooks": "./hooks.js", "./jsx-runtime": "./jsx-runtime.js" },
    {
      "index.js": "export function render() {}\n",
      "hooks.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js": "export const Fragment = Symbol.for('preact.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
}

async function installVue(projectDir) {
  await installProjectVueToolchain(projectDir, repoRoot);
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

test("sporades host stores Host profiles outside projects and resolves the current profile", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addPersonal = await runCli(
      ["host", "add", "personal", "--server", "root@168.119.161.21", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addPersonal.code, 0, addPersonal.stderr);
    assert.deepEqual(JSON.parse(addPersonal.stdout), {
      ok: true,
      data: {
        alias: "personal",
        profile: {
          server: "root@168.119.161.21",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
          tls: { mode: "automatic" },
        },
      },
      error: null,
    });

    const addWork = await runCli(
      ["host", "add", "work", "--server", "deploy@ssh.other.example", "--domain", "islands.other.test", "--json"],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addWork.code, 0, addWork.stderr);

    const usePersonal = await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(usePersonal.code, 0, usePersonal.stderr);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout).data.alias, "personal");
    assert.equal(JSON.parse(current.stdout).data.profile.domain, "capsules.example.dev");

    const override = await runCli(["host", "current", "--host", "work", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(override.code, 0, override.stderr);
    assert.equal(JSON.parse(override.stdout).data.alias, "work");
    assert.equal(JSON.parse(override.stdout).data.profile.server, "deploy@ssh.other.example");
    assert.equal(JSON.parse(override.stdout).data.profile.domain, "islands.other.test");

    const hostConfig = JSON.parse(await readFile(path.join(configDir, "hosts.json"), "utf8"));
    assert.equal(hostConfig.currentHostAlias, "personal");
    assert.deepEqual(hostConfig.profiles.work, {
      server: "deploy@ssh.other.example",
      domain: "islands.other.test",
      scheme: "https",
      remoteRoot: "/srv/sporades",
      tls: { mode: "automatic" },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "hosts.json"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host bind is a local-only project remote binding helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@203.0.113.10", "--domain", "capsules.example.dev", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(["host", "add", "work", "--server", "deployer@198.51.100.40", "--domain", "apps.work.test", "--json"], {
          cwd: projectDir,
          env: { ...hostEnv(configDir), ...fakeSsh.env },
        })
      ).code,
      0,
    );
    assert.equal(
      (await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } })).code,
      0,
    );

    const bind = await runCli(["host", "bind", "notes", "--host", "work", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bind.code, 0, bind.stderr);
    const bindData = JSON.parse(bind.stdout).data;
    assert.equal(bindData.localOnly, true);
    assert.equal(bindData.authoritative, false);
    assert.deepEqual(bindData.binding, {
      hostAlias: "work",
      domain: "apps.work.test",
      scheme: "https",
      subname: "notes",
      hostedUrl: "https://notes.apps.work.test",
      remoteCapsuleId: "apps.work.test/notes",
    });

    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), bindData.binding);

    const current = await runCli(["host", "current", "--json"], { cwd: projectDir, env: hostEnv(configDir) });
    assert.equal(current.code, 0, current.stderr);
    assert.deepEqual(JSON.parse(current.stdout).data.binding, bindData.binding);

    const plainBind = await runCli(["host", "bind", "draft", "--host", "work"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plainBind.code, 0, plainBind.stderr);
    assert.match(plainBind.stdout, /Local remote binding written/);
    assert.match(plainBind.stdout, /does not register or create a Hosted Capsule/);

    await assert.rejects(readFile(path.join(configDir, "remote-binding.json"), "utf8"), { code: "ENOENT" });
    await fakeSsh.assertNotCalled();
  });
});

test("sporades --version --host reports the Host server CLI version", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      profiles: {
        personal: {
          server: "root@203.0.113.10",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/srv/sporades",
          tls: { mode: "automatic" },
        },
      },
      currentHostAlias: "personal",
    });
    const fakeSsh = await installContractFakeSsh(
      dir,
      `
const request = JSON.parse(stdin);
if (request.action !== "host.version") {
  process.stderr.write("unexpected action " + request.action + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    version: "${rootPackageJson.version}",
    source: "host",
    host: {
      alias: request.host.alias,
      domain: request.host.domain
    }
  },
  error: null
}) + "\\n");
`,
    );

    const plain = await runCli(["--version", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, `${rootPackageJson.version}\n`);

    const json = await runCli(["-v", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      ok: true,
      data: {
        version: rootPackageJson.version,
        source: "host",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
        },
      },
      error: null,
    });

    const calls = (await readFile(fakeSsh.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => JSON.parse(call.stdin).action), ["host.version", "host.version"]);
  });
});

test("sporades host upgrade copies the running CLI sibling Host helper to the selected Host server", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
      currentHostAlias: "personal",
    });
    const fakeSsh = await installFakeShellSsh(path.join(dir, "fake-ssh"));
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const result = await runCli(["host", "upgrade", "--host", "personal", "--json"], {
      cwd: dir,
      env,
    });
    assert.equal(result.code, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      ok: true,
      data: {
        alias: "personal",
        version: rootPackageJson.version,
        localHelper: path.join(repoRoot, "bin", "sporades-host-helper.js").split(path.sep).join("/"),
        remoteHelper: "/opt/sporades/bin/sporades-host-helper",
      },
      error: null,
    });

    const sshCalls = (await readFile(fakeSsh.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const [scpCall] = (await readFile(fakeScp.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const helperChecksum = createHash("sha256").update(await readFile(hostHelperPath)).digest("hex");
    const stagedHelper = `/opt/sporades/bin/.sporades-host-helper-stage-${helperChecksum}.mjs`;
    assert.equal(scpCall.source, path.join(repoRoot, "bin", "sporades-host-helper.js"));
    assert.equal(scpCall.target, `root@example.test:${stagedHelper}`);
    assert.deepEqual(sshCalls[0].args, ["root@example.test", "mkdir -p '/opt/sporades/bin'"]);
    assert.equal(sshCalls.length, 2);
    assert.equal(sshCalls[1].args[0], "root@example.test");
    assert.match(sshCalls[1].args[1], new RegExp(`^chmod 0755 '${stagedHelper}' && '${stagedHelper}' --install-host-helper '/opt/sporades/bin/sporades-host-helper' '${helperChecksum}'$`));
  });
});

test("first Host helper upgrade drains legacy actions and blocks new commands behind an atomic dispatcher", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    await chmod(target, 0o755);
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 41001, target);
    const installerLookalike = path.join(procRoot, "41000");
    await mkdir(installerLookalike, { recursive: true });
    await writeFile(path.join(installerLookalike, "cmdline"), Buffer.from(`${process.execPath}\0${stage}\0--install-host-helper\0${target}\0`, "utf8"));
    await writeFile(path.join(installerLookalike, "environ"), Buffer.from("\0", "utf8"));
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "2000",
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
    };
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env });
    await Promise.race([
      waitForFileText(target, (contents) => contents.includes("SPORADES_HOST_HELPER_DISPATCHER_V1")),
      upgrade.result.then((result) => assert.fail(`upgrade exited before dispatcher publication: ${JSON.stringify(result)}`)),
    ]);
    await writeFakeProcEntry(procRoot, 41002, target, [], "start-during-replacement window");

    const request = `${JSON.stringify({
      action: "host.version",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote") },
    })}\n`;
    const command = startExecutable(target, [], { cwd: dir, env, input: request });
    let commandSettled = false;
    command.result.then(() => { commandSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(commandSettled, false, "a new command must wait behind the exclusive upgrade barrier");

    await rm(path.join(procRoot, "41001"), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(commandSettled, false, "a legacy action starting during replacement must also drain");
    await rm(path.join(procRoot, "41002"), { recursive: true, force: true });

    const upgraded = await upgrade.result;
    assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
    const commandResult = await command.result;
    assert.equal(commandResult.code, 0, commandResult.stderr);
    assert.equal(JSON.parse(commandResult.stdout).data.version, rootPackageJson.version, commandResult.stdout);
    const payloadName = (await readFile(path.join(remoteBin, ".sporades-host-helper.active"), "utf8")).trim();
    assert.equal(payloadName, `.sporades-host-helper-payload-${checksum}.mjs`);
    assert.equal(createHash("sha256").update(await readFile(path.join(remoteBin, payloadName))).digest("hex"), checksum);
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.needs-drain")), { code: "ENOENT" });
    assert.deepEqual((await readdir(remoteBin)).filter((entry) => entry.includes(".tmp-")), []);

    await writeFile(path.join(remoteBin, payloadName), Buffer.concat([await readFile(path.join(remoteBin, payloadName)), Buffer.from("\ncorrupt\n")]));
    const corrupted = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(corrupted.stdout).error.message, "Host helper payload integrity check failed.");
    await writeFile(path.join(remoteBin, ".sporades-host-helper.active"), "../../attacker\n");
    const hostilePointer = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(hostilePointer.stdout).error.message, "Host helper dispatcher state is invalid.");
  });
});

test("Host helper upgrade times out fail closed and retries without exposing old and new actions together", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const remoteBin = path.join(remoteRoot, "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper-must-not-run\n", { mode: 0o755 });
    await chmod(target, 0o755);
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 42001, target);
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "100",
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
    };

    const malformedTimeout = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: { ...env, SPORADES_HOST_UPGRADE_LOCK_TIMEOUT_MS: "NaN" },
    }).result;
    assert.equal(malformedTimeout.code, 1);
    assert.equal(await readFile(target, "utf8"), "#!/bin/sh\nprintf '%s\\n' legacy-helper-must-not-run\n");

    const failed = await startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env }).result;
    assert.equal(failed.code, 1);
    assert.match(await readFile(target, "utf8"), /SPORADES_HOST_HELPER_DISPATCHER_V1/);
    assert.equal(await readFile(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked"), "utf8"), "upgrade-recovery-required\n");
    assert.equal(await readFile(path.join(remoteBin, ".sporades-host-helper.needs-drain"), "utf8"), "legacy-helper-drain-required\n");
    const request = `${JSON.stringify({
      action: "host.version",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
    })}\n`;
    const blocked = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).error.message, "Host helper upgrade requires recovery.");
    assert.doesNotMatch(blocked.stdout, /legacy-helper-must-not-run/);

    await rm(path.join(procRoot, "42001"), { recursive: true, force: true });
    const recovered = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: { ...env, SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "1000" },
    }).result;
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    const current = await startExecutable(target, [], { cwd: dir, env, input: request }).result;
    assert.equal(JSON.parse(current.stdout).data.version, rootPackageJson.version, current.stdout);
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.upgrade-blocked")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(remoteBin, ".sporades-host-helper.needs-drain")), { code: "ENOENT" });
  });
});

test("first Host helper upgrade requires stable quiescence when a legacy action becomes identifiable after an empty proc scan", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    const env = {
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      SPORADES_TEST_SHA256_PATH: path.join(repoRoot, "test", "support", "sha256sum.mjs"),
      SPORADES_TEST_PROC_ROOT: procRoot,
      SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "2000",
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
    };
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], { cwd: dir, env });
    await waitForFileText(target, (contents) => contents.includes("SPORADES_HOST_HELPER_DISPATCHER_V1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFakeProcEntry(procRoot, 43001, target);
    let settled = false;
    upgrade.result.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(settled, false, "one empty proc snapshot must not finish legacy drain");
    await rm(path.join(procRoot, "43001"), { recursive: true, force: true });
    const result = await upgrade.result;
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });
});

test("Host helper legacy drain uses a monotonic bounded deadline despite wall-clock rollback", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await writeFakeProcEntry(procRoot, 43002, target);
    const clockRollback = path.join(dir, "clock-rollback.cjs");
    await writeFile(clockRollback, "Date.now = () => 0;\n");
    const upgrade = startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      detached: true,
      env: {
        NODE_OPTIONS: `--require=${clockRollback}`,
        SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
        SPORADES_TEST_PROC_ROOT: procRoot,
        SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "100",
        SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      },
    });
    const forcedKill = setTimeout(() => {
      try { process.kill(-upgrade.child.pid, "SIGKILL"); } catch {}
    }, 500);
    const result = await upgrade.result;
    clearTimeout(forcedKill);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Existing Host helper actions did not drain before the upgrade timeout/);
  });
});

test("Host helper legacy drain rejects an oversized process table within its work bound", async () => {
  await withTempDir(async (dir) => {
    const remoteBin = path.join(dir, "remote", "bin");
    const target = path.join(remoteBin, "sporades-host-helper");
    const procRoot = path.join(dir, "proc");
    await mkdir(remoteBin, { recursive: true });
    await mkdir(procRoot, { recursive: true });
    await writeFile(target, "#!/bin/sh\nprintf '%s\\n' legacy-helper\n", { mode: 0o755 });
    const helperBytes = await readFile(hostHelperPath);
    const checksum = createHash("sha256").update(helperBytes).digest("hex");
    const stage = path.join(remoteBin, `.sporades-host-helper-stage-${checksum}.mjs`);
    await copyFile(hostHelperPath, stage);
    await chmod(stage, 0o755);
    await Promise.all(Array.from({ length: 80 }, (_, index) => mkdir(path.join(procRoot, String(44000 + index)))));
    const startedAt = process.hrtime.bigint();
    const result = await startExecutable(stage, ["--install-host-helper", target, checksum], {
      cwd: dir,
      env: {
        SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
        SPORADES_TEST_PROC_ROOT: procRoot,
        SPORADES_HOST_UPGRADE_DRAIN_TIMEOUT_MS: "1000",
        SPORADES_HOST_UPGRADE_PROC_MAX_ENTRIES: "64",
        SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      },
    }).result;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Host process inspection exceeded its safe work bound/);
    assert.ok(elapsedMs < 1000, `process inspection must be bounded, took ${elapsedMs}ms`);
  });
});

test("sporades host invoke sends a JSON remote helper request over SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `process.stdout.write(JSON.stringify({
  ok: true,
  data: { received: JSON.parse(stdin), helper: "fake" },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const invoke = await runCli(["host", "invoke", "contract.echo", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invoke.code, 0, invoke.stderr);

    const output = JSON.parse(invoke.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.received, {
      action: "contract.echo",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), output.data.received);
  });
});

test("sporades host invoke reports remote helper envelopes separately from SSH transport failures", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
        { cwd: projectDir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
      return result;
    };

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule is not registered.",
    hint: "Run \`sporades host register team-notes\` first."
  }
}) + "\\n");
process.exit(0);
`,
    );
    await addHost(helperFailureSsh.env);
    const helperFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes` first.",
      },
    });

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const commandFailureSsh = await installContractFakeSsh(
      path.join(dir, "command-failure"),
      `process.stderr.write("sporades-host-helper: command not found\\n");
process.exit(127);
`,
    );
    const commandFailure = await runCli(["host", "invoke", "capsule.start", "--host", "personal", "--subname", "team-notes", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...commandFailureSsh.env },
    });
    assert.equal(commandFailure.code, 1);
    assert.deepEqual(JSON.parse(commandFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Remote Host helper command failed.",
        hint: "Check the Host server helper installation and retry the command.",
      },
    });
  });
});

test("sporades host health checks the selected Host profile and reports safe JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health");
      assert.match(request.headers.host, /^host\.localhost:\d+$/);
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

      const health = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          response: { ok: true },
        },
        error: null,
      });

      const explicitHealth = await runCli(["host", "health", "--host", "personal", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
      assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));
    });
  });
});

test("sporades host health checks a Hosted Capsule runtime through the remote helper", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.health") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.health." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.health.hostedUrl,
      remoteCapsuleId: request.health.remoteCapsuleId,
      registered: true
    },
    release: { id: "20260703T120000Z-abc12345", current: true },
    container: { name: request.health.container.name, running: true },
    route: { url: request.health.runtimeHealthUrl, responding: true },
    runtime: {
      ready: true,
      checks: {
        sqlite: { ok: true },
        fileStorage: { ok: true }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });

    const health = await runCli(["host", "health", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });

    assert.equal(health.code, 0, health.stderr);
    assert.deepEqual(JSON.parse(health.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          registered: true,
        },
        release: { id: "20260703T120000Z-abc12345", current: true },
        container: { name: "sporades-capsules-example-dev-team-notes", running: true },
        route: {
          url: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
          responding: true,
        },
        runtime: {
          ready: true,
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
          },
        },
      },
      error: null,
    });

    const explicitHealth = await runCli(["host", "health", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(explicitHealth.code, 0, explicitHealth.stderr);
    assert.deepEqual(JSON.parse(explicitHealth.stdout), JSON.parse(health.stdout));

    const [sshCall, explicitSshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.health",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      health: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        runtimeHealthUrl: "https://team-notes.capsules.example.dev/__sporades/health/runtime",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
    assert.deepEqual(JSON.parse(explicitSshCall.stdin), JSON.parse(sshCall.stdin));
  });
});

test("sporades host health distinguishes unreachable, HTTP failure, and unexpected response shape", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const unreachablePort = await reserveUnusedPort();

    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: `localhost:${unreachablePort}`,
          scheme: "http",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });
    const unreachable = await runCli(["host", "health", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(unreachable.code, 1);
    assert.deepEqual(JSON.parse(unreachable.stdout), {
      ok: false,
      data: {
        alias: "personal",
        healthUrl: `http://host.localhost:${unreachablePort}/__sporades/health`,
        failure: "unreachable",
      },
      error: {
        message: "Host server is unreachable.",
        hint: "Check DNS for the Host server health name, network connectivity, and whether the Host server is running.",
      },
    });

    await withHttpServer((request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"ok":false}\n');
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
      const httpFailure = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(httpFailure.code, 1);
      assert.deepEqual(JSON.parse(httpFailure.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "tls-http",
          statusCode: 503,
        },
        error: {
          message: "Host server health returned an HTTP failure.",
          hint: "Check TLS mode, certificate configuration, Caddy, and the Host server health route.",
        },
      });
    });

    await withHttpServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"version":"0.0.0"}\n');
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
      const unexpectedShape = await runCli(["host", "health", "--json"], {
        cwd: dir,
        env: hostEnv(configDir),
      });
      assert.equal(unexpectedShape.code, 1);
      assert.deepEqual(JSON.parse(unexpectedShape.stdout), {
        ok: false,
        data: {
          alias: "personal",
          healthUrl: `http://host.localhost:${port}/__sporades/health`,
          failure: "unexpected-response",
          statusCode: 200,
        },
        error: {
          message: "Host server health response had an unexpected shape.",
          hint: "Run `sporades host bootstrap --host personal` and check the generated Host server health route.",
        },
      });
    });
  });
});

test("sporades host bootstrap enables one Hosted domain through the remote helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.bootstrap") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.bootstrap." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    bootstrapped: true,
    domain: request.host.domain,
    remoteRoot: request.host.remoteRoot,
    network: request.bootstrap.network,
    packages: request.bootstrap.substrate.packages,
    directories: request.bootstrap.directories,
    tls: request.bootstrap.tls,
    caddy: {
      managedInclude: request.bootstrap.caddy.managedInclude,
      globalConfigReplaced: false
    },
    preservedCapsules: true
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 0, bootstrap.stderr);

    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.deepEqual(output.data.tls, {
      mode: "automatic",
      directory: "/opt/sporades/hosts/capsules.example.dev/tls",
      certificate: null,
      key: null,
    });
    assert.equal(output.data.caddy.managedInclude, "/opt/sporades/caddy/sporades-hosted-domains.caddy");
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.packages, ["docker", "caddy"]);
    assert.deepEqual(output.data.directories, {
      remoteRoot: "/opt/sporades",
      bin: "/opt/sporades/bin",
      incoming: "/opt/sporades/incoming",
      caddy: "/opt/sporades/caddy",
      caddyHosts: "/opt/sporades/caddy/hosts",
      hosts: "/opt/sporades/hosts",
      domain: "/opt/sporades/hosts/capsules.example.dev",
      tls: "/opt/sporades/hosts/capsules.example.dev/tls",
      registry: "/opt/sporades/hosts/capsules.example.dev/registry",
      capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
    });
    assert.equal(output.data.preservedCapsules, true);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot: "/opt/sporades",
          bin: "/opt/sporades/bin",
          incoming: "/opt/sporades/incoming",
          caddy: "/opt/sporades/caddy",
          caddyHosts: "/opt/sporades/caddy/hosts",
          hosts: "/opt/sporades/hosts",
          domain: "/opt/sporades/hosts/capsules.example.dev",
          tls: "/opt/sporades/hosts/capsules.example.dev/tls",
          registry: "/opt/sporades/hosts/capsules.example.dev/registry",
          capsules: "/opt/sporades/hosts/capsules.example.dev/capsules",
        },
        domainDirectory: "/opt/sporades/hosts/capsules.example.dev",
        tls: {
          mode: "automatic",
          directory: "/opt/sporades/hosts/capsules.example.dev/tls",
          certificate: null,
          key: null,
        },
        caddy: {
          managedInclude: "/opt/sporades/caddy/sporades-hosted-domains.caddy",
          domainInclude: "/opt/sporades/caddy/hosts/capsules.example.dev.caddy",
        },
      },
    });
  });
});

test("sporades host bootstrap reports missing Cloudflare origin certificate material with an actionable hint", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Cloudflare origin certificate material is missing or unusable.",
    hint: "Install readable Cloudflare origin certificate and key files at " + request.bootstrap.tls.certificate + " and " + request.bootstrap.tls.key + ", then rerun \`sporades host bootstrap --host " + request.host.alias + "\`."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(bootstrap.code, 1);
    assert.deepEqual(JSON.parse(bootstrap.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: "Install readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key, then rerun `sporades host bootstrap --host personal`.",
      },
    });
  });
});

test("sporades host bootstrap can run against an opt-in real SSH Host server", async (t) => {
  const smoke = await readHostBootstrapSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, and SPORADES_HOST_SMOKE_REMOTE_ROOT to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const addArgs = [
      "host",
      "add",
      smoke.alias,
      "--server",
      smoke.server,
      "--domain",
      smoke.domain,
      "--remote-root",
      smoke.remoteRoot,
      "--tls",
      smoke.tls,
      "--json",
    ];
    const addHost = await runCli(addArgs, { cwd: dir, env: hostEnv(configDir) });
    assert.equal(addHost.code, 0, addHost.stderr);

    const bootstrap = await runCli(["host", "bootstrap", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(bootstrap.code, 0, `${bootstrap.stderr}\n${bootstrap.stdout}`);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.domain, smoke.domain);
    assert.equal(output.data.remoteRoot, smoke.remoteRoot);
    assert.equal(output.data.tls.mode, smoke.tls);
    assert.equal(output.data.preservedCapsules, true);
  });
});

test("sporades host register can run against an opt-in real SSH Host server and returns the unavailable response", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });

    assert.equal(register.code, 0, `${register.stderr}\n${register.stdout}`);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsule.subname, smoke.subname);
    assert.equal(output.data.capsule.domain, smoke.domain);
    assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(output.data.binding.hostedUrl, output.data.capsule.hostedUrl);

    const response = await fetch(output.data.capsule.hostedUrl);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Hosted Capsule unavailable/);
  });
});

test("sporades host logs can read a real Host server after requesting an opt-in Capsule route", async (t) => {
  const smoke = await readHostLogsSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_HOST_LOGS_SMOKE_SSH_TARGET, SPORADES_HOST_LOGS_SMOKE_DOMAIN, SPORADES_HOST_LOGS_SMOKE_REMOTE_ROOT, and SPORADES_HOST_LOGS_SMOKE_SUBNAME to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const marker = `sporades-log-smoke-${Date.now()}`;
    const routeUrl = `https://${smoke.subname}.${smoke.domain}/?${marker}`;
    const response = await fetch(routeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    assert(response.status >= 100, `Expected ${routeUrl} to return an HTTP response`);

    const logs = await runCli(["host", "logs", "--host", smoke.alias, "--lines", String(smoke.lines), "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(logs.code, 0, `${logs.stderr}\n${logs.stdout}`);
    const output = JSON.parse(logs.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.lineCount, smoke.lines);
    assert(Array.isArray(output.data.entries));
    const joinedEntries = output.data.entries.join("\n");
    assert(
      joinedEntries.includes(marker) || joinedEntries.includes(`${smoke.subname}.${smoke.domain}`),
      "Expected recent Caddy log entries to include the triggered Capsule route or marker",
    );
  });
});

test("sporades host list can run against an opt-in real SSH Host server after disposable registration", async (t) => {
  const smoke = await readHostRegisterSmokeEnv();
  if (!smoke) {
    t.skip("Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, and SPORADES_HOST_SMOKE_SUBNAME to run this smoke test.");
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-list-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    let registeredThisRun = false;
    if (register.code === 0) {
      registeredThisRun = true;
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");
    }

    const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.host.domain, smoke.domain);
    const capsule = output.data.capsules.find((candidate) => candidate.subname === smoke.subname);
    assert.ok(capsule, `Expected ${smoke.subname} to appear in host list output.`);
    assert.equal(capsule.domain, smoke.domain);
    assert.equal(capsule.hostedUrl, `https://${smoke.subname}.${smoke.domain}`);
    assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    assert.equal(typeof capsule.registry.status, "string");
    if (registeredThisRun) {
      assert.equal(capsule.currentRelease, null);
    }
  });
});

test("sporades host push can restart a real Hosted Capsule and serve it through the public route", async (t) => {
  const smoke = await readHostPushRoutingSmokeEnv();
  if (!smoke) {
    t.skip(
      "Set SPORADES_HOST_SMOKE_SSH_TARGET, SPORADES_HOST_SMOKE_DOMAIN, SPORADES_HOST_SMOKE_REMOTE_ROOT, SPORADES_HOST_SMOKE_SUBNAME, SPORADES_HOST_SMOKE_PUBLIC_URL, and SPORADES_HOST_SMOKE_EXPECTED_TEXT to run this smoke test.",
    );
    return;
  }

  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const projectName = `${smoke.template}-host-push-routing-smoke`;
    const createResult = await runCli(["create", projectName, "--template", smoke.template, "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, projectName);

    const addHost = await runCli(
      [
        "host",
        "add",
        smoke.alias,
        "--server",
        smoke.server,
        "--domain",
        smoke.domain,
        "--remote-root",
        smoke.remoteRoot,
        "--tls",
        smoke.tls,
        "--json",
      ],
      { cwd: projectDir, env: hostEnv(configDir) },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", smoke.subname, "--host", smoke.alias, "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    if (register.code === 0) {
      const output = JSON.parse(register.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.capsule.subname, smoke.subname);
      assert.equal(output.data.capsule.domain, smoke.domain);
      assert.equal(output.data.capsule.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    } else {
      const output = JSON.parse(register.stdout);
      assert.equal(output.error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

      const list = await runCli(["host", "list", "--host", smoke.alias, "--json"], {
        cwd: projectDir,
        env: hostEnv(configDir),
      });
      assert.equal(list.code, 0, `${list.stderr}\n${list.stdout}`);
      const capsule = JSON.parse(list.stdout).data.capsules.find((candidate) => candidate.subname === smoke.subname);
      assert.ok(capsule, `Expected existing Hosted Capsule ${smoke.subname} to be listed for ${smoke.domain}.`);
      assert.equal(capsule.domain, smoke.domain);
      assert.equal(capsule.registry.remoteCapsuleId, `${smoke.domain}/${smoke.subname}`);
    }

    const push = await runCli(["host", "push", "--host", smoke.alias, "--subname", smoke.subname, "--restart", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const pushOutput = JSON.parse(push.stdout);
    assert.equal(pushOutput.ok, true);
    assert.equal(pushOutput.error, null);
    assert.equal(pushOutput.data.installed, true);
    assert.equal(pushOutput.data.restartRequested, true);
    assert.equal(pushOutput.data.restarted, true);
    assert.equal(pushOutput.data.capsule.subname, smoke.subname);
    assert.equal(pushOutput.data.capsule.domain, smoke.domain);

    const response = await fetch(withCacheBust(smoke.publicUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, new RegExp(escapeRegExp(smoke.expectedText)));
  });
});

test("sporades host helper bootstraps a Hosted domain idempotently without deleting Capsule state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const preservedCapsuleFile = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data", "data.db");
    await mkdir(path.dirname(preservedCapsuleFile), { recursive: true });
    await writeFile(preservedCapsuleFile, "existing capsule data\n");
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "unrelated.example.dev {\n  respond \"still here\"\n}\n");
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        substrate: {
          packages: ["docker", "caddy"],
          services: ["docker", "caddy"],
        },
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        domainDirectory: path.join(remoteRoot, "hosts", "capsules.example.dev"),
        tls: {
          mode: "automatic",
          directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
          certificate: null,
          key: null,
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const bootstrap = await runHostHelper(request, { cwd: dir, env });

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    const output = JSON.parse(bootstrap.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.bootstrapped, true);
    assert.equal(output.data.preservedCapsules, true);
    assert.deepEqual(output.data.network, {
      name: "sporades-hosted-capsules",
      created: true,
    });
    assert.equal(output.data.caddy.managedInclude, path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"));
    assert.equal(output.data.caddy.domainInclude, path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"));
    assert.equal(output.data.caddy.globalConfigReplaced, false);
    assert.deepEqual(output.data.caddy.accessLog, {
      file: path.join(remoteRoot, "caddy", "logs", "access.log"),
      directory: path.join(remoteRoot, "caddy", "logs"),
      owner: "caddy",
      writableByService: true,
    });

    assert.equal(await readFile(preservedCapsuleFile, "utf8"), "existing capsule data\n");
    assert.equal((await stat(path.join(remoteRoot, "bin"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "incoming"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "caddy", "logs"))).isDirectory(), true);
    assert.equal(await readFile(path.join(remoteRoot, "caddy", "logs", "access.log"), "utf8"), "");
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"))).isDirectory(), true);
    assert.equal((await stat(path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"))).isDirectory(), true);
    const caddyfile = await readFile(path.join(remoteRoot, "caddy", "Caddyfile"), "utf8");
    assert.match(caddyfile, /unrelated\.example\.dev \{\n  respond "still here"\n\}/);
    assert.match(caddyfile, new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"))}`));
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "*.caddy"))}`),
    );
    assert.match(
      await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "utf8"),
      new RegExp(`import ${escapeRegExp(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "*.caddy"))}`),
    );
    const healthRoute = await readFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "host.caddy"), "utf8");
    assert.match(healthRoute, /host\.capsules\.example\.dev \{/);
    assert.match(healthRoute, /respond \/__sporades\/health "\{\\"ok\\":true\}" 200/);
    assert.doesNotMatch(healthRoute, /container|registry|\/srv|remote-root|version|metrics|secret/i);

    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["network", "inspect", "sporades-hosted-capsules"],
        ["network", "create", "sporades-hosted-capsules"],
      ],
    );
    assert.deepEqual(
      (await caddyUser.chownCalls()).map((call) => call.args),
      [],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["validate", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper reads configurable production defaults from remoteRoot JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(
      path.join(remoteRoot, "sporades-host-helper.json"),
      `${JSON.stringify(
        {
          hostedCapsule: {
            dockerNetwork: "sporades-custom-network",
          },
          logs: {
            defaultLines: 2,
            maxLines: 50,
          },
        },
        null,
        2,
      )}\n`,
    );

    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1" } });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const bootstrap = await runHostHelper(
      {
        action: "host.bootstrap",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env },
    );

    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.deepEqual(JSON.parse(bootstrap.stdout).data.network, {
      name: "sporades-custom-network",
      created: true,
    });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args).slice(0, 2),
      [
        ["network", "inspect", "sporades-custom-network"],
        ["network", "create", "sporades-custom-network"],
      ],
    );

    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await writeFile(accessLog, ["old", "one", "two"].join("\n") + "\n");
    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["one", "two"],
      },
      error: null,
    });

    const explicitLogs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 1 },
      },
      { cwd: dir },
    );

    assert.equal(explicitLogs.code, 0, explicitLogs.stderr);
    assert.deepEqual(JSON.parse(explicitLogs.stdout), {
      ok: true,
      data: {
        lineCount: 1,
        source: "http",
        entries: ["two"],
      },
      error: null,
    });
  });
});

test("sporades host helper returns a structured error for invalid config JSON", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(path.join(remoteRoot, "sporades-host-helper.json"), "{ nope\n");

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined" },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host helper config is invalid JSON.",
        hint: `Fix ${path.join(remoteRoot, "sporades-host-helper.json")}, then retry the Host helper command.`,
      },
    });
  });
});

test("sporades host helper requires readable Cloudflare origin certificate files only for cloudflare-origin TLS", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const tlsDirectory = path.join(remoteRoot, "hosts", "capsules.example.dev", "tls");
    const docker = await installFakeDocker(dir);
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
      bootstrap: {
        directories: {
          remoteRoot,
          bin: path.join(remoteRoot, "bin"),
          incoming: path.join(remoteRoot, "incoming"),
          caddy: path.join(remoteRoot, "caddy"),
          caddyHosts: path.join(remoteRoot, "caddy", "hosts"),
          hosts: path.join(remoteRoot, "hosts"),
          domain: path.join(remoteRoot, "hosts", "capsules.example.dev"),
          tls: tlsDirectory,
          registry: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry"),
          capsules: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules"),
        },
        tls: {
          mode: "cloudflare-origin",
          directory: tlsDirectory,
          certificate: path.join(tlsDirectory, "origin.crt"),
          key: path.join(tlsDirectory, "origin.key"),
        },
        network: "sporades-hosted-capsules",
        caddy: {
          managedInclude: path.join(remoteRoot, "caddy", "sporades-hosted-domains.caddy"),
          domainInclude: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"),
        },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir, env });

    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Cloudflare origin certificate material is missing or unusable.",
        hint: `Install readable Cloudflare origin certificate and key files at ${path.join(tlsDirectory, "origin.crt")} and ${path.join(tlsDirectory, "origin.key")}, then rerun \`sporades host bootstrap --host personal\`.`,
      },
    });
    await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });

    await writeFile(path.join(tlsDirectory, "origin.crt"), "certificate\n");
    await writeFile(path.join(tlsDirectory, "origin.key"), "key\n");
    const present = await runHostHelper(request, { cwd: dir, env });
    assert.equal(present.code, 0, present.stderr);
    const output = JSON.parse(present.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.tls.mode, "cloudflare-origin");
    assert.equal(output.data.tls.certificate, path.join(tlsDirectory, "origin.crt"));
    assert.equal(output.data.tls.key, path.join(tlsDirectory, "origin.key"));
  });
});

test("sporades host helper reports Docker and Caddy bootstrap substrate failures as JSON errors", async () => {
  await withTempDir(async (dir) => {
    const dockerFailureRoot = path.join(dir, "docker-failure-root");
    const docker = await installFakeDocker(path.join(dir, "docker-failure"), {
      env: {
        FAKE_DOCKER_NETWORK_INSPECT_STATUS: "1",
        FAKE_DOCKER_NETWORK_CREATE_STATUS: "1",
      },
    });
    const baseRequest = {
      action: "host.bootstrap",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: dockerFailureRoot,
      },
      capsule: null,
      bootstrap: {
        tls: { mode: "automatic", directory: path.join(dockerFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        network: "sporades-hosted-capsules",
      },
    };

    const dockerFailure = await runHostHelper(baseRequest, { cwd: dir, env: docker.env });

    assert.equal(dockerFailure.code, 0, dockerFailure.stderr);
    const dockerFailureOutput = JSON.parse(dockerFailure.stdout);
    assert.equal(dockerFailureOutput.ok, false);
    assert.equal(dockerFailureOutput.error.message, "Failed to create the Hosted Capsule Docker network.");
    assert.match(dockerFailureOutput.error.hint, /Check Docker on the Host server/);

    const caddyFailureRoot = path.join(dir, "caddy-failure-root");
    const caddy = await installFakeDocker(path.join(dir, "caddy-failure"), {
      env: {
        FAKE_DOCKER_CADDY_VALIDATE_STATUS: "1",
      },
    });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-failure-user"));
    const caddyFailureEnv = {
      ...caddy.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const caddyFailure = await runHostHelper(
      {
        ...baseRequest,
        host: { ...baseRequest.host, remoteRoot: caddyFailureRoot },
        bootstrap: {
          tls: { mode: "automatic", directory: path.join(caddyFailureRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
          network: "sporades-hosted-capsules",
        },
      },
      { cwd: dir, env: caddyFailureEnv },
    );

    assert.equal(caddyFailure.code, 0, caddyFailure.stderr);
    const caddyFailureOutput = JSON.parse(caddyFailure.stdout);
    assert.equal(caddyFailureOutput.ok, false);
    assert.equal(caddyFailureOutput.error.message, "Failed to validate the Sporades Caddy bootstrap configuration.");
    assert.match(caddyFailureOutput.error.hint, /Check Caddy on the Host server/);
  });
});

test("sporades host bootstrap rejects path overrides and final-entry symlinks without touching outside bytes", async () => {
  await withTempDir(async (dir) => {
    const outside = path.join(dir, "outside.txt");
    await writeFile(outside, "outside-byte-identity\n", { mode: 0o600 });
    const overrideRoot = path.join(dir, "override-root");
    const override = await runHostHelper({
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: overrideRoot },
      capsule: null,
      bootstrap: { caddy: { accessLog: outside }, tls: { mode: "automatic" } },
    }, { cwd: dir });
    assert.equal(JSON.parse(override.stdout).error.message, "Invalid Host bootstrap path.", override.stdout);
    assert.equal(await readFile(outside, "utf8"), "outside-byte-identity\n");

    const finalEntries = [
      ["caddyfile", (root) => path.join(root, "caddy", "Caddyfile")],
      ["managed", (root) => path.join(root, "caddy", "sporades-hosted-domains.caddy")],
      ["domain", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev.caddy")],
      ["health", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev", "host.caddy")],
      ["placeholder", (root) => path.join(root, "caddy", "hosts", "capsules.example.dev", ".sporades-placeholder.caddy")],
      ["access-log", (root) => path.join(root, "caddy", "logs", "access.log")],
    ];
    for (const [name, resolveFinal] of finalEntries) {
      const remoteRoot = path.join(dir, `symlink-${name}`);
      const finalPath = resolveFinal(remoteRoot);
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o755 });
      await symlink(outside, finalPath);
      const result = await runHostHelper({
        action: "host.bootstrap",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        bootstrap: { tls: { mode: "automatic" } },
      }, { cwd: dir });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${name}: ${result.stdout}`);
      assert.equal(await readFile(outside, "utf8"), "outside-byte-identity\n", name);
    }
  });
});

test("sporades host bootstrap revalidates the trusted chain immediately before atomic publication", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const marker = path.join(dir, "bootstrap-boundary.marker");
    const outside = path.join(dir, "outside");
    const domainDirectory = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev");
    const preservedDirectory = `${domainDirectory}.preserved`;
    await mkdir(outside, { mode: 0o700 });
    const sentinel = path.join(outside, "sentinel.bin");
    await writeFile(sentinel, Buffer.from([9, 8, 7, 6, 5, 4]));
    const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const action = startHostHelper({
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, {
      cwd: dir,
      env: {
        ...docker.env,
        ...caddyUser.env,
        PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-health-route-publish",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS: "700",
      },
    });
    await waitForPath(marker);
    await rename(domainDirectory, preservedDirectory);
    await symlink(outside, domainDirectory, "dir");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before);
    assert.deepEqual(await readdir(outside), ["sentinel.bin"]);
  });
});

test("sporades host bootstrap retains exact Caddy access-log ownership across idempotent root runs", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"), {
      env: { FAKE_CADDY_UID: "12345", FAKE_CADDY_GID: "12346", FAKE_CADDY_APPLY_CHOWN: "1" },
    });
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    };
    const first = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(first.stdout).ok, true, `first: ${first.stdout}`);
    const repeatMutationMarker = path.join(dir, "repeat-mutation.marker");
    const repeat = await runHostHelper(request, {
      cwd: dir,
      env: {
        ...env,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-access-log-descriptor-mutate",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: repeatMutationMarker,
      },
    });
    assert.equal(JSON.parse(repeat.stdout).ok, true, `repeat: ${repeat.stdout}`);
    await assert.rejects(readFile(repeatMutationMarker, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await caddyUser.chownCalls(), [], "bootstrap must never delegate privileged ownership changes to pathname-based chown");
    const logDirectory = path.join(remoteRoot, "caddy", "logs");
    const logFile = path.join(logDirectory, "access.log");
    assert.deepEqual([Number((await lstat(logDirectory)).uid), Number((await lstat(logDirectory)).gid)], [12345, 12346]);
    assert.deepEqual([Number((await lstat(logFile)).uid), Number((await lstat(logFile)).gid)], [12345, 12346]);

    await chown(logFile, 22345, 22346);
    const foreign = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(foreign.stdout).error.message, "Hosted Capsule route trust validation failed.", foreign.stdout);
    assert.deepEqual([Number((await lstat(logFile)).uid), Number((await lstat(logFile)).gid)], [22345, 22346]);

    await chown(logFile, 12345, 12346);
    await chown(logDirectory, 22345, 22346);
    const foreignDirectory = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(foreignDirectory.stdout).error.message, "Hosted Capsule route trust validation failed.", foreignDirectory.stdout);
    assert.deepEqual([Number((await lstat(logDirectory)).uid), Number((await lstat(logDirectory)).gid)], [22345, 22346]);
  });
});

test("sporades host bootstrap keeps privileged access-log repair on retained inodes when Caddy replaces the pathname", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"), {
      env: { FAKE_CADDY_UID: "12345", FAKE_CADDY_GID: "12346", FAKE_CADDY_APPLY_CHOWN: "1" },
    });
    const env = {
      ...docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      action: "host.bootstrap",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    };
    const initial = await runHostHelper(request, { cwd: dir, env });
    assert.equal(JSON.parse(initial.stdout).ok, true, initial.stdout);

    const logFile = path.join(remoteRoot, "caddy", "logs", "access.log");
    const retainedLogFile = `${logFile}.retained`;
    await chmod(logFile, 0o600);
    const outside = path.join(dir, "outside.bin");
    await writeFile(outside, Buffer.from([4, 8, 15, 16, 23, 42]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
    const marker = path.join(dir, "descriptor-boundary.marker");
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...env,
        SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: "bootstrap-access-log-descriptor-mutate",
        SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS: "700",
      },
    });
    await waitForPath(marker);
    await rename(logFile, retainedLogFile);
    await symlink(outside, logFile);
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);

    const outsideAfter = await lstat(outside);
    assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash);
    assert.equal(Number(outsideAfter.mode) & 0o777, Number(outsideBefore.mode) & 0o777);
    assert.deepEqual([Number(outsideAfter.uid), Number(outsideAfter.gid)], [Number(outsideBefore.uid), Number(outsideBefore.gid)]);
    assert.equal(Number((await lstat(retainedLogFile)).mode) & 0o777, 0o640, "repair stayed on the retained file descriptor");
    assert.deepEqual(await caddyUser.chownCalls(), []);
  });
});

test("sporades host helper registers Hosted Capsules with registry state and unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const request = {
      action: "capsule.register",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: {
        subname: "team-notes",
      },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
          logs: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 418,
          routeFile: path.join(dir, "caller-controlled", "team-notes.caddy"),
          tls: {
            mode: "cloudflare-origin",
            directory: path.join(dir, "caller-controlled", "tls"),
            certificate: path.join(dir, "caller-controlled", "tls", "origin.crt"),
            key: path.join(dir, "caller-controlled", "tls", "origin.key"),
          },
        },
      },
    };
    const expectedRoute = {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy"),
      tls: {
        mode: "automatic",
        directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"),
        certificate: null,
        key: null,
      },
      log: { file: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log") },
    };

    const register = await runHostHelper(request, { cwd: dir, env: caddy.env });

    assert.equal(register.code, 0, register.stderr);
    const output = JSON.parse(register.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.registered, true);
    assert.equal(output.data.authoritative, true);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.registryRecord, request.registration.registryRecord);
    assert.deepEqual(output.data.directories, request.registration.directories);
    assert.deepEqual(output.data.route, expectedRoute);
    assert.equal(typeof output.data.sealedServerEnv.publicKey, "string");
    assert.match(output.data.sealedServerEnv.publicKey, /PUBLIC KEY/);
    assert.match(output.data.sealedServerEnv.publicKeyFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(
      output.data.sealedServerEnv.publicKeyPath,
      path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data", "sealed-server-env", "keys", `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`),
    );
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE KEY/);

    const record = JSON.parse(await readFile(request.registration.registryRecord, "utf8"));
    assert.equal(record.subname, "team-notes");
    assert.equal(record.domain, "capsules.example.dev");
    assert.equal(record.remoteCapsuleId, "capsules.example.dev/team-notes");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.status, "registered");
    assert.equal(record.currentRelease, null);
    assert.deepEqual(record.sealedServerEnv, {
      currentKeyFingerprint: output.data.sealedServerEnv.publicKeyFingerprint,
    });
    assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.updatedAt, record.createdAt);
    assert.equal((await stat(request.registration.directories.releases)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.data)).isDirectory(), true);
    assert.equal((await stat(request.registration.directories.logs)).isDirectory(), true);
    const privateKeyPath = path.join(
      request.registration.directories.data,
      "sealed-server-env",
      "keys",
      `${output.data.sealedServerEnv.publicKeyFingerprint}.private.pem`,
    );
    const publicKeyPath = path.join(
      request.registration.directories.data,
      "sealed-server-env",
      "keys",
      `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`,
    );
    assert.match(await readFile(privateKeyPath, "utf8"), /PRIVATE KEY/);
    assert.equal(await readFile(publicKeyPath, "utf8"), output.data.sealedServerEnv.publicKey);
    assert.equal((await stat(path.dirname(path.dirname(privateKeyPath)))).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(privateKeyPath))).mode & 0o777, 0o700);
    assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(publicKeyPath)).mode & 0o777, 0o644);
    const originalPrivateKey = await readFile(privateKeyPath, "utf8");
    const routeContents = await readFile(expectedRoute.routeFile, "utf8");
    assert.match(routeContents, /team-notes\.capsules\.example\.dev/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.match(routeContents, /hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log/);
    assert.doesNotMatch(routeContents, /418|caller-controlled|tls /);
    await assert.rejects(readFile(request.registration.route.routeFile, "utf8"), { code: "ENOENT" });
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${expectedRoute.routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );

    const duplicateDocker = await installFakeDocker(path.join(dir, "duplicate-docker"));
    const duplicate = await runHostHelper(request, {
      cwd: dir,
      env: {
        ...caddy.env,
        ...duplicateDocker.env,
        PATH: `${duplicateDocker.fakeBinDir}${path.delimiter}${caddy.fakeBinDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(await readFile(privateKeyPath, "utf8"), originalPrivateKey);
    assert.equal(JSON.parse(await readFile(request.registration.registryRecord, "utf8")).sealedServerEnv.currentKeyFingerprint, output.data.sealedServerEnv.publicKeyFingerprint);
    assert.deepEqual(JSON.parse(duplicate.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });
    await assert.rejects(readFile(duplicateDocker.logPath, "utf8"), { code: "ENOENT" });

    const otherDomainRoot = path.join(dir, "other-domain-root");
    await mkdir(path.join(otherDomainRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(otherDomainRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test.caddy"), "import ./apps.work.test/*.caddy\n");
    const otherDomainRequest = {
      ...request,
      host: {
        ...request.host,
        domain: "apps.work.test",
        remoteRoot: otherDomainRoot,
      },
      registration: {
        ...request.registration,
        domain: "apps.work.test",
        hostedUrl: "https://team-notes.apps.work.test",
        remoteCapsuleId: "apps.work.test/team-notes",
        registryRecord: path.join(otherDomainRoot, "hosts", "apps.work.test", "registry", "capsules", "team-notes.json"),
        directories: {
          capsule: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes"),
          releases: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "releases"),
          data: path.join(otherDomainRoot, "hosts", "apps.work.test", "capsules", "team-notes", "data"),
        },
        route: {
          ...request.registration.route,
          hostname: "team-notes.apps.work.test",
          routeFile: path.join(otherDomainRoot, "caddy", "hosts", "apps.work.test", "team-notes.caddy"),
          tls: {
            mode: "automatic",
            directory: path.join(otherDomainRoot, "hosts", "apps.work.test", "tls"),
            certificate: null,
            key: null,
          },
        },
      },
    };

    const sameSubnameOtherDomain = await runHostHelper(otherDomainRequest, { cwd: dir, env: caddy.env });
    assert.equal(sameSubnameOtherDomain.code, 0, sameSubnameOtherDomain.stderr);
    assert.equal(JSON.parse(sameSubnameOtherDomain.stdout).data.capsule.remoteCapsuleId, "apps.work.test/team-notes");
  });
});

test("sporades host helper rotates a Hosted Capsule sealed-env key and cleans only unreferenced keys", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const dataDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data");
    const keysDir = path.join(dataDir, "sealed-server-env", "keys");
    const oldFingerprint = "0123456789abcdef";
    const staleFingerprint = "9999999999999999";
    await mkdir(keysDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(keysDir, `${oldFingerprint}.private.pem`), "old retained private key\n");
    await writeFile(path.join(keysDir, `${oldFingerprint}.public.pem`), "old retained public key\n");
    await writeFile(path.join(keysDir, `${staleFingerprint}.private.pem`), "stale private key\n");
    await writeFile(path.join(keysDir, `${staleFingerprint}.public.pem`), "stale public key\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "released",
        currentRelease: { id: "20260630T221500Z-feedface" },
        sealedServerEnv: { currentKeyFingerprint: oldFingerprint },
        releases: [
          {
            id: "20260630T221500Z-feedface",
            current: true,
            state: "started",
            source: {
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: oldFingerprint },
            },
          },
        ],
      })}\n`,
    );

    const rotate = await runHostHelper(
      {
        action: "capsule.sealed-env.rotate-key",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir },
    );

    assert.equal(rotate.code, 0, rotate.stderr);
    const output = JSON.parse(rotate.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rotated, true);
    assert.equal(output.data.sealedServerEnv.previousPublicKeyFingerprint, oldFingerprint);
    assert.match(output.data.sealedServerEnv.publicKeyFingerprint, /^[a-f0-9]{16}$/);
    assert.notEqual(output.data.sealedServerEnv.publicKeyFingerprint, oldFingerprint);
    assert.match(output.data.sealedServerEnv.publicKey, /PUBLIC KEY/);
    assert.equal(
      output.data.sealedServerEnv.publicKeyPath,
      path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`),
    );
    assert.doesNotMatch(rotate.stdout, /PRIVATE KEY|old retained private key|stale private key/);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, output.data.sealedServerEnv.publicKeyFingerprint);
    assert.equal(record.releases[0].source.sealedServerEnv.publicKeyFingerprint, oldFingerprint);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(await readFile(path.join(keysDir, `${oldFingerprint}.private.pem`), "utf8"), "old retained private key\n");
    assert.equal(await readFile(path.join(keysDir, `${oldFingerprint}.public.pem`), "utf8"), "old retained public key\n");
    await assert.rejects(readFile(path.join(keysDir, `${staleFingerprint}.private.pem`), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(keysDir, `${staleFingerprint}.public.pem`), "utf8"), { code: "ENOENT" });
    assert.match(await readFile(path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.private.pem`), "utf8"), /PRIVATE KEY/);
    assert.equal(
      await readFile(path.join(keysDir, `${output.data.sealedServerEnv.publicKeyFingerprint}.public.pem`), "utf8"),
      output.data.sealedServerEnv.publicKey,
    );
    assert.deepEqual(output.data.cleanup.deletedKeyFingerprints, [staleFingerprint]);
    assert.deepEqual(output.data.cleanup.retainedKeyFingerprints.sort(), [oldFingerprint, output.data.sealedServerEnv.publicKeyFingerprint].sort());
  });
});

test("sporades host helper restores the exact pre-rotation running state", async () => {
  for (const [label, running] of [["running", true], ["stopped", false]]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: String(running) } });
      const result = await runHostHelper({
        action: "capsule.sealed-env.rotate-key",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "team-notes" },
      }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(result.stdout).ok, true, `${label}: ${result.stdout}\n${result.stderr}\n${JSON.stringify(await docker.calls())}`);
      const calls = (await docker.calls()).map((call) => call.args[0]);
      if (running) {
        assert.deepEqual(calls, ["inspect", "stop", "rm", "image", "run", "inspect", "inspect"], label);
        assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      } else {
        assert.deepEqual(calls, ["inspect"], label);
        assert.notEqual(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
      }
    });
  }
});

test("sporades host helper descriptor-fences sealed-env key creation after quiescing Docker", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const outside = path.join(dir, "outside-key.bin");
    await writeFile(outside, Buffer.from([4, 2, 4, 2]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
    const marker = path.join(dir, "sealed-key.marker");
    const request = {
      action: "capsule.sealed-env.rotate-key",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
    };
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_BOUNDARY: "runtime-data-descriptor-mutate",
        SPORADES_TEST_RUNTIME_DATA_MUTATION_MARKER: marker,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_TARGET_SUFFIX: ".private.pem",
        SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS: "700",
      },
    });
    const keyPath = (await waitForFileText(marker, (contents) => contents.endsWith(".private.pem\n"))).trim();
    assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["inspect", "stop", "rm"]);
    const retained = `${keyPath}.retained`;
    await rename(keyPath, retained);
    await symlink(outside, keyPath);
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule runtime restoration failed.", result.stdout);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "stopped");
    const outsideAfter = await lstat(outside);
    assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash);
    assert.deepEqual([outsideAfter.mode & 0o777, outsideAfter.uid, outsideAfter.gid], [outsideBefore.mode & 0o777, outsideBefore.uid, outsideBefore.gid]);
    assert.match(await readFile(retained, "utf8"), /PRIVATE KEY/);

    await rm(path.join(fixture.dataDir, "sealed-server-env"), { recursive: true, force: true });
    const outsideDirectory = path.join(dir, "outside-key-directory");
    const sentinel = path.join(outsideDirectory, "sentinel.bin");
    await mkdir(outsideDirectory);
    await writeFile(sentinel, Buffer.from([1, 6, 1, 8]), { mode: 0o604 });
    const sentinelHash = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    await symlink(outsideDirectory, path.join(fixture.dataDir, "sealed-server-env"));
    const ancestor = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(ancestor.stdout).error.message, "Hosted Capsule runtime restoration failed.", ancestor.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), sentinelHash);
    assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"]);
  });
});

test("sporades host helper fences sealed-key cleanup to the retained keys directory", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const keys = path.join(fixture.dataDir, "sealed-server-env", "keys");
    const stale = "9999999999999999";
    await mkdir(keys, { recursive: true });
    await writeFile(path.join(keys, `${stale}.private.pem`), "stale private\n", { mode: 0o600 });
    await writeFile(path.join(keys, `${stale}.public.pem`), "stale public\n", { mode: 0o644 });
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const marker = path.join(dir, "cleanup.marker");
    const request = {
      action: "capsule.sealed-env.rotate-key",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
    };
    const action = startHostHelper(request, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_TREE_PUBLICATION_BOUNDARY: "sealed-key-cleanup",
        SPORADES_TEST_RUNTIME_TREE_PUBLICATION_MARKER: marker,
        SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS: "700",
      },
    });
    await waitForPath(marker);
    const retained = `${keys}.retained`;
    const outside = path.join(dir, "outside-cleanup");
    await mkdir(outside, { mode: 0o711 });
    for (const suffix of ["private", "public"]) await writeFile(path.join(outside, `${stale}.${suffix}.pem`), `outside ${suffix}\n`, { mode: suffix === "private" ? 0o604 : 0o644 });
    const before = await Promise.all((await readdir(outside)).map(async (name) => {
      const file = path.join(outside, name);
      const details = await lstat(file);
      return [name, createHash("sha256").update(await readFile(file)).digest("hex"), details.mode & 0o777, details.uid, details.gid];
    }));
    await rename(keys, retained);
    await symlink(outside, keys);
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", result.stdout);
    const after = await Promise.all((await readdir(outside)).map(async (name) => {
      const file = path.join(outside, name);
      const details = await lstat(file);
      return [name, createHash("sha256").update(await readFile(file)).digest("hex"), details.mode & 0o777, details.uid, details.gid];
    }));
    assert.deepEqual(after, before);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).sealedServerEnv, undefined);
  });
});

test("sporades host helper rejects non-canonical per-Capsule HTTP log paths before filesystem mutation", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const outsideDirectory = path.join(dir, "outside");
    await mkdir(outsideDirectory, { mode: 0o700 });
    const sentinel = path.join(outsideDirectory, "sentinel.bin");
    await writeFile(sentinel, Buffer.from([1, 3, 3, 7]), { mode: 0o600 });
    const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const caddy = await installFakeCaddy(dir);
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const result = await runHostHelper({
      action: "capsule.register",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      registration: {
        route: { log: { file: path.join(outsideDirectory, "http.log") } },
      },
    }, { cwd: dir, env: caddy.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule HTTP log path.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before);
    assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"]);

    for (const [label, lifecycle] of [
      ["legacy", { accessLog: path.join(outsideDirectory, "legacy.log") }],
      ["shared", { routes: { accessLog: path.join(outsideDirectory, "shared.log") } }],
      ["running", { routes: { running: { log: { file: path.join(outsideDirectory, "running.log") } } } }],
      ["unavailable", { routes: { unavailable: { log: { file: path.join(outsideDirectory, "unavailable.log") } } } }],
    ]) {
      const lifecycleResult = await runHostHelper({
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle,
      }, { cwd: dir, env: caddy.env });
      assert.equal(JSON.parse(lifecycleResult.stdout).error.message, "Invalid Hosted Capsule HTTP log path.", `${label}: ${lifecycleResult.stdout}`);
      assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, label);
      assert.deepEqual(await readdir(outsideDirectory), ["sentinel.bin"], label);
    }
  });
});

test("sporades host helper provisions running and unavailable Capsule HTTP logs once by retained descriptor", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    for (const routeKind of ["running", "unavailable"]) {
      const fixture = await setupRootCapsuleHttpLogFixture(path.join(dir, routeKind), routeKind);
      const details = await lstat(fixture.logFile);
      const directoryDetails = await lstat(path.dirname(fixture.logFile));
      assert.deepEqual([Number(details.uid), Number(details.gid), Number(details.mode) & 0o777], [12345, 12346, 0o640], routeKind);
      assert.deepEqual([Number(directoryDetails.uid), Number(directoryDetails.gid), Number(directoryDetails.mode) & 0o777], [12345, 12346, 0o750], routeKind);

      const marker = path.join(dir, `${routeKind}-repeat-mutation.marker`);
      const repeat = await runHostHelper(fixture.request, {
        cwd: path.join(dir, routeKind),
        env: {
          ...fixture.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: `capsule-${routeKind}-http-log-descriptor-mutate`,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
        },
      });
      assert.equal(JSON.parse(repeat.stdout).ok, true, `${routeKind} repeat: ${repeat.stdout}\n${repeat.stderr}`);
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
      assert.deepEqual(await fixture.caddyUser.chownCalls(), [], routeKind);

      await chown(fixture.logFile, 22345, 22346);
      const foreign = await runHostHelper(fixture.request, { cwd: path.join(dir, routeKind), env: fixture.env });
      assert.equal(JSON.parse(foreign.stdout).error.message, "Hosted Capsule route trust validation failed.", `${routeKind} foreign owner: ${foreign.stdout}`);
      assert.deepEqual([Number((await lstat(fixture.logFile)).uid), Number((await lstat(fixture.logFile)).gid)], [22345, 22346], routeKind);
    }
  });
});

test("sporades host helper fences running and unavailable Capsule HTTP log replacement after descriptor open", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("requires the isolated root ownership-changing fixture");
    return;
  }
  await withTempDir(async (dir) => {
    for (const routeKind of ["running", "unavailable"]) {
      const fixtureDir = path.join(dir, routeKind);
      const fixture = await setupRootCapsuleHttpLogFixture(fixtureDir, routeKind);
      await chmod(fixture.logFile, 0o600);
      const retainedLogFile = `${fixture.logFile}.retained`;
      const outside = path.join(fixtureDir, "outside.bin");
      await writeFile(outside, Buffer.from([2, 7, 1, 8, 2, 8]), { mode: 0o604 });
      const outsideBefore = await lstat(outside);
      const outsideHash = createHash("sha256").update(await readFile(outside)).digest("hex");
      const marker = path.join(fixtureDir, "descriptor-mutation.marker");
      const action = startHostHelper(fixture.request, {
        cwd: fixtureDir,
        env: {
          ...fixture.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: `capsule-${routeKind}-http-log-descriptor-mutate`,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS: "700",
        },
      });
      await waitForPath(marker);
      await rename(fixture.logFile, retainedLogFile);
      await symlink(outside, fixture.logFile);
      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${routeKind}: ${result.stdout}`);

      const outsideAfter = await lstat(outside);
      assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), outsideHash, routeKind);
      assert.equal(Number(outsideAfter.mode) & 0o777, Number(outsideBefore.mode) & 0o777, routeKind);
      assert.deepEqual([Number(outsideAfter.uid), Number(outsideAfter.gid)], [Number(outsideBefore.uid), Number(outsideBefore.gid)], routeKind);
      assert.equal(Number((await lstat(retainedLogFile)).mode) & 0o777, 0o640, `${routeKind} repair stayed on the retained file descriptor`);
      assert.deepEqual(await fixture.caddyUser.chownCalls(), [], routeKind);
    }
  });
});

test("sporades host helper does not commit registration when the unavailable route cannot be applied", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import ./capsules.example.dev/*.caddy\n");
    const failingCaddy = await installFakeCaddy(path.join(dir, "failing-caddy"), { env: { FAKE_CADDY_RELOAD_STATUS: "1" } });
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecord = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const request = {
      action: "capsule.register",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord,
        directories: {
          capsule: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes"),
          releases: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "releases"),
          data: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "data"),
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile,
          tls: { mode: "automatic", directory: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls"), certificate: null, key: null },
        },
      },
    };

    const failed = await runHostHelper(request, { cwd: dir, env: failingCaddy.env });
    assert.equal(failed.code, 0, failed.stderr);
    const failedOutput = JSON.parse(failed.stdout);
    assert.equal(failedOutput.ok, false);
    assert.equal(failedOutput.data, null);
    assert.match(failedOutput.error.message, /^Failed to apply Hosted Capsule route/);
    await assert.rejects(readFile(registryRecord, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });

    const repairedCaddy = await installFakeCaddy(path.join(dir, "repaired-caddy"));
    const repaired = await runHostHelper(request, { cwd: dir, env: repairedCaddy.env });
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).ok, true);
    assert.equal(JSON.parse(await readFile(registryRecord, "utf8")).status, "registered");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host register creates authoritative remote state and then writes local binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.register") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.register." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId
    },
    registryRecord: request.registration.registryRecord,
    directories: request.registration.directories,
    route: request.registration.route
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 0, register.stderr);

    const output = JSON.parse(register.stdout);
    const bindingPath = path.join(projectDir, ".sporades", "remote-binding.json");
    const expectedBinding = {
      hostAlias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      subname: "team-notes",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    };
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.registered, true);
    assert.equal(output.data.authoritative, true);
    assert.equal(output.data.localBinding, true);
    assert.match(output.data.bindingPath, /\.sporades\/remote-binding\.json$/);
    assert.deepEqual(output.data.binding, expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(output.data.bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(JSON.parse(await readFile(bindingPath, "utf8")), expectedBinding);
    assert.deepEqual(output.data.route, {
      hostname: "team-notes.capsules.example.dev",
      target: "hosted-capsule-unavailable",
      statusCode: 503,
      routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
      tls: {
        mode: "automatic",
        directory: "/opt/sporades/hosts/capsules.example.dev/tls",
        certificate: null,
        key: null,
      },
      log: {
        file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
      },
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.register",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      registration: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        route: {
          hostname: "team-notes.capsules.example.dev",
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
          log: {
            file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log",
          },
        },
        baseImage: {
          name: "sporades-base",
          image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
          version: "0.1.0-node22-alpine",
          updatePolicy: {
            mode: "host-managed",
            autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
          },
        },
        bootstrap: {
          command: "sporades host bootstrap --host personal",
          tls: {
            mode: "automatic",
            directory: "/opt/sporades/hosts/capsules.example.dev/tls",
            certificate: null,
            key: null,
          },
        },
      },
    });
  });
});

test("sporades host rotate-key invokes the Hosted Capsule sealed-env rotation helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.sealed-env.rotate-key") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.sealed-env.rotate-key." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    rotated: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://" + request.capsule.subname + "." + request.host.domain
    },
    sealedServerEnv: {
      previousPublicKeyFingerprint: "0123456789abcdef",
      publicKeyFingerprint: "fedcba9876543210",
      publicKey: "-----BEGIN PUBLIC KEY-----\\\\nrotated\\\\n-----END PUBLIC KEY-----\\\\n",
      publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/fedcba9876543210.public.pem"
    },
    cleanup: {
      deletedKeyFingerprints: ["9999999999999999"],
      retainedKeyFingerprints: ["0123456789abcdef", "fedcba9876543210"]
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const env = { ...hostEnv(configDir), ...fakeSsh.env };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const rotate = await runCli(["host", "rotate-key", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env,
    });
    assert.equal(rotate.code, 0, rotate.stderr);
    const output = JSON.parse(rotate.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rotated, true);
    assert.equal(output.data.sealedServerEnv.previousPublicKeyFingerprint, "0123456789abcdef");
    assert.equal(output.data.sealedServerEnv.publicKeyFingerprint, "fedcba9876543210");

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.sealed-env.rotate-key",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });
  });
});

test("sporades host push uploads a runtime-only release archive and installs it without restart by default", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      archive: request.release.remoteArchive,
      directory: request.release.directories.release,
      currentLink: request.release.currentLink,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(bind.code, 0, bind.stderr);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);

    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.release.directory, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(output.data.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
    ]);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.match(scpCall.source, /\.sporades\/host-push\/.+\.tar\.gz$/);
    assert.equal(scpCall.target, `root@example.test:/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    const uploadedArchives = await readdir(fakeScp.uploadDir);
    assert.deepEqual(uploadedArchives, [`${output.data.release.id}.tar.gz`]);
    const entries = await listArchiveEntries(path.join(fakeScp.uploadDir, uploadedArchives[0]), projectDir);
    assert.deepEqual(entries, [
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.capsule.subname, "team-notes");
    assert.equal(request.release.restart, false);
    assert.equal(request.release.remoteArchive, `/opt/sporades/incoming/${output.data.release.id}.tar.gz`);
    assert.equal(request.release.directories.data, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data");
    assert.equal(request.release.directories.release, `/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases/${output.data.release.id}`);
    assert.equal(request.release.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
  });
});

test("sporades host push packages generated SSH authorized keys without leaking source file paths", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const sourceKeyPath = path.join(dir, "operator.keys");
    await writeFile(sourceKeyPath, `# operator keys\n${TEST_PUBLIC_KEY}\n`);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      ssh: request.release.ssh || null
    },
    lifecycle: {
      auditEvents: [{
        category: "audit",
        event: "ssh.access.enabled",
        data: {
          operation: "ssh.hosted-capsule.start",
          metadata: {
            enabled: true,
            keyCount: request.release.ssh?.keyCount ?? 0,
            fingerprints: request.release.ssh?.fingerprints ?? [],
            targetPort: 22,
            loopbackOnly: true
          }
        }
      }]
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "ssh-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ file: sourceKeyPath }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(Object.hasOwn(output.data.release, "ssh"), false);
    assert.equal(Object.hasOwn(output.data, "lifecycle"), false);
    assert.doesNotMatch(push.stdout, /auditEvents|ssh\.access\.enabled|ssh\.hosted-capsule\.start|SHA256:/);
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
    ]);
    assert.doesNotMatch(push.stdout, /\.sporades\/ssh\/authorized_keys/);
    assert.doesNotMatch(push.stdout, /operator\.keys/);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      ".sporades/ssh/authorized_keys",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    assert.equal(await extractArchiveFile(scpCall.copiedTo, ".sporades/ssh/authorized_keys", projectDir), `${TEST_PUBLIC_KEY}\n`);
    assert.match(
      (await listArchiveVerboseEntries(scpCall.copiedTo, projectDir)).find((entry) => entry.endsWith(" .sporades/ssh/authorized_keys")) ?? "",
      /^-rw-r--r--\s+/,
    );
    assert.doesNotMatch(await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir), /operator\.keys/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.deepEqual(request.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      ".sporades/ssh/authorized_keys",
    ]);
    assert.equal(request.release.ssh.enabled, true);
    assert.equal(request.release.ssh.keyCount, 1);
    assert.equal(request.release.ssh.authorizedKeysPath, ".sporades/ssh/authorized_keys");
    assert.equal(request.release.ssh.fingerprints.length, 1);
    assert.doesNotMatch(JSON.stringify(request.release.ssh), /operator\.keys/);

    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.config.validated", "ssh.config.validate", "completed"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.equal(auditEvents[0].data.targetResourceKind, "hosted-ssh-config");
    assert.equal(auditEvents[0].data.metadata.enabled, true);
    assert.equal(auditEvents[0].data.metadata.keyCount, 1);
    assert.deepEqual(auditEvents[0].data.metadata.fingerprints, request.release.ssh.fingerprints);
    assert.doesNotMatch(JSON.stringify(auditEvents), /operator\.keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|authorized_keys/);
  });
});

test("sporades host push strips disabled SSH config file paths from the release archive", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const sourceKeyPath = path.join(dir, "comments-only.keys");
    await writeFile(sourceKeyPath, "# no effective keys today\n\n");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      ssh: request.release.ssh || null
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "disabled-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "disabled-ssh-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ file: sourceKeyPath }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.doesNotMatch(push.stdout, /comments-only\.keys/);
    assert.doesNotMatch(push.stdout, /\.sporades\/ssh\/authorized_keys/);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    const archiveConfig = await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir);
    assert.doesNotMatch(archiveConfig, /comments-only\.keys/);
    assert.equal(JSON.parse(archiveConfig).ssh, undefined);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.release.ssh, null);
    assert.deepEqual(request.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
    ]);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.metadata.enabled, entry.data.metadata.reason]),
      [["ssh.config.validated", "ssh.config.validate", "completed", false, "no-authorized-keys"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.doesNotMatch(JSON.stringify(auditEvents), /comments-only\.keys|authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);
  });
});

test("sporades host push rejects invalid SSH config before uploading a release", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: { message: "Unexpected helper call.", hint: "SSH validation should stop first." }
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "bad-host-ssh", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "bad-host-ssh");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.ssh = { authorizedKeys: [{ key: "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----" }] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, false);
    assert.match(output.error.message, /private key/);
    assert.match(output.error.hint, /public authorized_keys material only/);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
      [["ssh.config.validated", "ssh.config.validate", "errored", "SSH_CONFIG_INVALID"]],
    );
    assert.equal(auditEvents[0].data.surface, "sporades/host-push");
    assert.equal(auditEvents[0].data.metadata.reason, "invalid-ssh-config");
    assert.doesNotMatch(JSON.stringify(auditEvents), /OPENSSH PRIVATE KEY|nope/);
    await assert.rejects(readFile(fakeScp.logPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(fakeSsh.logPath, "utf8"), { code: "ENOENT" });
  });
});

test("sporades host push re-encrypts Sealed Server env to the rotated current Hosted Capsule key", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const oldHostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const rotatedHostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const oldFingerprint = createHash("sha256").update(oldHostKeyPair.publicKey).digest("hex").slice(0, 16);
    const rotatedFingerprint = createHash("sha256").update(rotatedHostKeyPair.publicKey).digest("hex").slice(0, 16);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action === "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      capsules: [{
        subname: "team-notes",
        domain: request.host.domain,
        hostedUrl: "https://team-notes." + request.host.domain,
        registry: {
          sealedServerEnv: { currentKeyFingerprint: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT }
        },
        currentRelease: {
          id: "20260629T120000Z-deadbeef",
          sealedServerEnv: { publicKeyFingerprint: process.env.FAKE_OLD_HOST_PUBLIC_KEY_FINGERPRINT }
        },
        sealedServerEnv: {
          publicKey: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY,
          publicKeyFingerprint: process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT,
          publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/" + process.env.FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT + ".public.pem"
        }
      }]
    },
    error: null
  }) + "\\n");
  process.exit(0);
}
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded,
      sealedServerEnvIncluded: request.release.sealedServerEnvIncluded,
      sealedServerEnv: request.release.sealedServerEnv
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "sealed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "sealed-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      FAKE_OLD_HOST_PUBLIC_KEY_FINGERPRINT: oldFingerprint,
      FAKE_ROTATED_HOST_PUBLIC_KEY: rotatedHostKeyPair.publicKey,
      FAKE_ROTATED_HOST_PUBLIC_KEY_FINGERPRINT: rotatedFingerprint,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.equal(output.data.release.sealedServerEnv.publicKeyFingerprint, rotatedFingerprint);
    assert.notEqual(output.data.release.sealedServerEnv.publicKeyFingerprint, oldFingerprint);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const archiveEnvelope = await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xOzf", scpCall.copiedTo, ".sporades/sealed-server-env/server-env.sealed.json"], {
        cwd: projectDir,
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
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    assert.equal(JSON.parse(archiveEnvelope).publicKeyFingerprint, rotatedFingerprint);

    const [, installCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(installCall.stdin);
    assert.equal(request.release.sealedServerEnv.publicKeyFingerprint, rotatedFingerprint);
  });
});

test("sporades host push automatically re-encrypts Sealed Server env to the Hosted Capsule public key", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const hostKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const hostPublicKeyFingerprint = createHash("sha256").update(hostKeyPair.publicKey).digest("hex").slice(0, 16);
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action === "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      capsules: [{
        subname: "team-notes",
        domain: request.host.domain,
        hostedUrl: "https://team-notes." + request.host.domain,
        sealedServerEnv: {
          publicKey: process.env.FAKE_HOST_PUBLIC_KEY,
          publicKeyFingerprint: process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT,
          publicKeyPath: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/keys/" + process.env.FAKE_HOST_PUBLIC_KEY_FINGERPRINT + ".public.pem"
        }
      }]
    },
    error: null
  }) + "\\n");
  process.exit(0);
}
if (request.action !== "capsule.release.install") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.install." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restarted: false,
    release: {
      id: request.release.id,
      files: request.release.files,
      serverEnvIncluded: request.release.serverEnvIncluded,
      sealedServerEnvIncluded: request.release.sealedServerEnvIncluded,
      sealedServerEnv: request.release.sealedServerEnv
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "sealed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "sealed-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\nPUBLIC_LABEL=not-client\n");

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      FAKE_HOST_PUBLIC_KEY: hostKeyPair.publicKey,
      FAKE_HOST_PUBLIC_KEY_FINGERPRINT: hostPublicKeyFingerprint,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    assert.doesNotMatch(push.stdout, /swordfish|not-client|PRIVATE KEY/);
    const output = JSON.parse(push.stdout);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.equal(output.data.release.sealedServerEnv.publicKeyFingerprint, hostPublicKeyFingerprint);
    assert.equal(output.data.release.sealedServerEnv.privateKey, undefined);
    assert.equal(output.data.release.sealedServerEnv.privateKeyPath, undefined);
    assert.deepEqual(output.data.release.files, [
      "server.mjs",
      "sporades.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [
      ".sporades/sealed-server-env/server-env.sealed.json",
      "public/client.js",
      "public/client.js.map",
      "public/index.html",
      "server.mjs",
      "sporades.json",
    ]);
    const archiveEnvelope = await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xOzf", scpCall.copiedTo, ".sporades/sealed-server-env/server-env.sealed.json"], {
        cwd: projectDir,
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
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    assert.doesNotMatch(archiveEnvelope, /swordfish|not-client|PRIVATE KEY/);
    assert.equal(JSON.parse(archiveEnvelope).publicKeyFingerprint, hostPublicKeyFingerprint);

    const [listCall, installCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(listCall.stdin).action, "capsule.list");
    const request = JSON.parse(installCall.stdin);
    assert.equal(request.release.sealedServerEnvIncluded, true);
    assert.equal(request.release.sealedServerEnv.publicKeyFingerprint, hostPublicKeyFingerprint);
    assert.equal(request.release.sealedServerEnv.privateKey, undefined);
    assert.equal(request.release.sealedServerEnv.privateKeyPath, undefined);
    assert.doesNotMatch(JSON.stringify(request.release), /swordfish|not-client|PRIVATE KEY/);
  });
});

test("sporades host push refuses legacy Server env values instead of silently importing them", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Should not be called.", hint: "Preflight should fail locally." } }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "legacy-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "legacy-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    assert.doesNotMatch(push.stdout, /swordfish|PRIVATE KEY/);
    const output = JSON.parse(push.stdout);
    assert.equal(output.error.message, "Hosted Capsule push requires Sealed Server env.");
    assert.match(output.error.hint, /sporades env import/);
    assert.deepEqual(output.error.diagnostics, {
      source: "legacy-server-env",
      legacyServerEnvFilePresent: true,
      localSealedServerEnvConfigured: false,
      requiresExplicitImport: true,
    });
    await fakeSsh.assertNotCalled?.();
    await assert.rejects(readFile(fakeScp.logPath, "utf8"), { code: "ENOENT" });
  });
});

test("sporades host push reports a structured recovery hint when local sealed source values are unavailable", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Should not be called.", hint: "Preflight should fail locally." } }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "missing-source-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "missing-source-island");
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    assert.equal((await runCli(["env", "import", "--json"], { cwd: projectDir })).code, 0);
    await rm(path.join(projectDir, ".sporades", "sealed-server-env", "server-env.private.pem"));
    await rm(path.join(projectDir, ".env.sporades.server"));
    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const push = await runCli(["host", "push", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 1);
    const output = JSON.parse(push.stdout);
    assert.equal(output.error.message, "Local Sealed Server env source values are unavailable.");
    assert.match(output.error.hint, /local Sealed Server env private key|source-of-truth values/);
    assert.deepEqual(output.error.diagnostics, {
      source: "local-sealed-server-env",
      localSealedServerEnvConfigured: true,
      localPrivateKeyConfigured: false,
      legacyServerEnvFilePresent: false,
      requiresSourceOfTruthValues: true,
    });
    assert.doesNotMatch(push.stdout, /swordfish|PRIVATE KEY/);
  });
});

test("sporades host push can publish a Vanilla TypeScript Capsule and request restart", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: request.release.restart,
    restarted: false,
    release: {
      id: request.release.id,
      serverEnvIncluded: request.release.serverEnvIncluded,
      files: request.release.files
    },
    capsule: {
      subname: request.capsule.subname,
      hostedUrl: request.release.hostedUrl
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "vanilla-island", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "vanilla-island");
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const push = await runCli(["host", "push", "--host", "work", "--subname", "field-notes", "--restart", "--json"], {
      cwd: projectDir,
      env,
    });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.serverEnvIncluded, false);
    assert.deepEqual(output.data.release.files, ["server.mjs", "sporades.json", "public/client.js", "public/client.js.map", "public/index.html"]);
    assert.equal(output.data.capsule.hostedUrl, "https://field-notes.apps.work.test");
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });

    const [scpCall] = await readJsonl(fakeScp.logPath);
    assert.equal(scpCall.target, `deploy@example.test:/srv/sporades/incoming/${output.data.release.id}.tar.gz`);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, ["public/client.js", "public/client.js.map", "public/index.html", "server.mjs", "sporades.json"]);
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(clientBundle, /Vanilla Sporades/);
    assert.doesNotMatch(clientBundle, /react-dom|preact\/hooks/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.host.alias, "work");
    assert.equal(request.host.domain, "apps.work.test");
    assert.equal(request.capsule.subname, "field-notes");
    assert.equal(request.release.restart, true);
  });
});

for (const { framework, template, toolchain, build } of CLIENT_CAPABILITIES.flatMap((capability) =>
  CLIENT_TEMPLATES.map((template) => ({ framework: capability.framework, toolchain: capability.toolchain, build: capability.build, template })),
)) test(`sporades host push archives the complete normalized ${framework} ${toolchain} ${template} public tree`, async () => {
  await withTempDir(async (dir) => {
    const selectedToolchain = toolchain;
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin); process.stdout.write(JSON.stringify({ ok: true, data: { installed: true, release: { id: request.release.id, files: request.release.files }, capsule: { subname: request.capsule.subname, hostedUrl: request.release.hostedUrl } }, error: null }) + "\\n");`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const created = await runCli(
      ["create", "vite-hosted", "--template", template, "--framework", framework, "--toolchain", selectedToolchain, "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(created.code, 0, created.stderr);
    const projectDir = path.join(dir, "vite-hosted");
    await (framework === "vanilla" ? async () => {} : framework === "react" ? installFakeReact : framework === "preact" ? installFakePreact : framework === "inferno" ? (project) => installProjectInfernoToolchain(project, repoRoot) : framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot) : framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot) : framework === "vue" ? installVue : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    const clientPath = path.join(projectDir, "client", build.entry);
    const clientSource = await readFile(clientPath, "utf8");
    await Promise.all([
      writeFile(path.join(projectDir, "client", "matrix-nested.ts"), 'import icon from "./matrix.svg"; import font from "./matrix.woff2"; export const matrixAsset = `${icon}:${font}`;\n'),
      writeFile(path.join(projectDir, "client", "matrix.css"), '@font-face{font-family:Matrix;src:url("./matrix.woff2")} .matrix-proof{background:url("./matrix.svg")}\n'),
      writeFile(path.join(projectDir, "client", "matrix.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n'),
      writeFile(path.join(projectDir, "client", "matrix.woff2"), "matrix-font-bytes\n"),
      writeFile(clientPath, `${clientSource}\nimport "./matrix.css"; import("./matrix-nested.ts").then(({ matrixAsset }) => console.log(matrixAsset));\n`),
    ]);
    if (template === "photo-library") {
      const configPath = path.join(projectDir, "sporades.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.auth = { providers: { anonymous: true } };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const env = {
      ...hostEnv(configDir), ...fakeSsh.env, ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    assert.equal((await runCli(
      ["host", "add", "work", "--server", "deploy@example.test", "--domain", "apps.work.test", "--remote-root", "/srv/sporades", "--json"],
      { cwd: projectDir, env },
    )).code, 0);

    const push = await runCli(["host", "push", "--host", "work", "--subname", "vite-app", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    const files = output.data.release.files;
    assert(files.includes("public/index.html"));
    assert(files.some((file) => selectedToolchain === "esbuild" ? file === "public/client.js" : /^public\/assets\/index-[^/]+\.js$/.test(file)));
    assert(files.some((file) => /^public\/assets\/.+\.js$/.test(file) && !/^public\/assets\/index-/.test(file)), JSON.stringify(files));
    if (selectedToolchain === "vite" && (framework === "react" || framework === "preact")) assert(files.some((file) => /^public\/assets\/vite-scaffold-[^/]+\.js$/.test(file)));
    assert(files.filter((file) => file.startsWith("public/")).every((file) => !file.includes("..") && !file.includes("\\") && /\.(?:html|js|map|css|svg|png|jpe?g|gif|webp|ico|woff2?)$/.test(file)), "Hosted public paths stay bounded to supported MIME assets");
    assert(files.some((file) => file.endsWith(".js.map")));
    for (const extension of [".css", ".svg", ".woff2"]) assert(files.some((file) => file.endsWith(extension)), `${framework}/${toolchain}/${template} emits ${extension}`);
    assert.equal(files.includes("public/client.js"), selectedToolchain === "esbuild");

    const [scpCall] = await readJsonl(fakeScp.logPath);
    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const helperRequest = JSON.parse(sshCall.stdin);
    const validated = validateReleaseArchive(helperRequest, scpCall.copiedTo);
    const entries = await listArchiveEntries(scpCall.copiedTo, projectDir);
    assert.deepEqual(entries, [...files.filter((file) => file.startsWith("public/")), "server.mjs", "sporades.json"].sort());
    assert.deepEqual(validated.files.map(({ path }) => path).sort(), [...entries].sort());
    assert(validated.files.every(({ path, size }) => Number.isSafeInteger(size) && size > 0 && !path.includes("..") && !path.includes("\\")));
    const hostedConfig = JSON.parse(await extractArchiveFile(scpCall.copiedTo, "sporades.json", projectDir));
    assert.deepEqual(hostedConfig.client, { framework, toolchain });
    for (const extension of [".html", ".js", ".js.map", ".css", ".svg", ".woff2"]) {
      const representative = entries.find((file) => file.endsWith(extension));
      assert(representative, `${framework}/${toolchain}/${template} archive contains ${extension}`);
      assert((await extractArchiveFile(scpCall.copiedTo, representative, projectDir)).length > 0, representative);
    }
    const publicEntries = entries.filter((file) => file.startsWith("public/"));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree);
    const publicText = (await Promise.all(publicEntries.map((file) => readFile(path.join(publicRoot, file.slice("public/".length)), "utf8")))).join("\n");
    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(publicText, /dev\.refresh\.(?:subscribe|ready|received)/, "Hosted client output omits Dev refresh protocol");
    assert.doesNotMatch(serverBundle, /dev\.refresh\.(?:subscribe|ready|received)/, "Hosted server output omits Dev refresh capability and hints");
    assert.doesNotMatch(publicText, /\/@vite\/client|react-refresh|vite\/hmr|SERVER_ONLY/i);
    if (framework === "preact") assert.doesNotMatch(publicText, /node_modules\/react(?:-dom)?\/|from ["']react(?:-dom)?/);
    if (framework === "solid") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime/);
    }
    if (framework === "lit") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
    if (framework === "vue") assert.match(publicText, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "svelte") assert.match(publicText, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "inferno") {
      assert.match(publicText, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(publicText, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
  });
});

test("sporades host push --verify requests Hosted Capsule restart and release verification", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      path.join(dir, "fake-ssh"),
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.install" || request.release.restart !== true || !request.verification) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected verification request.", hint: "Use capsule.release.install with verification." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    installed: true,
    restartRequested: true,
    restarted: true,
    verified: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.release.hostedUrl
    },
    release: {
      id: request.release.id,
      current: true
    },
    previousCurrentRelease: { id: "20260629T120000Z-deadbeef" },
    currentAttemptedRelease: { id: request.release.id },
    verification: {
      state: "verified",
      health: {
        route: { responding: true },
        runtime: {
          ready: true,
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } }
        }
      }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const fakeScp = await installFakeScp(path.join(dir, "fake-scp"));
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"), { force: true });
    const projectConfigPath = path.join(projectDir, "sporades.json");
    const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
    projectConfig.baseImage = { updatePolicy: { mode: "manual" } };
    await writeFile(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);

    const env = {
      ...hostEnv(configDir),
      ...fakeSsh.env,
      ...fakeScp.env,
      PATH: `${fakeSsh.fakeBinDir}${path.delimiter}${fakeScp.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(bind.code, 0, bind.stderr);

    const push = await runCli(["host", "push", "--verify", "--json"], { cwd: projectDir, env });
    assert.equal(push.code, 0, `${push.stderr}\n${push.stdout}`);
    const output = JSON.parse(push.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.verification.state, "verified");
    assert.equal(output.data.verification.health.runtime.ready, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.match(output.data.release.id, /^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    assert.equal(output.data.previousCurrentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.currentAttemptedRelease.id, output.data.release.id);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(sshCall.stdin);
    assert.equal(request.action, "capsule.release.install");
    assert.equal(request.release.restart, true);
    assert.equal(request.release.baseImage.updatePolicy.mode, "manual");
    assert.equal(request.verification.enabled, true);
    assert.equal(request.verification.health.runtimeHealthUrl, "https://team-notes.capsules.example.dev/__sporades/health/runtime");
    assert.equal(request.lifecycle.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(request.lifecycle.container.baseImage.updatePolicy.mode, "manual");
    assert.equal(request.lifecycle.container.labels["com.sporades.base-image.update-policy"], "manual");
  });
});

test("sporades host start stop and restart invoke the Hosted Capsule lifecycle helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    action: request.action,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.lifecycle.hostedUrl
    },
    container: request.lifecycle.container,
    route: request.lifecycle.routes[request.action === "capsule.stop" ? "unavailable" : "running"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const start = await runCli(["host", "start", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(start.code, 0, start.stderr);
    const startOutput = JSON.parse(start.stdout);
    assert.equal(startOutput.data.action, "capsule.start");
    assert.equal(startOutput.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.managed"], "true");
    assert.equal(startOutput.data.container.labels["com.sporades.hosted-domain"], "capsules.example.dev");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-subname"], "team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.capsule-id"], "capsules.example.dev/team-notes");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.name"], "sporades-base");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.version"], "0.1.0-node22-alpine");
    assert.equal(startOutput.data.container.labels["com.sporades.base-image.update-policy"], "host-managed");
    assert.deepEqual(startOutput.data.container.baseImage, {
      name: "sporades-base",
      image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      version: "0.1.0-node22-alpine",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
    assert.equal(startOutput.data.route.target, "container");

    const stop = await runCli(["host", "stop", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.action, "capsule.stop");
    assert.equal(JSON.parse(stop.stdout).data.route.target, "hosted-capsule-unavailable");

    const restart = await runCli(["host", "restart", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(restart.code, 0, restart.stderr);
    assert.equal(JSON.parse(restart.stdout).data.action, "capsule.restart");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(
      calls.map((call) => JSON.parse(call.stdin).action),
      ["capsule.start", "capsule.stop", "capsule.restart"],
    );
    const startRequest = JSON.parse(calls[0].stdin);
    assert.equal(startRequest.lifecycle.currentLink, "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current");
    assert.deepEqual(startRequest.lifecycle.mounts.files, [
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/public", container: "/app/public", mode: "ro" },
      { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server",
        container: "/app/.env.sporades.server",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
        container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
        mode: "ro",
        optional: true,
      },
      {
        host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
        container: "/app/.sporades/sealed-server-env/server-env.private.pem",
        mode: "ro",
        optional: true,
      },
    ]);
    assert.deepEqual(startRequest.lifecycle.mounts.data, {
      host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
      container: "/app/data",
      mode: "rw",
    });
    assert.equal(startRequest.lifecycle.container.image, "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine");
    assert.equal(startRequest.lifecycle.container.user, "10001:10001");
    assert.deepEqual(startRequest.lifecycle.container.baseImage, {
      name: "sporades-base",
      image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      version: "0.1.0-node22-alpine",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
  });
});

test("sporades host helper installs a release atomically and updates the current pointer", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".env.sporades.server",
    ]);
    const previousReleaseDir = path.join(capsuleDir, "releases", "20260629T120000Z-deadbeef");
    await mkdir(previousReleaseDir, { recursive: true });
    await symlink(previousReleaseDir, path.join(capsuleDir, "current"));
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        releases: { malformed: true },
      })}\n`,
    );

    const request = {
      action: "capsule.release.install",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: {
        subname: "team-notes",
      },
      release: {
        id: "20260630T221500Z-feedface",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteArchive: archivePath,
        restart: false,
        serverEnvIncluded: true,
        files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"],
        directories: {
          capsule: capsuleDir,
          releases: path.join(capsuleDir, "releases"),
          release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          data: path.join(capsuleDir, "data"),
        },
        currentLink: path.join(capsuleDir, "current"),
      },
    };

    const runningDocker = await installFakeDocker(path.join(dir, "running-docker"));
    const install = await runHostHelper(request, { cwd: dir, env: runningDocker.env });
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: true,
      data: {
        installed: true,
        restartRequested: false,
        restarted: false,
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
        },
        release: {
          id: "20260630T221500Z-feedface",
          directory: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          currentLink: path.join(capsuleDir, "current"),
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"],
          serverEnvIncluded: true,
        },
      },
      error: null,
    });

    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    const currentTarget = await readFile(path.join(capsuleDir, "current"), "utf8").catch(() => null);
    assert.equal(currentTarget, null);
    const symlinkTarget = await readlink(path.join(capsuleDir, "current"));
    assert.equal(symlinkTarget, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server", "index.ts"), "utf8"), {
      code: "ENOENT",
    });
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "uploaded");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].source.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(record.releases[0].source.serverEnvIncluded, true);
    await assert.rejects(readFile(runningDocker.logPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual(record.releases[0].source.files, ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".env.sporades.server"]);
    assert.match(record.releases[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].uploadedAt, record.releases[0].createdAt);
  });
});

test("sporades host helper extracts the atomically claimed archive when the incoming path is swapped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "archive-swap", previousReleaseId: null });
    fixture.release.restart = false;
    const maliciousDir = path.join(dir, "malicious-runtime");
    for (const file of fixture.release.files) {
      const target = path.join(maliciousDir, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file === "public/index.html" ? '<script src="/assets/evil.js"></script>\n' : "malicious replacement bytes\n");
    }
    const maliciousArchive = path.join(dir, "malicious-swap.tar.gz");
    await createTarGz(maliciousArchive, maliciousDir, fixture.release.files);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
      },
      { cwd: dir, env: { SPORADES_TEST_HOST_ARCHIVE_SWAP_PATH: maliciousArchive } },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).ok, true, install.stdout);
    const installed = path.join(fixture.capsuleDir, "releases", fixture.releaseId);
    assert.match(await readFile(path.join(installed, "public", "assets", "app-a1b2.js"), "utf8"), /client bundle/);
    assert.doesNotMatch(await readFile(path.join(installed, "public", "index.html"), "utf8"), /evil\.js/);
    await assert.rejects(stat(fixture.archivePath), { code: "ENOENT" });
    await assert.rejects(stat(maliciousArchive), { code: "ENOENT" });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), installed);
  });
});

test("sporades host helper rejects non-canonical Sealed Server env private key paths", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const escapedPrivateKeyPath = path.join(dir, "escaped-private.pem");
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "{\"version\":1,\"valueAlgorithm\":\"aes-256-gcm\",\"entries\":{}}\n");
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            privateKey: "-----BEGIN PRIVATE KEY-----\\nnot-real\\n-----END PRIVATE KEY-----\\n",
            privateKeyPath: escapedPrivateKeyPath,
          },
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Sealed Server env private key path.",
        hint: "Update the Sporades CLI and retry `sporades host push`.",
      },
    });
    await assert.rejects(readFile(escapedPrivateKeyPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(capsuleDir, "current"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host helper rejects invalid lifecycle authority before a sealed-key release changes state", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: "sealed-lifecycle-authority" });
    const previousRelease = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(previousRelease, { recursive: true });
    await writeFile(path.join(previousRelease, "server.mjs"), "previous server\n");
    await symlink(previousRelease, path.join(fixture.capsuleDir, "current"));
    const privateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "server-env.private.pem");
    await mkdir(path.dirname(privateKeyPath), { recursive: true });
    await writeFile(privateKeyPath, "previous private key\n", { mode: 0o600 });
    fixture.release.restart = false;
    fixture.release.sealedServerEnvIncluded = true;
    fixture.release.sealedServerEnv = { privateKey: "replacement private key\n", privateKeyPath };
    fixture.release.files.push(".sporades/sealed-server-env/server-env.sealed.json");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const registryBefore = await readFile(fixture.registryRecordPath);
    const keyBefore = await readFile(privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle: { routes: { running: { upstream: "attacker.invalid:443" } } },
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule lifecycle authority.", result.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(readFile(docker.caddyLogPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(privateKeyPath), keyBefore);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});

test("sporades host helper descriptor-fences release-supplied Sealed Server env private keys", async () => {
  for (const replacement of ["final", "ancestor"]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: `release-private-key-${replacement}` });
      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      record.status = "stopped";
      await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
      const privateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "server-env.private.pem");
      const stagedPrivateKeyPath = path.join(fixture.capsuleDir, "data", "sealed-server-env", "releases", `${fixture.releaseId}.private.pem`);
      fixture.release.restart = false;
      fixture.release.sealedServerEnvIncluded = true;
      fixture.release.sealedServerEnv = {
        privateKey: "-----BEGIN PRIVATE KEY-----\nrelease-owned fixture\n-----END PRIVATE KEY-----\n",
        privateKeyPath,
      };
      const sealedEnvelope = ".sporades/sealed-server-env/server-env.sealed.json";
      const expanded = path.join(dir, `expanded-${replacement}`);
      await mkdir(expanded);
      const extract = spawnSync("tar", ["-xzf", fixture.archivePath, "-C", expanded], { encoding: "utf8" });
      assert.equal(extract.status, 0, extract.stderr);
      await mkdir(path.dirname(path.join(expanded, sealedEnvelope)), { recursive: true });
      await writeFile(path.join(expanded, sealedEnvelope), '{"version":1,"valueAlgorithm":"aes-256-gcm","entries":{}}\n');
      fixture.release.files.push(sealedEnvelope);
      await rm(fixture.archivePath);
      await createTarGz(fixture.archivePath, expanded, fixture.release.files);
      const outsideDirectory = path.join(dir, "outside-release-private-key");
      const outside = path.join(outsideDirectory, "sentinel.bin");
      await mkdir(outsideDirectory, { mode: 0o711 });
      await writeFile(outside, Buffer.from([2, 7, 1, 8]), { mode: 0o604 });
      const before = await lstat(outside);
      const beforeHash = createHash("sha256").update(await readFile(outside)).digest("hex");
      const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });

      let action;
      if (replacement === "ancestor") {
        await mkdir(path.join(fixture.capsuleDir, "data"), { recursive: true });
        await symlink(outsideDirectory, path.join(fixture.capsuleDir, "data", "sealed-server-env"));
        action = { result: runHostHelper({
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
        }, { cwd: dir, env: docker.env }) };
      } else {
        const marker = path.join(dir, "release-private-key.marker");
        action = startHostHelper({
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
        }, {
          cwd: dir,
          env: {
            ...docker.env,
            SPORADES_TEST_RUNTIME_TREE_PUBLICATION_BOUNDARY: "release-private-key-publish",
            SPORADES_TEST_RUNTIME_TREE_PUBLICATION_MARKER: marker,
            SPORADES_FAKE_RUNTIME_TREE_PUBLICATION_PAUSE_MS: "700",
          },
        });
        await waitForPath(marker);
        await symlink(outside, stagedPrivateKeyPath);
      }

      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", `${replacement}: ${result.stdout}`);
      const after = await lstat(outside);
      assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), beforeHash);
      assert.deepEqual([after.mode & 0o777, after.uid, after.gid], [before.mode & 0o777, before.uid, before.gid]);
      await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
      await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
    });
  }
});

test("sporades host helper leaves the legacy key and running release exact on a no-restart sealed install", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-no-restart", restart: false });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.dev, keyStatAfter.ino, keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.dev, keyStatBefore.ino, keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readFile(fixture.nextPrivateKeyPath, "utf8"), "next private key bytes\n");
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.deepEqual(record.releases.find((release) => release.id === fixture.releaseId).source.sealedServerEnv, {
      publicKeyFingerprint: fixture.nextKeyFingerprint,
      suppliedPrivateKey: true,
    });
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
  });
});

test("sporades host helper restores the exact previous sealed runtime after a new release start fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-start-failure", restart: true });
    const lifecycle = fixture.lifecycle;
    const oldRoute = [
      `team-notes.${fixture.domain} {`,
      "  reverse_proxy 127.0.0.1:49153",
      `  log { output file ${path.join(fixture.capsuleDir, "logs", "http.log")} }`,
      "}",
      "",
    ].join("\n");
    await writeFile(fixture.routeFile, oldRoute);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUN_STATUSES: "1,0", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154" },
    });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
      verification: { enabled: true, fallbackToPreviousRelease: true, healthTimeoutMs: 25 },
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.data.installed, false);
    assert.equal(output.data.rollback.applied, true);
    assert.equal(output.data.verified, false);
    assert.equal(output.data.verification.state, "failed");
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "install-rolled-back");
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    const restoredRoute = await readFile(fixture.routeFile, "utf8");
    assert.match(restoredRoute, /127\.0\.0\.1:49154/);
    assert.doesNotMatch(restoredRoute, /127\.0\.0\.1:49153/);
    assert.match(restoredRoute, /header_up x-sporades-client-address/);
    assert.match(restoredRoute, new RegExp(escapeRegExp(path.join(fixture.capsuleDir, "logs", "http.log"))));
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes("registry.example/next:2"));
    assert(runs[1].args.includes("registry.example/previous:1"));
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});

test("sporades host helper restores an absent route when a stopped prior runtime remains stopped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "stopped-install-rollback", restart: true });
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.status = "stopped";
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    await rm(fixture.routeFile);
    const registryBefore = await readFile(fixture.registryRecordPath);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_RUN_STATUS: "1" },
    });

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle: fixture.lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    await assert.rejects(lstat(fixture.routeFile), { code: "ENOENT" });
    assert.equal((await docker.calls()).filter((call) => call.args[0] === "run").length, 1);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});

test("sporades host helper settles a missing previously-running runtime to stopped after install rollback", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "missing-running-install-rollback", restart: true });
    const staleRoute = [
      `team-notes.${fixture.domain} {`,
      "  reverse_proxy 127.0.0.1:49153",
      `  log { output file ${path.join(fixture.capsuleDir, "logs", "http.log")} }`,
      "}",
      "",
    ].join("\n");
    await writeFile(fixture.routeFile, staleRoute);
    const previousRecord = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));
    const keyBefore = await readFile(fixture.privateKeyPath);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_RUN_STATUS: "1" },
    });

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle: fixture.lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes("registry.example/next:2"));
    assert(!runs[0].args.includes("registry.example/previous:1"));
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });

    const settledRecord = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(settledRecord.status, "stopped");
    assert.deepEqual(settledRecord.baseImage, previousRecord.baseImage);
    assert.deepEqual(settledRecord.currentRelease, previousRecord.currentRelease);
    assert.deepEqual(settledRecord.releases, previousRecord.releases);
    const settledRoute = await readFile(fixture.routeFile, "utf8");
    assert.match(settledRoute, /respond "Hosted Capsule unavailable" 503/);
    assert.doesNotMatch(settledRoute, /127\.0\.0\.1:49153/);
  });
});

test("sporades host helper validates the built upgrade image then restores the registry image after failure", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "built-image-phase-restore", restart: true });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { FAKE_DOCKER_RUN_STATUSES: "1,0" } });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes(lifecycle.container.image));
    assert(runs[1].args.includes("registry.example/previous:1"));
    assert(!runs[1].args.includes(lifecycle.container.image));
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});

test("sporades host helper rolls back a sealed install when release registry settlement fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-registry-failure", restart: false });
    const docker = await installFakeDocker(path.join(dir, "docker"), { env: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } });
    const registryBefore = await readFile(fixture.registryRecordPath);
    const routeBefore = await readFile(fixture.routeFile);
    const keyBefore = await readFile(fixture.privateKeyPath);
    const keyStatBefore = await lstat(fixture.privateKeyPath);
    const pointerBefore = await readlink(path.join(fixture.capsuleDir, "current"));

    const result = await runHostHelper({
      action: "capsule.release.install",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      release: fixture.release,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Failed to write Hosted Capsule registry record.", result.stdout);
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(fixture.routeFile), routeBefore);
    assert.deepEqual(await readFile(fixture.privateKeyPath), keyBefore);
    const keyStatAfter = await lstat(fixture.privateKeyPath);
    assert.deepEqual([keyStatAfter.dev, keyStatAfter.ino, keyStatAfter.mode, keyStatAfter.uid, keyStatAfter.gid], [keyStatBefore.dev, keyStatBefore.ino, keyStatBefore.mode, keyStatBefore.uid, keyStatBefore.gid]);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), pointerBefore);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(lstat(fixture.nextPrivateKeyPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.capsuleDir, "releases", fixture.releaseId)), { code: "ENOENT" });
  });
});

test("sporades host helper starts a no-restart release later with its staged private key and release image", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-later-start", restart: false });
    const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
    fixture.release.baseImage = lifecycle.container.baseImage;
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const target = {
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    };

    const install = await runHostHelper({ action: "capsule.release.install", ...target, release: fixture.release }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(install.stdout).ok, true, install.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });

    const start = await runHostHelper({ action: "capsule.start", ...target }, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
    const [run] = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert(run.args.includes(lifecycle.container.image));
    assert(!run.args.includes("registry.example/previous:1"));
    assert(run.args.includes(`${fixture.nextPrivateKeyPath}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
    assert.equal(await readFile(fixture.privateKeyPath, "utf8"), "previous private key bytes\n");
  });
});

test("sporades host helper keeps the fixed private-key mount for a markerless legacy release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeLegacySealedInstallFixture(dir, { rootName: "sealed-legacy-mount", restart: false });
    const lifecycle = await alignSealedFixtureWithBuiltLifecycle(fixture);
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const start = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
    const [run] = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert(run.args.includes(lifecycle.container.image));
    assert(run.args.includes(`${fixture.privateKeyPath}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
  });
});

test("sporades host helper rejects nested macOS archive metadata entries", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"), "{\"version\":1,\"valueAlgorithm\":\"aes-256-gcm\",\"entries\":{}}\n");
    await writeFile(path.join(runtimeDir, "metadata-server"), "discard me\n");
    await writeFile(path.join(runtimeDir, "metadata-envelope"), "discard me too\n");
    await createTarGzWithTransforms(archivePath, runtimeDir, [
      "|^metadata-server$|._server.mjs|",
      "|^metadata-envelope$|.sporades/sealed-server-env/._server-env.sealed.json|",
    ], [
      "metadata-server",
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "metadata-envelope",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        sealedServerEnv: { currentKeyFingerprint: "0123456789abcdef" },
      })}\n`,
    );
    const keysDir = path.join(capsuleDir, "data", "sealed-server-env", "keys");
    await mkdir(keysDir, { recursive: true });
    await writeFile(path.join(keysDir, "0123456789abcdef.private.pem"), "-----BEGIN PRIVATE KEY-----\nnot-real\n-----END PRIVATE KEY-----\n");

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            publicKeyFingerprint: "0123456789abcdef",
            publicKeyPath: path.join(keysDir, "0123456789abcdef.public.pem"),
          },
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unsupported metadata.",
        hint: "Push again without __MACOSX or AppleDouble metadata entries.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper starts public-key-only sealed releases with the release manifest fingerprint key", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const fingerprint = "0123456789abcdef";
    const currentRegistryFingerprint = "fedcba9876543210";
    await mkdir(path.join(runtimeDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(
      path.join(runtimeDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: fingerprint, entries: {} })}\n`,
    );
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/sealed-server-env/server-env.sealed.json",
    ]);
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(capsuleDir, "data", "sealed-server-env", "keys"), { recursive: true });
    await writeFile(path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`), "host-owned private key\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "registered",
        sealedServerEnv: { currentKeyFingerprint: currentRegistryFingerprint },
      })}\n`,
    );

    const docker = await installFakeDocker(dir);
    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          sealedServerEnvIncluded: true,
          sealedServerEnv: {
            publicKeyFingerprint: fingerprint,
            publicKeyPath: path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.public.pem`),
          },
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
          baseImage: {
            name: "sporades-base",
            image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
            version: "0.1.0-node22-alpine",
            updatePolicy: { mode: "manual" },
          },
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
        lifecycle: buildHostLifecycle(remoteRoot, "capsules.example.dev", "team-notes"),
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.release.sealedServerEnvIncluded, true);
    assert.doesNotMatch(install.stdout, /PRIVATE KEY|host-owned private key/);

    const calls = await docker.calls();
    const runCall = calls.find((call) => call.args[0] === "run");
    assert(runCall);
    const privateKeyMount = `${path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`;
    assert(runCall.args.includes(privateKeyMount));
    assert(!runCall.args.includes(`${path.join(capsuleDir, "data", "sealed-server-env", "server-env.private.pem")}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".sporades", "sealed-server-env", "server-env.sealed.json")}:/app/.sporades/sealed-server-env/server-env.sealed.json:ro`));
    assert(runCall.args.includes("SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH=/app/.sporades/sealed-server-env/server-env.private.pem"));
    assert(runCall.args.includes("SPORADES_SEALED_SERVER_ENV_PATH=/app/.sporades/sealed-server-env/server-env.sealed.json"));

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, currentRegistryFingerprint);
    assert.equal(record.releases[0].source.sealedServerEnvIncluded, true);
    assert.deepEqual(record.releases[0].source.sealedServerEnv, { publicKeyFingerprint: fingerprint });
  });
});

test("sporades host helper rejects sealed release start when the manifest fingerprint key is missing", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const currentReleaseId = "20260630T221500Z-feedface";
    const fingerprint = "0123456789abcdef";
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const releaseDir = path.join(capsuleDir, "releases", currentReleaseId);
    await mkdir(path.join(releaseDir, ".sporades", "sealed-server-env"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client bundle');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div id=\"root\"></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(
      path.join(releaseDir, ".sporades", "sealed-server-env", "server-env.sealed.json"),
      `${JSON.stringify({ version: 1, valueAlgorithm: "aes-256-gcm", publicKeyFingerprint: fingerprint, entries: {} })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "released",
        currentRelease: { id: currentReleaseId },
        sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
        releases: [
          {
            id: currentReleaseId,
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "uploaded",
            current: true,
            source: {
              hostedUrl: "https://team-notes.capsules.example.dev",
              files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: fingerprint },
            },
          },
        ],
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: { remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    const output = JSON.parse(start.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule Sealed Server env private key is missing.");
    assert.match(output.error.hint, /re-key/);
    assert.match(output.error.hint, /re-seal/);
    assert.deepEqual(output.error.diagnostics, {
      capsule: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      },
      sealedServerEnv: {
        expectedPublicKeyFingerprint: fingerprint,
        privateKeyPath: path.join(capsuleDir, "data", "sealed-server-env", "keys", `${fingerprint}.private.pem`),
        recovery: "re-key-and-re-seal-from-source-of-truth",
      },
    });
    assert.doesNotMatch(start.stdout, /PRIVATE KEY|host-owned private key|swordfish/);
    assert.equal((await docker.calls()).some((call) => call.args[0] === "run"), false);
  });
});

test("sporades host helper reports remediation when data ownership cannot be prepared", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can chown test data to the runtime UID");
    return;
  }
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const archivePath = path.join(remoteRoot, "incoming", "20260630T221500Z-feedface.tar.gz");
    const runtimeDir = path.join(dir, "runtime-files");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: { SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "0", SPORADES_TEST_FORCE_RUNTIME_DATA_CHOWN_FAILURE: "1" } },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Unable to prepare Hosted Capsule data ownership for the non-root runtime user.");
    assert.match(output.error.hint, /sudo chown -R 10001:10001/);
  });
});

test("sporades host helper marks previous releases non-current and records start attempts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "uploaded",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
        ],
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260629T120000Z-deadbeef", state: "uploaded", current: false },
        { id: "20260630T221500Z-feedface", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
    assert.match(record.releases[1].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("sporades host helper starts the current release in Docker and routes through a loopback-published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await writeFile(path.join(releaseDir, ".env.sporades.server"), "SECRET_TOKEN=swordfish\n");
    const dataDir = path.join(capsuleDir, "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, "uploads"), 0o755);
    await chmod(path.join(dataDir, "data.db"), 0o644);
    await chmod(path.join(dataDir, "uploads", "file.bin"), 0o644);
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        currentRelease: { id: "20260630T221500Z-feedface" },
        baseImage: {
          updatePolicy: { mode: "manual" },
        },
      })}\n`,
    );
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir);

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          currentLink: path.join(capsuleDir, "current"),
          directories: { capsule: capsuleDir, releases: path.join(capsuleDir, "releases"), data: path.join(capsuleDir, "data") },
          mounts: {
            files: [
              { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
              { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
              { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
              { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
              { host: path.join(capsuleDir, "current", ".env.sporades.server"), container: "/app/.env.sporades.server", mode: "ro", optional: true },
            ],
            data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
          },
          container: {
            name: "sporades-capsules-example-dev-team-notes",
            labels: {
              "com.sporades.managed": "true",
              "com.sporades.hosted-domain": "capsules.example.dev",
              "com.sporades.capsule-subname": "team-notes",
              "com.sporades.capsule-id": "capsules.example.dev/team-notes",
              "com.sporades.base-image.update-policy": "manual",
            },
          },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
            },
            unavailable: {
              hostname: "team-notes.capsules.example.dev",
              target: "hosted-capsule-unavailable",
              statusCode: 503,
              routeFile,
            },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(start.code, 0, start.stderr);
    const output = JSON.parse(start.stdout);
    assert.equal(output.ok, true, start.stdout);
    assert.equal(output.data.started, true);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.equal(output.data.container.publishedPort.hostIp, "127.0.0.1");
    assert.equal(output.data.container.publishedPort.hostPort, 49153);
    assert.deepEqual(output.data.restartPolicy, {
      mode: "bounded",
      maxAttempts: 3,
      backoffMs: 1000,
      dockerRestart: "on-failure:3",
      restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
      exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
      exhaustedRouteTarget: "hosted-capsule-unavailable",
      verificationFallbackOnly: true,
    });
    assert.equal(output.data.route.target, "loopback");
    assert.equal(output.data.route.upstream, "127.0.0.1:49153");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["stop", "rm", "image", "run", "inspect", "inspect"]);
    assert.deepEqual(calls[2].args, ["image", "inspect", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"]);
    const runCall = calls.find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-capsules-example-dev-team-notes");
    assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-hosted-capsules");
    assert.equal(runCall.args[runCall.args.indexOf("--restart") + 1], "on-failure:3");
    assert(runCall.args.includes("--read-only"));
    assert.equal(runCall.args[runCall.args.indexOf("--tmpfs") + 1], "/tmp:rw,nosuid,nodev,noexec");
    assert.equal(runCall.args[runCall.args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(runCall.args[runCall.args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], "10001:10001");
    assert.equal(runCall.args[runCall.args.indexOf("--log-driver") + 1], "json-file");
    assert(runCall.args.includes("max-size=10m"));
    assert(runCall.args.includes("max-file=5"));
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert(runCall.args.includes("--label"));
    assert(runCall.args.includes("com.sporades.release-id=20260630T221500Z-feedface"));
    assert(runCall.args.includes("com.sporades.base-image.name=sporades-base"));
    assert(runCall.args.includes("com.sporades.base-image.version=0.1.0-node22-alpine"));
    assert(runCall.args.includes("com.sporades.base-image.update-policy=manual"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`));
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".env.sporades.server")}:/app/.env.sporades.server:ro`));
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(capsuleDir, "current", ".env.sporades.server"));
    assert(runCall.args.includes(`${path.join(capsuleDir, "data")}:/app/data:rw`));
    assert(runCall.args.includes("SPORADES_LOG_STDOUT=1"));
    assert(runCall.args.includes("SPORADES_SECURITY_SESSION=hosted"));
    assert(runCall.args.includes("SPORADES_PUBLIC_ORIGIN=https://team-notes.capsules.example.dev"));
    assert(runCall.args.includes("SPORADES_RELEASE_ID=20260630T221500Z-feedface"));
    assert.deepEqual(runCall.args.slice(runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.1.0-node22-alpine")), [
      "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      "node",
      "/app/server.mjs",
    ]);
    const portInspectCall = calls.find((call) => call.args.join(" ").includes("NetworkSettings.Ports"));
    assert(portInspectCall, "expected Docker port inspection after container start");
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_size 10MiB/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /header x-sporades-host-probe [a-f0-9]{64}/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /reverse_proxy 127\.0\.0\.1:49153/);
    assert.match(routeContents, /header_up x-sporades-client-address \{http\.request\.remote\.host\}/);
    assert.doesNotMatch(routeContents, /CF-Connecting-IP|sporadesUntrustedCloudflareSource/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.runtimeProbe.header, "x-sporades-host-probe");
    assert.match(record.runtimeProbe.token, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(output).includes(record.runtimeProbe.token), false);
    assert.equal(JSON.stringify(output).includes("SECRET_TOKEN"), false);
    const preparedDataDir = await stat(dataDir);
    const preparedUploadsDir = await stat(path.join(dataDir, "uploads"));
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    const preparedUpload = await stat(path.join(dataDir, "uploads", "file.bin"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedUploadsDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedUpload.mode & 0o777, 0o600);
    if (process.getuid?.() === 0) {
      assert.equal(preparedDataDir.uid, 10001);
      assert.equal(preparedDataDir.gid, 10001);
      assert.equal(preparedDatabase.uid, 10001);
      assert.equal(preparedDatabase.gid, 10001);
    }
  });
});

test("sporades host helper checks Hosted Capsule runtime health with a Host-owned probe credential", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );

      const health = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(health.code, 0, health.stderr);
      assert.deepEqual(JSON.parse(health.stdout), {
        ok: true,
        data: {
          capsule: {
            subname: "team-notes",
            domain,
            hostedUrl,
            remoteCapsuleId: `${domain}/team-notes`,
            registered: true,
          },
          release: { id: "20260630T221500Z-feedface", current: true },
          container: { name: "sporades-capsules-example-dev-team-notes", running: true },
          route: {
            url: `${hostedUrl}/__sporades/health/runtime`,
            responding: true,
          },
          runtime: {
            ready: true,
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
        },
        error: null,
      });
      assert.equal(health.stdout.includes("probe-secret"), false);
    });
  });
});

test("sporades host helper refreshes a stale loopback route after Docker restarts on a new published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
      },
    });

    await withHttpServer((request, response) => {
      assert.equal(request.url, "/__sporades/health/runtime");
      assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: { ready: true },
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } },
        },
        error: null,
      }));
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(
        routeFile,
        [
          `team-notes.${domain} {`,
          "  @sporadesRuntimeProbe {",
          "    path /__sporades/health/runtime",
          "    header x-sporades-host-probe probe-secret",
          "  }",
          "  handle @sporadesRuntimeProbe {",
          "    reverse_proxy 127.0.0.1:49153 {",
          "      header_up x-sporades-client-address {http.request.remote.host}",
          "    }",
          "  }",
          "  reverse_proxy 127.0.0.1:49153 {",
          "    header_up x-sporades-client-address {http.request.remote.host}",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );

      const health = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(health.code, 0, health.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true);
      const route = await readFile(routeFile, "utf8");
      assert.equal((route.match(/reverse_proxy 127\.0\.0\.1:49154/g) ?? []).length, 2);
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      assert.match(route, /header x-sporades-host-probe probe-secret/);
      assert.deepEqual(
        (await docker.caddyCalls()).map((call) => call.args),
        [
          ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
          ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ],
      );

      const repeatedHealth = await runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme: "http", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir, env: docker.env },
      );
      assert.equal(repeatedHealth.code, 0, repeatedHealth.stderr);
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, true);
      assert.equal((await docker.caddyCalls()).length, 2, "a current route must not reload Caddy on every health check");
    });
  });
});

test("sporades host helper serializes two stale health route repairs across helper processes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
        FAKE_DOCKER_CADDY_DELAY_MS: "100",
      },
    });

    await withHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: { ready: true },
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } },
        },
        error: null,
      }));
    }, async (port) => {
      const domain = `localhost:${port}`;
      const hostedUrl = `http://team-notes.localhost:${port}`;
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(
        routeFile,
        `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`,
      );
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );
      const request = {
        action: "capsule.health",
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      await writeFile(
        `${routeFile}.lock`,
        `${JSON.stringify({
          token: "d".repeat(32),
          pid: 999999,
          processIdentity: "dead-route-owner",
          createdAt: Date.now() - 60_000,
        })}\n`,
      );
      const deadReclaimGuard = `${routeFile}.lock.reclaim-${"a".repeat(32)}`;
      await writeFile(
        deadReclaimGuard,
        `${JSON.stringify({
          token: "a".repeat(32),
          pid: 999999,
          processIdentity: "dead-reclaim-guard",
          createdAt: Date.now() - 60_000,
        })}\n`,
      );

      const results = await Promise.all([
        runHostHelper(request, { cwd: dir, env: docker.env }),
        runHostHelper(request, { cwd: dir, env: docker.env }),
      ]);

      for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
      }
      const route = await readFile(routeFile, "utf8");
      assert.equal((route.match(/reverse_proxy 127\.0\.0\.1:49154/g) ?? []).length, 1);
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      assert.deepEqual(
        (await docker.caddyCalls()).map((call) => call.args),
        [
          ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
          ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ],
        "the second helper must re-read the winner and avoid another Caddy reload",
      );
      const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
      assert.deepEqual(debris, []);
    });
  });
});

test("sporades host helper serializes stale health repair against route removal", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
        FAKE_DOCKER_CADDY_DELAY_MS: "100",
      },
    });

    await withHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: { ready: true },
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } },
        },
        error: null,
      }));
    }, async (port) => {
      const domain = `localhost:${port}`;
      const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", "team-notes");
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
      await mkdir(path.join(capsuleDir, "data"), { recursive: true });
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`);
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `http://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );
      const healthRequest = {
        action: "capsule.health",
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      const healthPromise = runHostHelper(healthRequest, { cwd: dir, env: docker.env });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const unregisterPromise = runHostHelper(
        {
          action: "capsule.unregister",
          host: { alias: "personal", domain, scheme: "https", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir, env: docker.env },
      );

      const [health, unregister] = await Promise.all([healthPromise, unregisterPromise]);
      assert.equal(health.code, 0, health.stderr);
      assert.equal(unregister.code, 0, unregister.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true, health.stdout);
      assert.equal(JSON.parse(unregister.stdout).ok, true, unregister.stdout);
      await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "unregistered");
      const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
      assert.deepEqual(debris, []);
      const reloadsBeforeRepeat = (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length;
      const repeatedHealth = await runHostHelper(healthRequest, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, false);
      assert.equal(
        (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length,
        reloadsBeforeRepeat,
        "an unregistered route must not enter a health-triggered reload loop",
      );
    });
  });
});

test("sporades host helper serializes stale health repair against a concurrent start", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49154",
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({ State: { Running: true }, RestartCount: 1 })}\n`,
        FAKE_DOCKER_CADDY_DELAY_MS: "100",
      },
    });

    await withHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: {
          runtime: { ready: true },
          checks: { sqlite: { ok: true }, fileStorage: { ok: true } },
        },
        error: null,
      }));
    }, async (port) => {
      const domain = `localhost:${port}`;
      const capsuleDir = path.join(remoteRoot, "hosts", domain, "capsules", "team-notes");
      const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
      const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
      const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
      await mkdir(releaseDir, { recursive: true });
      await mkdir(path.join(capsuleDir, "data"), { recursive: true });
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await mkdir(path.dirname(routeFile), { recursive: true });
      await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
      await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
      await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
      await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
      await symlink(releaseDir, path.join(capsuleDir, "current"));
      await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
      await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`);
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `http://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          releases: [{ id: "20260630T221500Z-feedface", state: "started", current: true, startAttempts: [] }],
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
        })}\n`,
      );
      const baseRequest = {
        host: { alias: "personal", domain, scheme: "http", remoteRoot },
        capsule: { subname: "team-notes" },
      };
      const healthPromise = runHostHelper({ ...baseRequest, action: "capsule.health" }, { cwd: dir, env: docker.env });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const startPromise = runHostHelper({ ...baseRequest, action: "capsule.start" }, { cwd: dir, env: docker.env });

      const [health, start] = await Promise.all([healthPromise, startPromise]);
      assert.equal(health.code, 0, health.stderr);
      assert.equal(start.code, 0, start.stderr);
      assert.equal(JSON.parse(health.stdout).ok, true, health.stdout);
      assert.equal(JSON.parse(start.stdout).ok, true, start.stdout);
      const route = await readFile(routeFile, "utf8");
      assert.match(route, /reverse_proxy 127\.0\.0\.1:49154/);
      assert.doesNotMatch(route, /127\.0\.0\.1:49153/);
      const debris = (await readdir(path.dirname(routeFile))).filter((entry) => entry !== path.basename(routeFile) && entry !== `${path.basename(routeFile)}.lock`);
      assert.deepEqual(debris, []);
      const reloadsBeforeRepeat = (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length;
      const repeatedHealth = await runHostHelper({ ...baseRequest, action: "capsule.health" }, { cwd: dir, env: docker.env });
      assert.equal(JSON.parse(repeatedHealth.stdout).ok, true, repeatedHealth.stdout);
      assert.equal(
        (await docker.caddyCalls()).filter((call) => call.args[0] === "reload").length,
        reloadsBeforeRepeat,
        "the current start route must not enter a health-triggered reload loop",
      );
    });
  });
});

async function prepareRouteLockFixture(dir, dockerOptions = {}) {
  const remoteRoot = path.join(dir, "remote-root");
  const domain = "capsules.example.dev";
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
  const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  await mkdir(path.dirname(routeFile), { recursive: true });
  await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
  await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153 {\n  }\n}\n`);
  await writeFile(
    registryRecordPath,
    `${JSON.stringify({ subname: "team-notes", domain, status: "running" })}\n`,
  );
  const docker = await installFakeDocker(dir, dockerOptions);
  const request = {
    action: "capsule.stop",
    host: { alias: "personal", domain, scheme: "https", remoteRoot },
    capsule: { subname: "team-notes" },
    lifecycle: {
      routes: {
        unavailable: {
          hostname: `team-notes.${domain}`,
          target: "hosted-capsule-unavailable",
          statusCode: 503,
          routeFile,
        },
      },
    },
  };
  return { docker, request, routeFile, lockDir: `${routeFile}.lock` };
}

async function prepareUnregisterRouteFixture(dir, dockerOptions = {}) {
  const remoteRoot = path.join(dir, "remote-root");
  const domain = "capsules.example.dev";
  const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
  const routeFile = path.join(remoteRoot, "caddy", "hosts", domain, "team-notes.caddy");
  await mkdir(path.dirname(registryRecordPath), { recursive: true });
  await mkdir(path.dirname(routeFile), { recursive: true });
  await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
  await writeFile(routeFile, `team-notes.${domain} {\n  reverse_proxy 127.0.0.1:49153\n}\n`);
  await writeFile(registryRecordPath, `${JSON.stringify({
    subname: "team-notes",
    domain,
    remoteCapsuleId: `${domain}/team-notes`,
    hostedUrl: `https://team-notes.${domain}`,
    status: "running",
    currentRelease: { id: "20260630T221500Z-feedface" },
  })}\n`);
  const docker = await installFakeDocker(dir, dockerOptions);
  return {
    docker,
    routeFile,
    request: {
      action: "capsule.unregister",
      host: { alias: "personal", domain, scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    },
  };
}

test("sporades host helper automatically releases the OS route lock after its owner is killed", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const holder = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recoveredDocker = await installFakeDocker(path.join(dir, "recovered"));
    const recovered = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...recoveredDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "500" },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true, "the inert lock file may persist while its OS lock is released");
  });
});

test("sporades host helper cannot continue route mutation after its lock-holding action process is killed", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "600" },
    });
    const staleRequest = structuredClone(fixture.request);
    const winnerRequest = structuredClone(fixture.request);
    const stale = startHostHelper(staleRequest, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lockHolderPid = await waitForChildPid(stale.child.pid);
    process.kill(lockHolderPid, "SIGKILL");

    const winnerDocker = await installFakeDocker(path.join(dir, "winner"));
    const winner = await runHostHelper(winnerRequest, { cwd: dir, env: winnerDocker.env });
    const staleResult = await stale.result;
    assert.equal(JSON.parse(winner.stdout).ok, true, winner.stdout);
    assert.equal(JSON.parse(staleResult.stdout).ok, false, staleResult.stdout);
    const route = await readFile(fixture.routeFile, "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host helper ignores stale lock-file contents because ownership is kernel-scoped", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    await writeFile(
      fixture.lockDir,
      `${JSON.stringify({
        token: "b".repeat(32),
        pid: process.pid,
        processIdentity: "stale-process-from-an-earlier-boot",
        createdAt: Date.now() - 60_000,
      })}\n`,
    );

    const recovered = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "500" },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
  });
});

test("sporades host helper does not steal a live route owner and rejects malformed lock bounds", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const holder = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const contenderDocker = await installFakeDocker(path.join(dir, "contender"));
    const startedAt = Date.now();
    const contender = await runHostHelper(fixture.request, {
      cwd: dir,
      env: { ...contenderDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "100" },
    });
    assert.equal(JSON.parse(contender.stdout).error.message, "Hosted Capsule route is locked.");
    assert.ok(Date.now() - startedAt < 1000, "a live-owner timeout must remain bounded");

    for (const invalidTimeout of ["NaN", "Infinity", "0", "-1", "1.5", "60001"]) {
      const invalid = await runHostHelper(fixture.request, {
        cwd: dir,
        env: { ...contenderDocker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: invalidTimeout },
      });
      assert.equal(JSON.parse(invalid.stdout).error.message, "Invalid Hosted Capsule route lock timeout.");
    }
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;
  });
});

test("sporades host helper releases the OS route lock to one waiting successor", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "300" },
    });
    const predecessor = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const successor = runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });

    const [predecessorResult, successorResult] = await Promise.all([predecessor.result, successor]);
    assert.equal(JSON.parse(predecessorResult.stdout).ok, true, predecessorResult.stdout);
    assert.equal(JSON.parse(successorResult.stdout).ok, true, successorResult.stdout);
    assert.equal((await stat(fixture.lockDir)).isFile(), true);
  });
});

test("sporades host helper keeps read-only Capsule inspection available during a route mutation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "800" },
    });
    const mutation = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(fixture.lockDir);
    const read = startHostHelper({
      action: "capsule.release.list",
      host: fixture.request.host,
      capsule: fixture.request.capsule,
    }, { cwd: dir, env: { ...fixture.docker.env, SPORADES_ROUTE_LOCK_TIMEOUT_MS: "2000" } });
    const readResult = await Promise.race([
      read.result,
      new Promise((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    assert.notEqual(readResult, null, "read-only inspection must not wait behind route mutation");
    assert.doesNotMatch(JSON.parse(readResult.stdout).error?.message ?? "", /route is locked/i);
    assert.equal((await Promise.race([mutation.result.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10))])), false);
    assert.equal(JSON.parse((await mutation.result).stdout).ok, true);
  });
});

test("sporades host helper preserves malformed-action validation without entering a route lock", async () => {
  await withTempDir(async (dir) => {
    const result = await runHostHelper({ action: "unsupported.review-proof" }, { cwd: dir });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Unsupported Host helper action.");
    assert.doesNotMatch(output.error.message, /lock/i);
  });
});

test("sporades host helper rejects a lifecycle route that does not match the canonical Capsule lock identity", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const canonicalRoute = fixture.routeFile;
    const foreignRoute = path.join(path.dirname(canonicalRoute), "other-capsule.caddy");
    await writeFile(foreignRoute, "other-capsule.capsules.example.dev {\n  respond 418\n}\n");
    const mismatched = structuredClone(fixture.request);
    mismatched.lifecycle.routes.unavailable.routeFile = foreignRoute;
    const result = await runHostHelper(mismatched, { cwd: dir, env: fixture.docker.env });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.error.message, "Invalid Hosted Capsule lifecycle authority.");
    assert.equal(await readFile(foreignRoute, "utf8"), "other-capsule.capsules.example.dev {\n  respond 418\n}\n");
    assert.match(await readFile(canonicalRoute, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});

test("sporades host helper rejects a forged canonical route-lock marker without the retained OS lock descriptor", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const result = await runHostHelper(fixture.request, {
      cwd: dir,
      env: {
        ...fixture.docker.env,
        SPORADES_HOST_ROUTE_LOCK_FILE: `${fixture.routeFile}.lock`,
      },
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false, result.stdout);
    assert.equal(output.error.message, "Hosted Capsule route lock identity was not retained by the action process.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});

test("sporades host helper rejects an unlocked matching descriptor forged for the canonical route lock", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const lockFile = `${fixture.routeFile}.lock`;
    const attacker = await startExecutable(
      path.join(repoRoot, "test", "support", "exec-flock.py"),
      ["--exclusive", "--timeout", "1", "--conflict-exit-code", "75", "--no-fork", lockFile, process.execPath, hostHelperPath],
      {
        cwd: dir,
        input: `${JSON.stringify(fixture.request)}\n`,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
          SPORADES_TEST_OPEN_WITHOUT_FLOCK: "1",
          SPORADES_HOST_ROUTE_LOCK_FILE: lockFile,
        },
      },
    ).result;
    const output = JSON.parse(attacker.stdout);
    assert.equal(output.ok, false, attacker.stdout);
    assert.equal(output.error.message, "Hosted Capsule route lock identity was not retained by the action process.");
    assert.match(await readFile(fixture.routeFile, "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});

test("sporades host helper rejects traversal and Caddy-injection route identities before filesystem mutation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const cases = [
      { field: "remoteRoot", value: "relative/root" },
      { field: "remoteRoot", value: `${fixture.request.host.remoteRoot}/../escaped-root` },
      { field: "domain", value: "../escaped.example" },
      { field: "domain", value: "capsules.example.dev\nmalicious.example { respond 200 }" },
      { field: "domain", value: "capsules.example.dev:0" },
      { field: "domain", value: "capsules.example.dev:65536" },
      { field: "subname", value: "../other-capsule" },
      { field: "subname", value: "team-notes\nrespond 200" },
    ];
    for (const attack of cases) {
      const request = structuredClone(fixture.request);
      request.lifecycle = {};
      if (attack.field === "subname") request.capsule.subname = attack.value;
      else request.host[attack.field] = attack.value;
      const result = await runHostHelper(request, { cwd: dir, env: fixture.docker.env });
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false, `${attack.field}=${JSON.stringify(attack.value)}: ${result.stdout}`);
      assert.equal(output.error.message, "Invalid Hosted Capsule route identity.");
    }
    assert.deepEqual((await readdir(path.dirname(fixture.routeFile))).sort(), ["team-notes.caddy"]);
  });
});

test("sporades host helper rejects symlinks throughout the trusted route ancestor chain", async () => {
  await withTempDir(async (dir) => {
    const attacks = ["remoteRoot", "caddy", "hosts", "domain"];
    for (const attack of attacks) {
      const caseRoot = path.join(dir, attack);
      const realRoot = path.join(caseRoot, "real-root");
      const remoteRoot = path.join(caseRoot, "remote-root");
      const outside = path.join(caseRoot, "outside");
      await mkdir(realRoot, { recursive: true, mode: 0o700 });
      await mkdir(outside, { recursive: true, mode: 0o700 });
      if (attack === "remoteRoot") {
        await symlink(realRoot, remoteRoot, "dir");
      } else {
        await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
        const caddy = path.join(remoteRoot, "caddy");
        if (attack === "caddy") await symlink(outside, caddy, "dir");
        else {
          await mkdir(caddy, { mode: 0o755 });
          const hosts = path.join(caddy, "hosts");
          if (attack === "hosts") await symlink(outside, hosts, "dir");
          else {
            await mkdir(hosts, { mode: 0o755 });
            await symlink(outside, path.join(hosts, "capsules.example.dev"), "dir");
          }
        }
      }
      const result = await runHostHelper({
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {},
      }, { cwd: dir });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${attack}: ${result.stdout}`);
      assert.deepEqual(await readdir(outside), [], attack);
    }
  });
});

test("sporades host helper authenticates the complete route chain from the filesystem anchor", async () => {
  await withTempDir(async (dir) => {
    const unsafeParent = path.join(dir, "unsafe-parent");
    const unsafeRoot = path.join(unsafeParent, "remote-root");
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);
    const unsafe = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: unsafeRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(unsafe.stdout).error.message, "Hosted Capsule route trust validation failed.", unsafe.stdout);
    await assert.rejects(stat(unsafeRoot), { code: "ENOENT" });

    const stickyRoot = path.join(dir, "sticky-ancestor-accepted", "remote-root");
    const sticky = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: stickyRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(sticky.stdout).error.message, "Hosted Capsule is not registered.", sticky.stdout);
    assert.equal((await lstat(stickyRoot)).isDirectory(), true, "the root-owned sticky system temp ancestor is admitted");
  });
});

test("sporades host helper rejects a symlink above remoteRoot without resolving away its lexical parent", async () => {
  await withTempDir(async (dir) => {
    const attackerParent = path.join(dir, "attacker-parent");
    const trustedTarget = path.join(dir, "trusted-target");
    const outside = path.join(trustedTarget, "outside.bin");
    await mkdir(attackerParent, { mode: 0o700 });
    await mkdir(trustedTarget, { mode: 0o700 });
    await writeFile(outside, Buffer.from([3, 1, 4, 1, 5, 9]));
    const before = createHash("sha256").update(await readFile(outside)).digest("hex");
    await symlink(trustedTarget, path.join(attackerParent, "link"), "dir");
    const remoteRoot = path.join(attackerParent, "link", "sporades");
    const result = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.equal(createHash("sha256").update(await readFile(outside)).digest("hex"), before);
    await assert.rejects(lstat(path.join(trustedTarget, "sporades")), { code: "ENOENT" });
  });
});

test("sporades host helper fences an ancestor swap after route lock acquisition", async () => {
  await withTempDir(async (dir) => {
    const proofMarker = path.join(dir, "route-lock-proof.marker");
    const fixture = await prepareRouteLockFixture(dir, {
      env: {
        SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "700",
        SPORADES_TEST_ROUTE_LOCK_PROOF_MARKER: proofMarker,
      },
    });
    const domainDirectory = path.dirname(fixture.routeFile);
    const preservedDirectory = `${domainDirectory}.preserved`;
    const outside = path.join(dir, "outside-route-target");
    await mkdir(outside, { mode: 0o700 });
    const action = startHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    await waitForPath(proofMarker);
    await rename(domainDirectory, preservedDirectory);
    await symlink(outside, domainDirectory, "dir");
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
    assert.deepEqual(await readdir(outside), []);
    assert.match(await readFile(path.join(preservedDirectory, "team-notes.caddy"), "utf8"), /reverse_proxy 127\.0\.0\.1:49153/);
  });
});

test("sporades host helper revalidates trust immediately before apply and rollback route mutations", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      { boundary: "apply-remove-temp", dockerEnv: {} },
      { boundary: "apply-remove-previous", dockerEnv: {} },
      { boundary: "apply-write-temp", dockerEnv: {} },
      { boundary: "apply-validation-cleanup", dockerEnv: { FAKE_DOCKER_CADDY_VALIDATE_STATUS: "1" } },
      { boundary: "apply-move-current", dockerEnv: {} },
      { boundary: "apply-publish-temp", dockerEnv: {} },
      { boundary: "apply-rollback-remove-temp", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-rollback-remove-current", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-rollback-restore", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "apply-finalize-previous", dockerEnv: {} },
    ];
    for (const scenario of cases) {
      const boundary = scenario.boundary;
      const caseRoot = path.join(dir, boundary);
      await mkdir(caseRoot, { recursive: true });
      const marker = path.join(caseRoot, "boundary.marker");
      const fixture = await prepareRouteLockFixture(caseRoot, { env: scenario.dockerEnv });
      const domainDirectory = path.dirname(fixture.routeFile);
      const preservedDirectory = `${domainDirectory}.preserved`;
      const outside = path.join(caseRoot, "outside");
      await mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel.bin");
      await writeFile(sentinel, Buffer.from([0, 1, 2, 253, 254, 255]));
      const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
      const action = startHostHelper(fixture.request, {
        cwd: caseRoot,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: boundary,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS: "700",
        },
      });
      await waitForPath(marker);
      await rename(domainDirectory, preservedDirectory);
      await symlink(outside, domainDirectory, "dir");
      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${boundary}: ${result.stdout}`);
      assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, boundary);
      assert.deepEqual(await readdir(outside), ["sentinel.bin"], boundary);
      const preservedEntries = await readdir(preservedDirectory);
      const originalEntry = preservedEntries.find((entry) => entry.startsWith("team-notes.caddy.previous-"))
        ?? preservedEntries.find((entry) => entry === "team-notes.caddy");
      assert.ok(originalEntry, `${boundary}: original route bytes must remain in the fenced directory`);
      assert.match(await readFile(path.join(preservedDirectory, originalEntry), "utf8"), /127\.0\.0\.1:49153/, boundary);
    }
  });
});

test("sporades host helper revalidates trust immediately before remove and restore route mutations", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      { boundary: "remove-remove-previous", dockerEnv: {} },
      { boundary: "remove-move-current", dockerEnv: {} },
      { boundary: "remove-rollback-restore", dockerEnv: { FAKE_DOCKER_CADDY_RELOAD_STATUS: "1" } },
      { boundary: "remove-finalize-previous", dockerEnv: {} },
      { boundary: "restore-remove-current", dockerEnv: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
      { boundary: "restore-publish-previous", dockerEnv: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
    ];
    for (const scenario of cases) {
      const caseRoot = path.join(dir, scenario.boundary);
      await mkdir(caseRoot, { recursive: true });
      const marker = path.join(caseRoot, "boundary.marker");
      const fixture = await prepareUnregisterRouteFixture(caseRoot, { env: scenario.dockerEnv });
      const domainDirectory = path.dirname(fixture.routeFile);
      const preservedDirectory = `${domainDirectory}.preserved`;
      const outside = path.join(caseRoot, "outside");
      await mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel.bin");
      await writeFile(sentinel, Buffer.from([4, 8, 15, 16, 23, 42]));
      const before = createHash("sha256").update(await readFile(sentinel)).digest("hex");
      const action = startHostHelper(fixture.request, {
        cwd: caseRoot,
        env: {
          ...fixture.docker.env,
          SPORADES_TEST_ROUTE_MUTATION_BOUNDARY: scenario.boundary,
          SPORADES_TEST_ROUTE_MUTATION_MARKER: marker,
          SPORADES_FAKE_ROUTE_MUTATION_PAUSE_MS: "700",
        },
      });
      await waitForPath(marker);
      await rename(domainDirectory, preservedDirectory);
      await symlink(outside, domainDirectory, "dir");
      const result = await action.result;
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", `${scenario.boundary}: ${result.stdout}`);
      assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), before, scenario.boundary);
      assert.deepEqual(await readdir(outside), ["sentinel.bin"], scenario.boundary);
      const preservedEntries = await readdir(preservedDirectory);
      const originalEntry = preservedEntries.find((entry) => entry.startsWith("team-notes.caddy.previous-"))
        ?? preservedEntries.find((entry) => entry === "team-notes.caddy");
      assert.ok(originalEntry, `${scenario.boundary}: original route bytes must remain in the fenced directory`);
      assert.match(await readFile(path.join(preservedDirectory, originalEntry), "utf8"), /127\.0\.0\.1:49153/, scenario.boundary);
    }
  });
});

test("sporades host helper rejects symlink route entries and unsafe writable route ancestry", async () => {
  await withTempDir(async (dir) => {
    for (const finalEntry of ["route", "lock"]) {
      const caseRoot = path.join(dir, finalEntry);
      const remoteRoot = path.join(caseRoot, "remote-root");
      const domainDirectory = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev");
      const routeFile = path.join(domainDirectory, "team-notes.caddy");
      const outside = path.join(caseRoot, "outside.txt");
      await mkdir(domainDirectory, { recursive: true, mode: 0o755 });
      await writeFile(outside, "outside-preserved\n", { mode: 0o600 });
      await symlink(outside, finalEntry === "route" ? routeFile : `${routeFile}.lock`);
      const result = await runHostHelper({
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {},
      }, { cwd: caseRoot });
      assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule route trust validation failed.", result.stdout);
      assert.equal(await readFile(outside, "utf8"), "outside-preserved\n");
    }

    const unsafeRoot = path.join(dir, "unsafe", "remote-root");
    const unsafeCaddy = path.join(unsafeRoot, "caddy");
    await mkdir(unsafeCaddy, { recursive: true, mode: 0o755 });
    await chmod(unsafeCaddy, 0o777);
    const unsafe = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: unsafeRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(unsafe.stdout).error.message, "Hosted Capsule route trust validation failed.", unsafe.stdout);

    const createdRoot = path.join(dir, "created", "remote-root");
    await mkdir(createdRoot, { recursive: true, mode: 0o700 });
    const created = await runHostHelper({
      action: "capsule.stop",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: createdRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, { cwd: dir });
    assert.equal(JSON.parse(created.stdout).error.message, "Hosted Capsule is not registered.", created.stdout);
    for (const createdDirectory of [
      path.join(createdRoot, "bin"),
      path.join(createdRoot, "caddy"),
      path.join(createdRoot, "caddy", "hosts"),
      path.join(createdRoot, "caddy", "hosts", "capsules.example.dev"),
    ]) {
      assert.equal((await stat(createdDirectory)).mode & 0o022, 0, createdDirectory);
    }
  });
});

test("Host bootstrap and Capsule route mutations share a global lock without deadlock", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir, {
      env: { SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "1000" },
    });
    const caddyUser = await installFakeCaddyUserCommands(path.join(dir, "caddy-user"));
    const env = {
      ...fixture.docker.env,
      ...caddyUser.env,
      PATH: `${caddyUser.fakeBinDir}${path.delimiter}${fixture.docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const mutation = startHostHelper(fixture.request, { cwd: dir, env });
    await waitForPath(fixture.lockDir);
    const bootstrap = startHostHelper({
      action: "host.bootstrap",
      host: fixture.request.host,
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, { cwd: dir, env });
    let bootstrapSettled = false;
    bootstrap.result.then(() => { bootstrapSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(bootstrapSettled, false, "global bootstrap must wait for an active Capsule route mutation");
    assert.equal(JSON.parse((await mutation.result).stdout).ok, true);
    assert.equal(JSON.parse((await bootstrap.result).stdout).ok, true);

    const exclusiveBootstrap = startHostHelper({
      action: "host.bootstrap",
      host: fixture.request.host,
      capsule: null,
      bootstrap: { tls: { mode: "automatic" } },
    }, { cwd: dir, env: { ...env, SPORADES_FAKE_HOST_GLOBAL_ROUTE_LOCK_PAUSE_MS: "700" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const laterMutation = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...env, SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "0" },
    });
    let mutationSettled = false;
    laterMutation.result.then(() => { mutationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(mutationSettled, false, "Capsule mutation must wait for exclusive global bootstrap");
    assert.equal(JSON.parse((await exclusiveBootstrap.result).stdout).ok, true);
    assert.equal(JSON.parse((await laterMutation.result).stdout).ok, true);
  });
});

test("sporades host helper scavenges a dead pre-publication claim after SIGKILL", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const unrelatedFile = `${fixture.lockDir}.claim-not-a-protocol-token`;
    await writeFile(unrelatedFile, "unrelated\n");
    const orphanClaim = `${fixture.lockDir}.claim-${"e".repeat(32)}`;
    await writeFile(orphanClaim, `${JSON.stringify({ token: "e".repeat(32), pid: 999999, processIdentity: "dead", createdAt: 1 })}\n`);
    const holder = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const routeDir = path.dirname(fixture.routeFile);
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recovered = await runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.deepEqual(
      (await readdir(routeDir)).filter((entry) => new RegExp(`^${path.basename(fixture.lockDir)}\\.(?:claim|stale|reclaim)-[a-f0-9]{32}$`).test(entry)),
      [],
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated\n");
  });
});

test("sporades host helper scavenges a dead stale-lock quarantine after SIGKILL", async () => {
  await withTempDir(async (dir) => {
    const fixture = await prepareRouteLockFixture(dir);
    const orphanStale = `${fixture.lockDir}.stale-${"f".repeat(32)}`;
    await writeFile(
      orphanStale,
      `${JSON.stringify({
        token: "c".repeat(32),
        pid: 999999,
        processIdentity: "dead-route-owner",
        createdAt: Date.now() - 60_000,
      })}\n`,
    );
    const holder = startHostHelper(fixture.request, {
      cwd: dir,
      env: { ...fixture.docker.env, SPORADES_FAKE_ROUTE_LOCK_PAUSE_AFTER_OS_LOCK_MS: "10000" },
    });
    const routeDir = path.dirname(fixture.routeFile);
    await waitForPath(fixture.lockDir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(await waitForChildPid(holder.child.pid), "SIGKILL");
    await holder.result;

    const recovered = await runHostHelper(fixture.request, { cwd: dir, env: fixture.docker.env });
    assert.equal(JSON.parse(recovered.stdout).ok, true, recovered.stdout);
    assert.deepEqual(
      (await readdir(routeDir)).filter((entry) => new RegExp(`^${path.basename(fixture.lockDir)}\\.(?:claim|stale|reclaim)-[a-f0-9]{32}$`).test(entry)),
      [],
    );
  });
});

test("sporades host helper does not send the runtime probe credential to caller-supplied URLs", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const docker = await installFakeDocker(dir);
    let maliciousRequests = 0;

    await withHttpServer((request, response) => {
      assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (validPort) => {
      await withHttpServer((_request, response) => {
        maliciousRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: {}, error: null }));
      }, async (maliciousPort) => {
        const domain = `localhost:${validPort}`;
        const hostedUrl = `http://team-notes.localhost:${validPort}`;
        const registryRecordPath = path.join(remoteRoot, "hosts", domain, "registry", "capsules", "team-notes.json");
        await mkdir(path.dirname(registryRecordPath), { recursive: true });
        await writeFile(
          registryRecordPath,
          `${JSON.stringify({
            subname: "team-notes",
            domain,
            remoteCapsuleId: `${domain}/team-notes`,
            hostedUrl,
            status: "running",
            currentRelease: { id: "20260630T221500Z-feedface" },
            runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
          })}\n`,
        );

        const health = await runHostHelper(
          {
            action: "capsule.health",
            host: { alias: "personal", domain, scheme: "http", remoteRoot },
            capsule: { subname: "team-notes" },
            health: {
              runtimeHealthUrl: `http://localhost:${maliciousPort}/__sporades/health/runtime`,
              hostedUrl: `http://localhost:${maliciousPort}`,
              remoteCapsuleId: `localhost:${maliciousPort}/team-notes`,
              container: { name: "sporades-capsules-example-dev-team-notes" },
            },
          },
          { cwd: dir, env: docker.env },
        );

        assert.equal(health.code, 0, health.stderr);
        assert.equal(JSON.parse(health.stdout).ok, true);
        assert.equal(maliciousRequests, 0);
        assert.equal(health.stdout.includes("probe-secret"), false);
      });
    });
  });
});

test("Sporades runtime health rejects unauthenticated probes and returns safe readiness checks", async () => {
  await withTempDir(async (dir) => {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {});
    const server = createServer(async (request, response) => {
      if (await routeRuntimeHealth(database, request, response)) {
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = server.address().port;
      const unauthenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`);
      assert.equal(unauthenticated.status, 404);
      assert.equal(await unauthenticated.text(), "Not found");

      const authenticated = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
        headers: { "x-sporades-host-probe": "probe-secret" },
      });
      assert.equal(authenticated.status, 200);
      const body = await authenticated.json();
      assert.deepEqual(body, {
        ok: true,
        data: {
          runtime: { ready: true },
          checks: {
            sqlite: { ok: true },
            fileStorage: { ok: true },
            fileInspection: { ok: true },
          },
        },
        error: null,
      });
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(dir), false);
      assert.equal(raw.includes("probe-secret"), false);
      assert.equal(raw.includes("SPORADES"), false);
    } finally {
      database.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("sporades host helper reports structured Hosted Capsule runtime health failures", async () => {
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "remote-root");

    async function writeHealthRecord(root, overrides = {}) {
      const domain = overrides.domain ?? "capsules.example.dev";
      const { scheme = "https", ...recordOverrides } = overrides;
      const registryRecordPath = path.join(root, "hosts", domain, "registry", "capsules", "team-notes.json");
      await mkdir(path.dirname(registryRecordPath), { recursive: true });
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain,
          remoteCapsuleId: `${domain}/team-notes`,
          hostedUrl: `${scheme}://team-notes.${domain}`,
          status: "running",
          currentRelease: { id: "20260630T221500Z-feedface" },
          runtimeProbe: { header: "x-sporades-host-probe", token: "probe-secret" },
          ...recordOverrides,
        })}\n`,
      );
    }

    async function runHealth(root, env = {}, host = {}) {
      const domain = host.domain ?? "capsules.example.dev";
      const scheme = host.scheme ?? "https";
      return runHostHelper(
        {
          action: "capsule.health",
          host: { alias: "personal", domain, scheme, remoteRoot: root },
          capsule: { subname: "team-notes" },
          health: {
            runtimeHealthUrl: "http://malicious.localhost/__sporades/health/runtime",
            hostedUrl: "https://malicious.example.test",
            remoteCapsuleId: "malicious.example.test/team-notes",
            container: { name: "sporades-capsules-example-dev-team-notes" },
          },
        },
        { cwd: dir, env },
      );
    }

    const missingRoot = path.join(baseRoot, "missing");
    const missingDocker = await installFakeDocker(path.join(dir, "missing-docker"));
    const missing = await runHealth(missingRoot, missingDocker.env);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).data.failure, "unregistered-capsule");

    const noReleaseRoot = path.join(baseRoot, "no-release");
    await writeHealthRecord(noReleaseRoot, { currentRelease: null });
    const noReleaseDocker = await installFakeDocker(path.join(dir, "no-release-docker"));
    const noRelease = await runHealth(noReleaseRoot, noReleaseDocker.env);
    assert.equal(noRelease.code, 0, noRelease.stderr);
    assert.equal(JSON.parse(noRelease.stdout).data.failure, "no-current-release");

    const stoppedRoot = path.join(baseRoot, "stopped");
    await writeHealthRecord(stoppedRoot);
    const stoppedDocker = await installFakeDocker(path.join(dir, "stopped-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHealth(stoppedRoot, stoppedDocker.env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).data.failure, "stopped-container");

    const routeRoot = path.join(baseRoot, "route");
    const routeDocker = await installFakeDocker(path.join(dir, "route-docker"));
    const routePort = await reserveUnusedPort();
    const routeDomain = `localhost:${routePort}`;
    await writeHealthRecord(routeRoot, {
      domain: routeDomain,
      scheme: "http",
      hostedUrl: `http://team-notes.localhost:${routePort}`,
      remoteCapsuleId: `${routeDomain}/team-notes`,
    });
    const route = await runHealth(routeRoot, routeDocker.env, { domain: routeDomain, scheme: "http" });
    assert.equal(route.code, 0, route.stderr);
    assert.equal(JSON.parse(route.stdout).data.failure, "route-failure");

    const responseCases = [
      {
        failure: "runtime-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "sqlite-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: false }, fileStorage: { ok: true } } }, error: null },
      },
      {
        failure: "file-storage-failure",
        body: { ok: false, data: { runtime: { ready: false }, checks: { sqlite: { ok: true }, fileStorage: { ok: false } } }, error: null },
      },
    ];

    for (const responseCase of responseCases) {
      const root = path.join(baseRoot, responseCase.failure);
      const docker = await installFakeDocker(path.join(dir, `${responseCase.failure}-docker`));
      await withHttpServer((request, response) => {
        assert.equal(request.headers["x-sporades-host-probe"], "probe-secret");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseCase.body));
      }, async (port) => {
        const domain = `localhost:${port}`;
        await writeHealthRecord(root, {
          domain,
          scheme: "http",
          hostedUrl: `http://team-notes.localhost:${port}`,
          remoteCapsuleId: `${domain}/team-notes`,
        });
        const result = await runHealth(root, docker.env, { domain, scheme: "http" });
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.equal(output.data.failure, responseCase.failure);
        assert.equal(result.stdout.includes("probe-secret"), false);
        assert.equal(result.stdout.includes(baseRoot), false);
      });
    }
  });
});

test("sporades host helper stops containers and routes Hosted Capsules to unavailable", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.stopped, true);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(routeContents, /log \{\n    output file .*remote-root\/hosts\/capsules\.example\.dev\/capsules\/team-notes\/logs\/http\.log \{/);
    assert.match(routeContents, /roll_keep 5/);
    assert.match(routeContents, /@sporadesRuntimeHealth path \/__sporades\/health\/runtime/);
    assert.match(routeContents, /respond @sporadesRuntimeHealth 404/);
    assert.match(routeContents, /respond "Hosted Capsule unavailable" 503/);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "stopped");
  });
});

test("sporades host helper unregisters Hosted Capsules with tombstone TTL and route removal", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./hosts/*.caddy\n");
    await writeFile(path.join(capsuleDir, "data", "guestbook.json"), "[]\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-06-30T22:15:00.000Z",
        updatedAt: "2026-06-30T22:16:00.000Z",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123",
          Names: "sporades-capsules-example-dev-team-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 minutes",
          Labels:
            "com.sporades.managed=true,com.sporades.hosted-domain=capsules.example.dev,com.sporades.capsule-subname=team-notes",
        })}\n`,
      },
    });
    const request = {
      action: "capsule.unregister",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      unregister: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "caller-controlled-name" },
        routes: {
          removed: { hostname: "team-notes.capsules.example.dev", target: "removed", routeFile: path.join(dir, "caller-route.caddy") },
        },
      },
    };

    const before = Date.now();
    const unregister = await runHostHelper(request, { cwd: dir, env: docker.env });
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.route.routeFile, routeFile);
    assert.equal(output.data.route.removed, true);
    const deleteAfterMs = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfterMs >= before + 89 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfterMs <= after + 91 * 24 * 60 * 60 * 1000);
    await assert.rejects(readFile(routeFile, "utf8"), { code: "ENOENT" });
    assert.equal((await stat(path.join(capsuleDir, "releases"))).isDirectory(), true);
    assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    assert.equal(await readFile(path.join(capsuleDir, "data", "guestbook.json"), "utf8"), "[]\n");

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.match(record.unregisteredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"]],
    );

    const duplicate = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );

    const list = await runHostHelper(
      { action: "capsule.list", host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot } },
      { cwd: dir, env: docker.env },
    );
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).data.capsules, []);

    const missing = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "missing" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(missing.code, 0, missing.stderr);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.ok, false);
    assert.equal(missingOutput.error.message, "Hosted Capsule is not registered.");
    assert.match(missingOutput.error.hint, /sporades host register missing/);
  });
});

test("sporades host helper reports normalized Docker no-stream stats with raw passthrough", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260101T000000Z-abcdef12" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_INSPECT_JSON: `${JSON.stringify({
          State: {
            Running: true,
            Status: "running",
            StartedAt: "2026-01-01T00:00:00.000Z",
          },
          RestartCount: 2,
        })}\n`,
        FAKE_DOCKER_STATS_JSON: `${JSON.stringify({
          Container: "abc123",
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "12.34%",
          MemUsage: "128MiB / 1GiB",
          MemPerc: "12.50%",
          NetIO: "1.5MB / 240kB",
          BlockIO: "8.19kB / 16.4MB",
          PIDs: "11",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "capsule.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        stats: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          container: { name: "sporades-capsules-example-dev-team-notes" },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.stats, {
      cpuPercent: 12.34,
      memoryUsageBytes: 134217728,
      memoryLimitBytes: 1073741824,
      memoryPercent: 12.5,
      networkInputBytes: 1500000,
      networkOutputBytes: 240000,
      blockInputBytes: 8190,
      blockOutputBytes: 16400000,
      pids: 11,
    });
    assert.equal(output.data.raw.CPUPerc, "12.34%");
    assert.equal(output.data.raw.MemUsage, "128MiB / 1GiB");
    assert.equal(output.data.container.name, "sporades-capsules-example-dev-team-notes");
    assert.equal(output.data.lifecycle.registered, true);
    assert.equal(output.data.lifecycle.registryStatus, "running");
    assert.equal(output.data.lifecycle.running, true);
    assert.equal(output.data.lifecycle.restartCount, 2);
    assert.equal(output.data.lifecycle.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(typeof output.data.lifecycle.uptimeSeconds, "number");
    assert.equal(output.data.lifecycle.currentReleaseId, "20260101T000000Z-abcdef12");
    assert.equal(output.data.lifecycle.routeTarget, "container");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args), [
      ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
      ["stats", "--no-stream", "--format", "json", "sporades-capsules-example-dev-team-notes"],
      ["inspect", "--format", "{{json .}}", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});

test("sporades host helper lists an empty Hosted Capsule registry", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    await mkdir(path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules"), { recursive: true });

    const list = await runHostHelper({
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot,
      },
      capsule: null,
    });

    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [],
      },
      error: null,
    });
  });
});

test("sporades host helper lists registry records enriched with Docker container state", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    const draftsKeyFingerprint = "0123456789abcdef";
    const draftsPublicKey = "-----BEGIN PUBLIC KEY-----\npublic-drafts\n-----END PUBLIC KEY-----\n";
    const draftsKeyDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "drafts", "data", "sealed-server-env", "keys");
    await mkdir(registryDir, { recursive: true });
    await mkdir(draftsKeyDir, { recursive: true });
    await writeFile(path.join(draftsKeyDir, `${draftsKeyFingerprint}.public.pem`), draftsPublicKey);
    await writeFile(path.join(draftsKeyDir, `${draftsKeyFingerprint}.private.pem`), "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n");
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentRelease: null,
        sealedServerEnv: { currentKeyFingerprint: draftsKeyFingerprint },
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        currentRelease: {
          id: "20260103T000000Z-abcdef12",
          createdAt: "2026-01-03T00:00:00.000Z",
          bundleHash: "sha256:abc123",
        },
        sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
        releases: [
          {
            id: "20260103T000000Z-abcdef12",
            createdAt: "2026-01-03T00:00:00.000Z",
            uploadedAt: "2026-01-03T00:00:00.000Z",
            state: "started",
            current: true,
            source: {
              hostedUrl: "https://notes.capsules.example.dev",
              files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/sealed-server-env/server-env.sealed.json"],
              sealedServerEnvIncluded: true,
              sealedServerEnv: { publicKeyFingerprint: "0123456789abcdef" },
            },
          },
        ],
        baseImage: {
          updatePolicy: { mode: "manual" },
        },
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "archive.json"),
      `${JSON.stringify({
        subname: "archive",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/archive",
        hostedUrl: "https://archive.capsules.example.dev",
        status: "stopped",
        createdAt: "2026-01-04T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
        currentRelease: { id: "20260105T000000Z-fedcba98" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: [
          JSON.stringify({
            ID: "abc123def456",
            Names: "sporades-capsules-example-dev-notes",
            Image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
            State: "running",
            Status: "Up 2 hours",
            Labels:
              "com.sporades.managed=true,com.sporades.hosted-domain=capsules.example.dev,com.sporades.capsule-subname=notes,com.sporades.base-image.name=sporades-base,com.sporades.base-image.version=0.1.0-node22-alpine,com.sporades.base-image.update-policy=manual",
          }),
          JSON.stringify({
            ID: "fedcba654321",
            Names: "sporades-capsules-example-dev-archive",
            Image: "node:22-alpine",
            State: "exited",
            Status: "Exited (0) 3 minutes ago",
          }),
        ].join("\n") + "\n",
      },
    });

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    assert.doesNotMatch(list.stdout, /PRIVATE KEY|nope/);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsules: [
          {
            subname: "archive",
            domain: "capsules.example.dev",
            hostedUrl: "https://archive.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/archive",
              createdAt: "2026-01-04T00:00:00.000Z",
              updatedAt: "2026-01-05T00:00:00.000Z",
              status: "stopped",
            },
            currentRelease: { id: "20260105T000000Z-fedcba98" },
            docker: {
              containerId: "fedcba654321",
              containerName: "sporades-capsules-example-dev-archive",
              image: "node:22-alpine",
              state: "exited",
              status: "Exited (0) 3 minutes ago",
              running: false,
            },
            baseImage: {
              name: "unknown",
              image: "node:22-alpine",
              version: "unknown",
              updatePolicy: {
                mode: "host-managed",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
          {
            subname: "drafts",
            domain: "capsules.example.dev",
            hostedUrl: "https://drafts.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/drafts",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              status: "registered",
              sealedServerEnv: { currentKeyFingerprint: draftsKeyFingerprint },
            },
            sealedServerEnv: {
              publicKey: draftsPublicKey,
              publicKeyFingerprint: draftsKeyFingerprint,
              publicKeyPath: path.join(draftsKeyDir, `${draftsKeyFingerprint}.public.pem`),
              status: "available",
              publicKeyAvailable: true,
              privateKeyAvailable: true,
            },
            currentRelease: null,
            docker: null,
            baseImage: {
              name: "unknown",
              image: "unknown",
              version: "unknown",
              updatePolicy: {
                mode: "host-managed",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
          {
            subname: "notes",
            domain: "capsules.example.dev",
            hostedUrl: "https://notes.capsules.example.dev",
            registry: {
              remoteCapsuleId: "capsules.example.dev/notes",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
              status: "running",
              sealedServerEnv: { currentKeyFingerprint: "fedcba9876543210" },
            },
            currentRelease: {
              id: "20260103T000000Z-abcdef12",
              createdAt: "2026-01-03T00:00:00.000Z",
              bundleHash: "sha256:abc123",
              sealedServerEnv: { publicKeyFingerprint: "0123456789abcdef" },
            },
            sealedServerEnv: {
              publicKeyFingerprint: "fedcba9876543210",
              publicKeyPath: path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "notes", "data", "sealed-server-env", "keys", "fedcba9876543210.public.pem"),
              status: "missing-key-material",
              publicKeyAvailable: false,
              privateKeyAvailable: false,
            },
            docker: {
              containerId: "abc123def456",
              containerName: "sporades-capsules-example-dev-notes",
              image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
              state: "running",
              status: "Up 2 hours",
              running: true,
              baseImage: {
                name: "sporades-base",
                version: "0.1.0-node22-alpine",
                updatePolicy: { mode: "manual" },
              },
            },
            baseImage: {
              name: "sporades-base",
              image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
              version: "0.1.0-node22-alpine",
              updatePolicy: {
                mode: "manual",
                autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
              },
            },
          },
        ],
      },
      error: null,
    });

    const dockerCalls = await readJsonl(docker.logPath);
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=archive",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
  });
});

test("sporades host helper keeps listing registry records when Docker lookup fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PS_STATUS: "1" } });

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.capsules[0].subname, "notes");
    assert.equal(output.data.capsules[0].docker, null);
    assert.deepEqual(output.data.capsules[0].baseImage, {
      name: "unknown",
      image: "unknown",
      version: "unknown",
      updatePolicy: {
        mode: "host-managed",
        autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
      },
    });
  });
});

test("sporades host helper lists Hosted Capsule releases in deterministic order", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "team-notes.json"),
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: true,
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev" },
          },
          { id: "", state: "nonsense" },
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: false,
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs"] },
          },
        ],
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );
    assert.deepEqual(output.data.releases[0].startAttempts, [{ startedAt: "2026-06-30T22:16:00.000Z" }]);
    assert.deepEqual(output.data.releases[1].verificationAttempts, [{ verifiedAt: "2026-06-29T12:02:00.000Z" }]);
  });
});

test("sporades host helper lists legacy current release metadata without release history", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "team-notes.json"),
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface", createdAt: "2026-06-30T22:15:00.000Z" },
      })}\n`,
    );

    const releases = await runHostHelper({
      action: "capsule.release.list",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
    });

    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.deepEqual(
      output.data.releases.map((release) => ({
        id: release.id,
        createdAt: release.createdAt,
        state: release.state,
        current: release.current,
        legacy: release.legacy,
      })),
      [
        {
          id: "20260630T221500Z-feedface",
          createdAt: "2026-06-30T22:15:00.000Z",
          state: "uploaded",
          current: true,
          legacy: true,
        },
      ],
    );
  });
});

test("sporades host helper reports missing and stopped Hosted Capsules for stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const request = {
      action: "capsule.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      stats: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: { name: "sporades-capsules-example-dev-team-notes" },
      },
    };

    const missing = await runHostHelper(request, { cwd: dir });
    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before reading stats.",
      },
    });

    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(path.join(dir, "stopped"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const stopped = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no running container.",
        hint: "Run `sporades host start team-notes --host personal`, then retry stats.",
      },
    });

    const dockerInspectUnavailable = await installFakeDocker(path.join(dir, "docker-inspect-unavailable"), {
      env: { FAKE_DOCKER_RUNNING_STATUS: "1" },
    });
    const inspectUnavailable = await runHostHelper(request, { cwd: dir, env: dockerInspectUnavailable.env });
    assert.equal(inspectUnavailable.code, 0, inspectUnavailable.stderr);
    assert.deepEqual(JSON.parse(inspectUnavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });

    const dockerUnavailable = await installFakeDocker(path.join(dir, "docker-unavailable"), { env: { FAKE_DOCKER_STATS_STATUS: "1" } });
    const unavailable = await runHostHelper(request, { cwd: dir, env: dockerUnavailable.env });
    assert.equal(unavailable.code, 0, unavailable.stderr);
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});

test("sporades host helper reports Host server resource and Hosted Capsule counts", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "drafts.json"),
      `${JSON.stringify({
        subname: "drafts",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        status: "registered",
        currentRelease: null,
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "notes.json"),
      `${JSON.stringify({
        subname: "notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/notes",
        hostedUrl: "https://notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260103T000000Z-abcdef12" },
      })}\n`,
    );

    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_PS_JSONL: `${JSON.stringify({
          ID: "abc123def456",
          Names: "sporades-capsules-example-dev-notes",
          Image: "node:22-alpine",
          State: "running",
          Status: "Up 2 hours",
        })}\n`,
      },
    });

    const stats = await runHostHelper(
      {
        action: "host.stats",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(stats.code, 0, stats.stderr);
    const output = JSON.parse(stats.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.host, {
      alias: "personal",
      domain: "capsules.example.dev",
      scheme: "https",
      remoteRoot,
    });
    assert.equal(output.data.resources.disk.path, remoteRoot);
    assert.equal(typeof output.data.resources.disk.totalBytes, "number");
    assert.equal(typeof output.data.resources.memory.totalBytes, "number");
    assert.deepEqual(Object.keys(output.data.resources.load), ["oneMinute", "fiveMinutes", "fifteenMinutes"]);
    assert.deepEqual(output.data.services, {
      docker: { available: true },
      caddy: { available: true },
    });
    assert.deepEqual(output.data.capsules, {
      total: 2,
      registered: 1,
      running: 1,
      stopped: 0,
      unavailable: 1,
    });

    const dockerCalls = await docker.calls();
    assert.deepEqual(dockerCalls.map((call) => call.args), [
      ["version", "--format", "{{.Server.Version}}"],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=drafts",
        "--format",
        "json",
      ],
      [
        "ps",
        "-a",
        "--filter",
        "label=com.sporades.managed=true",
        "--filter",
        "label=com.sporades.hosted-domain=capsules.example.dev",
        "--filter",
        "label=com.sporades.capsule-subname=notes",
        "--format",
        "json",
      ],
    ]);
    const caddyCalls = await docker.caddyCalls();
    assert.deepEqual(caddyCalls.map((call) => call.args), [["version"]]);
  });
});

test("sporades host helper reports malformed registry state for Host server stats", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    const recordPath = path.join(registryDir, "broken.json");
    await writeFile(recordPath, "{not-json}\n");

    const stats = await runHostHelper({
      action: "host.stats",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: null,
    });

    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule registry record is invalid.",
        hint: `Repair the Host server registry record at ${recordPath}, then retry \`sporades host stats --host personal\`.`,
      },
    });
  });
});

test("sporades host helper reads recent Caddy access log entries from the managed log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const accessLog = path.join(remoteRoot, "caddy", "logs", "access.log");
    await mkdir(path.dirname(accessLog), { recursive: true });
    await writeFile(
      accessLog,
      [
        "2026/01/01 00:00:01 GET /old",
        "2026/01/01 00:00:02 GET /one",
        "2026/01/01 00:00:03 GET /two",
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: null,
        logs: { source: "caddy-combined", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: ["2026/01/01 00:00:02 GET /one", "2026/01/01 00:00:03 GET /two"],
      },
      error: null,
    });
  });
});

test("sporades host helper reads capsule-scoped HTTP logs from the Hosted Capsule log file", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleLog = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes", "logs", "http.log");
    await mkdir(path.dirname(capsuleLog), { recursive: true });
    await writeFile(
      capsuleLog,
      [
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/old"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
        '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
      ].join("\n") + "\n",
    );

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        logs: { source: "http", lines: 2 },
      },
      { cwd: dir },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "http",
        entries: [
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/one"},"status":200}',
          '{"request":{"host":"team-notes.capsules.example.dev","uri":"/two"},"status":404}',
        ],
      },
      error: null,
    });
  });
});

test("sporades host helper falls back to Caddy journald logs when the managed log file is absent", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STDOUT: "caddy service started\nhandled request for team-notes.capsules.example.dev\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 50 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 50,
        source: "http",
        entries: ["caddy service started", "handled request for team-notes.capsules.example.dev"],
      },
      error: null,
    });
    assert.deepEqual((await journalctl.calls()).map((call) => call.args), [
      ["-u", "caddy", "-n", "50", "--no-pager", "-o", "cat"],
    ]);
  });
});

test("sporades host helper reads Hosted Capsule stdout and stderr from Docker logs", async () => {
  await withTempDir(async (dir) => {
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: {
        FAKE_DOCKER_LOGS_STDOUT: "stdout old\nstdout one\nstdout two\n",
        FAKE_DOCKER_LOGS_STDERR: "stderr old\nstderr one\nstderr two\n",
      },
    });

    const stdout = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stdout", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stdout",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stdout one", "stdout two"],
      },
      error: null,
    });

    const stderr = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: { subname: "team-notes" },
        logs: { source: "stderr", lines: 2 },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout), {
      ok: true,
      data: {
        lineCount: 2,
        source: "stderr",
        container: "sporades-capsules-example-dev-team-notes",
        entries: ["stderr one", "stderr two"],
      },
      error: null,
    });

    assert.deepEqual((await docker.calls()).map((call) => call.args), [
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
      ["logs", "--tail", "2", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});

test("sporades host helper reports unavailable Caddy logs as a structured error", async () => {
  await withTempDir(async (dir) => {
    const journalctl = await installFakeJournalctl(dir, {
      env: {
        FAKE_JOURNALCTL_STATUS: "1",
        FAKE_JOURNALCTL_STDERR: "No journal files were found.\n",
      },
    });

    const logs = await runHostHelper(
      {
        action: "host.logs",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: path.join(dir, "remote-root") },
        capsule: null,
        logs: { source: "caddy-combined", lines: 100 },
      },
      { cwd: dir, env: journalctl.env },
    );

    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});

test("sporades host helper reloads Caddy after lifecycle route changes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"));
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };
    const request = {
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const start = await runHostHelper({ ...request, action: "capsule.start" }, { cwd: dir, env });
    assert.equal(start.code, 0, start.stderr);
    const stop = await runHostHelper({ ...request, action: "capsule.stop" }, { cwd: dir, env });
    assert.equal(stop.code, 0, stop.stderr);

    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper writes explicit Cloudflare origin TLS routes when requested", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server';\n");
    await writeFile(path.join(releaseDir, "client.js"), "console.log('client');\n");
    await writeFile(path.join(releaseDir, "index.html"), "<div></div>\n");
    await writeFile(path.join(releaseDir, "sporades.json"), "{}\n");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"));
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: {
              hostname: "team-notes.capsules.example.dev",
              target: "container",
              containerName: "sporades-capsules-example-dev-team-notes",
              port: 4000,
              routeFile,
              tls: {
                mode: "cloudflare-origin",
                certificate: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.crt"),
                key: path.join(remoteRoot, "hosts", "capsules.example.dev", "tls", "origin.key"),
              },
            },
          },
        },
      },
      { cwd: dir, env },
    );
    assert.equal(start.code, 0, start.stderr);
    const routeContents = await readFile(routeFile, "utf8");
    assert.match(
      routeContents,
      /tls .*hosts\/capsules\.example\.dev\/tls\/origin\.crt .*hosts\/capsules\.example\.dev\/tls\/origin\.key/,
    );
    assert.match(routeContents, /@sporadesUntrustedCloudflareSource not remote_ip .*173\.245\.48\.0\/20/);
    assert.match(routeContents, /2400:cb00::\/32/);
    assert.match(routeContents, /respond @sporadesUntrustedCloudflareSource 403/);
    assert.match(routeContents, /header_up x-sporades-client-address \{http\.request\.header\.CF-Connecting-IP\}/i);
    assert.doesNotMatch(routeContents, /header_up x-sporades-client-address \{http\.request\.remote\.host\}/);
  });
});

test("sporades host helper preserves previous route when Caddy validation fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_VALIDATE_STATUS: "1" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to validate Hosted Capsule route.",
        hint: "Check the generated Caddy route for this Hosted Capsule, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual((await caddy.calls()).map((call) => call.args), [["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"]]);
  });
});

test("sporades host helper reloads the restored route after candidate reload failure", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,0" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to apply Hosted Capsule route.",
        hint: "Check the Host server Caddy configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper reports candidate and rollback reload failures", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const caddy = await installFakeCaddy(path.join(dir, "caddy"), { env: { FAKE_CADDY_RELOAD_STATUSES: "1,1" } });
    const env = {
      ...docker.env,
      ...caddy.env,
      PATH: `${caddy.fakeBinDir}${path.delimiter}${docker.fakeBinDir}${path.delimiter}${process.env.PATH}`,
    };

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to apply Hosted Capsule route and failed to reload the restored Caddy config.",
        hint: "The previous route file was restored, but Caddy could not reload it. Check the Host server Caddy service and configuration, then retry the lifecycle command.",
      },
    });
    assert.equal(await readFile(routeFile, "utf8"), "team-notes.capsules.example.dev {\n  reverse_proxy old-container:4000\n}\n");
    assert.deepEqual(
      (await caddy.calls()).map((call) => call.args),
      [
        ["validate", "--config", `${routeFile}.tmp`, "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper returns a standard JSON error when the Hosted domain registry is locked", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const lockDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", ".lock");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(lockDir, { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev", status: "running" })}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: { ...docker.env, SPORADES_REGISTRY_LOCK_TIMEOUT_MS: "30" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain registry is locked.",
        hint: "Wait for the other Host server operation to finish, then retry the command.",
      },
    });
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
  });
});

test("sporades host helper keeps the authoritative registry JSON when an atomic write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const originalRecord = { subname: "team-notes", domain: "capsules.example.dev", status: "running" };
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify(originalRecord)}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runHostHelper(
      {
        action: "capsule.stop",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: { ...docker.env, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } },
    );

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to write Hosted Capsule registry record.",
        hint: "Check Host server disk permissions and free space, then retry the command.",
      },
    });
    assert.deepEqual(JSON.parse(await readFile(registryRecordPath, "utf8")), originalRecord);
    assert.deepEqual((await readdir(path.dirname(registryRecordPath))).sort(), ["team-notes.json"]);
  });
});

test("sporades host helper reports no release and failed starts with unavailable routes", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });
    const request = {
      action: "capsule.start",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {
        hostedUrl: "https://team-notes.capsules.example.dev",
        container: { name: "sporades-capsules-example-dev-team-notes" },
        routes: {
          running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
          unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
        },
      },
    };

    const noRelease = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.deepEqual(JSON.parse(noRelease.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No Hosted Capsule release has been pushed.",
        hint: "Run `sporades host push --host personal --subname team-notes` before starting the Hosted Capsule.",
      },
    });

    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    await mkdir(releaseDir, { recursive: true });
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const failedStart = await runHostHelper(request, { cwd: dir, env: docker.env });
    assert.equal(JSON.parse(failedStart.stdout).ok, false);
    assert.equal(JSON.parse(failedStart.stdout).error.message, "Hosted Capsule container did not stay running.");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.releases.length, 1);
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].current, true);
    assert.equal(record.releases[0].startAttempts.length, 1);
    assert.match(record.releases[0].startAttempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.releases[0].failure.message, "Hosted Capsule container did not stay running.");
    assert.match(record.releases[0].failure.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("sporades host helper rejects caller-controlled Docker lifecycle authority before invoking Docker", async () => {
  for (const [label, createLifecycle] of [
    ["current-link", () => ({ currentLink: "/" })],
    ["file-mount", () => ({ mounts: { files: [{ host: "/etc/passwd", container: "/app/server.mjs", mode: "ro" }] } })],
    ["sealed-key-host", (fixture) => {
      const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
      lifecycle.mounts.files.find((mount) => mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem").host = "/etc/passwd";
      return lifecycle;
    }],
    ["sealed-key-shape", (fixture) => {
      const lifecycle = buildHostLifecycle(fixture.remoteRoot, fixture.domain, fixture.subname);
      lifecycle.mounts.files.find((mount) => mount.container === "/app/.sporades/sealed-server-env/server-env.private.pem").fingerprint = "0123456789abcdef";
      return lifecycle;
    }],
    ["data-mount", () => ({ mounts: { data: { host: "/", container: "/app/data", mode: "rw" } } })],
    ["root-user", () => ({ container: { user: "0:0" } })],
    ["attacker-image", () => ({ container: { image: "attacker.invalid/root:latest" } })],
    ["running-upstream", () => ({ routes: { running: { upstream: "127.0.0.1:4000" } } })],
    ["runtime-probe", () => ({ routes: { running: { runtimeProbe: { header: "x-sporades-host-probe", token: "caddy-injection" } } } })],
    ["tls-certificate", (fixture) => ({ routes: { running: { tls: { mode: "cloudflare-origin", certificate: "/tmp/outside.crt", key: "/tmp/outside.key" } } } })],
    ["unknown-route-field", () => ({ routes: { unavailable: { caddyDirective: "respond 200" } } })],
  ]) {
    await withTempDir(async (dir) => {
      const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
      const docker = await installFakeDocker(path.join(dir, "docker"));
      const lifecycle = createLifecycle(fixture);
      const routeFile = path.join(fixture.remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
      const routeBefore = await readFile(routeFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      const registryBefore = await readFile(fixture.registryRecordPath);
      const result = await runHostHelper({
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle,
      }, { cwd: dir, env: docker.env });

      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false, `${label}: ${result.stdout}`);
      assert.equal(output.error.message, "Invalid Hosted Capsule lifecycle authority.", `${label}: ${result.stdout}`);
      await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(docker.caddyLogPath, "utf8"), { code: "ENOENT" });
      assert.deepEqual(await readFile(routeFile).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)), routeBefore);
      assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    });
  }
});

test("sporades host helper starts a retained old-image release from the current builder lifecycle DTO", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      releaseIds: ["20260630T221500Z-feedface"],
      status: "stopped",
    });
    const previousImage = "registry.example/sporades-base:previous";
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: previousImage, version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "true", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49161" },
    });

    const result = await runHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.container.image, previousImage);
    assert.equal(output.data.route.hostname, `${fixture.subname}.${fixture.domain}`);
    const runs = (await docker.calls()).filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(await docker.calls()));
    assert(runs[0].args.includes(previousImage));
    assert(!runs[0].args.includes(lifecycle.container.image));
    const route = await readFile(lifecycle.routes.running.routeFile, "utf8");
    assert.match(route, /127\.0\.0\.1:49161/);
    assert.equal(JSON.parse(await readFile(fixture.registryRecordPath, "utf8")).status, "running");
  });
});

test("sporades host helper validates a current builder restart before stopping and runs the retained old image", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const previousImage = "registry.example/sporades-base:previous";
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: previousImage, version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    await mkdir(path.dirname(lifecycle.routes.running.routeFile), { recursive: true });
    await writeFile(lifecycle.routes.running.routeFile, `${fixture.subname}.${fixture.domain} {\n  reverse_proxy 127.0.0.1:49160\n}\n`);
    const docker = await installFakeDocker(path.join(dir, "docker"), {
      env: { FAKE_DOCKER_RUNNING: "true", FAKE_DOCKER_PUBLISHED_PORT: "127.0.0.1:49162" },
    });

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, result.stdout);
    assert.equal(output.data.container.image, previousImage);
    assert.equal(output.data.route.hostname, `${fixture.subname}.${fixture.domain}`);
    const calls = await docker.calls();
    const runs = calls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 1, JSON.stringify(calls));
    assert(runs[0].args.includes(previousImage));
    assert(!runs[0].args.includes(lifecycle.container.image));
    assert.deepEqual(calls.slice(0, 2).map((call) => call.args[0]), ["stop", "rm"]);
    const route = await readFile(lifecycle.routes.running.routeFile, "utf8");
    assert.match(route, /127\.0\.0\.1:49162/);
    assert.doesNotMatch(route, /127\.0\.0\.1:49160/);
  });
});

test("sporades host helper rejects an unknown restart image before Docker Caddy or state mutation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.baseImage = { name: "sporades-base", image: "registry.example/sporades-base:previous", version: "previous", updatePolicy: { mode: "manual" } };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    const lifecycle = createHostLifecycleRequest(
      "personal",
      { domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot, tls: "automatic" },
      fixture.subname,
    );
    lifecycle.container.image = "attacker.invalid/root:latest";
    const routeFile = lifecycle.routes.running.routeFile;
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(routeFile, "previous exact route bytes\n");
    const registryBefore = await readFile(fixture.registryRecordPath);
    const routeBefore = await readFile(routeFile);
    const docker = await installFakeDocker(path.join(dir, "docker"));

    const result = await runHostHelper({
      action: "capsule.restart",
      host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: fixture.subname },
      lifecycle,
    }, { cwd: dir, env: docker.env });

    assert.equal(JSON.parse(result.stdout).error.message, "Invalid Hosted Capsule lifecycle authority.", result.stdout);
    await assert.rejects(readFile(docker.logPath), { code: "ENOENT" });
    await assert.rejects(readFile(docker.caddyLogPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(fixture.registryRecordPath), registryBefore);
    assert.deepEqual(await readFile(routeFile), routeBefore);
  });
});

test("sporades host helper quiesces Docker before descriptor-fenced runtime-data preparation", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { releaseIds: ["20260630T221500Z-feedface"] });
    const docker = await installFakeDocker(path.join(dir, "docker"));
    const outside = path.join(dir, "outside-runtime-data");
    const sentinel = path.join(outside, "sentinel.bin");
    await mkdir(outside, { mode: 0o711 });
    await writeFile(sentinel, Buffer.from([9, 2, 6, 5]), { mode: 0o604 });
    const outsideBefore = await lstat(outside);
    const sentinelBefore = await lstat(sentinel);
    const sentinelHash = createHash("sha256").update(await readFile(sentinel)).digest("hex");
    const marker = path.join(dir, "runtime-data.marker");
    const retainedData = `${fixture.dataDir}.retained`;
    const action = startHostHelper({
      action: "capsule.start",
      host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot: fixture.remoteRoot },
      capsule: { subname: "team-notes" },
      lifecycle: {},
    }, {
      cwd: dir,
      env: {
        ...docker.env,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_BOUNDARY: "runtime-data-descriptor-mutate",
        SPORADES_TEST_RUNTIME_DATA_MUTATION_MARKER: marker,
        SPORADES_TEST_RUNTIME_DATA_MUTATION_TARGET_SUFFIX: "/data",
        SPORADES_FAKE_RUNTIME_DATA_MUTATION_PAUSE_MS: "700",
      },
    });
    await waitForPath(marker);
    assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["stop", "rm"]);
    await rename(fixture.dataDir, retainedData);
    await symlink(outside, fixture.dataDir);
    const result = await action.result;
    assert.equal(JSON.parse(result.stdout).error.message, "Hosted Capsule data path failed its no-follow trust check.", result.stdout);
    assert.deepEqual((await docker.calls()).map((call) => call.args[0]), ["stop", "rm"]);
    const outsideAfter = await lstat(outside);
    const sentinelAfter = await lstat(sentinel);
    assert.equal(createHash("sha256").update(await readFile(sentinel)).digest("hex"), sentinelHash);
    assert.deepEqual([outsideAfter.mode & 0o777, outsideAfter.uid, outsideAfter.gid], [outsideBefore.mode & 0o777, outsideBefore.uid, outsideBefore.gid]);
    assert.deepEqual([sentinelAfter.mode & 0o777, sentinelAfter.uid, sentinelAfter.gid], [sentinelBefore.mode & 0o777, sentinelBefore.uid, sentinelBefore.gid]);
  });
});

test("sporades host helper builds the base image when registry pull is unavailable", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(path.join(remoteRoot, "Dockerfile.base"), "FROM node:22-alpine\n");
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_IMAGE_INSPECT_STATUS: "1",
        FAKE_DOCKER_PULL_STATUS: "1",
        FAKE_DOCKER_BUILD_STATUS: "0",
      },
    });

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).ok, true);
    const calls = await docker.calls();
    assert.deepEqual(
      calls.filter((call) => ["image", "pull", "build"].includes(call.args[0])).map((call) => call.args),
      [
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"],
        ["pull", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"],
        ["build", "-f", path.join(remoteRoot, "Dockerfile.base"), "-t", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine", remoteRoot],
      ],
    );
    assert.ok(calls.some((call) => call.args[0] === "run"));
  });
});

test("sporades host helper fails start with guidance when the base image cannot be pulled or built", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_IMAGE_INSPECT_STATUS: "1",
        FAKE_DOCKER_PULL_STATUS: "1",
      },
    });

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    assert.deepEqual(JSON.parse(start.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unable to prepare the Sporades Base image.",
        hint: `Docker could not pull ghcr.io/sporades/sporades-base:0.1.0-node22-alpine, and ${path.join(remoteRoot, "Dockerfile.base")} is missing. Reinstall the Sporades Host helper files, then retry \`sporades host start team-notes --host <alias>\`.`,
      },
    });
    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"],
        ["pull", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"],
      ],
    );
  });
});

test("sporades host helper fails start when Docker does not report a usable loopback published port", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    await symlink(releaseDir, path.join(capsuleDir, "current"));
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_PUBLISHED_PORT: "0.0.0.0:49153" } });

    const start = await runHostHelper(
      {
        action: "capsule.start",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        lifecycle: {
          hostedUrl: "https://team-notes.capsules.example.dev",
          container: { name: "sporades-capsules-example-dev-team-notes" },
          routes: {
            running: { hostname: "team-notes.capsules.example.dev", target: "container", containerName: "sporades-capsules-example-dev-team-notes", port: 4000, routeFile },
            unavailable: { hostname: "team-notes.capsules.example.dev", target: "hosted-capsule-unavailable", statusCode: 503, routeFile },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(start.code, 0, start.stderr);
    assert.deepEqual(JSON.parse(start.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Docker did not report a loopback published port for Hosted Capsule.",
        hint: "Ensure Docker published container port 4000 on 127.0.0.1, then retry `sporades host start team-notes --host personal`.",
      },
    });
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.releases[0].id, "20260630T221500Z-feedface");
    assert.equal(record.releases[0].state, "failed");
    assert.equal(record.releases[0].failure.message, "Docker did not report a loopback published port for Hosted Capsule.");
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
        ["image", "inspect", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"],
        ["run", "--detach", "--name", "sporades-capsules-example-dev-team-notes", "--network", "sporades-hosted-capsules", "--restart", "on-failure:3", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=5", "--label", "com.sporades.managed=true", "--label", "com.sporades.hosted-domain=capsules.example.dev", "--label", "com.sporades.capsule-subname=team-notes", "--label", "com.sporades.capsule-id=capsules.example.dev/team-notes", "--label", "com.sporades.base-image.name=sporades-base", "--label", "com.sporades.base-image.version=0.1.0-node22-alpine", "--label", "com.sporades.base-image.update-policy=host-managed", "--label", "com.sporades.release-id=20260630T221500Z-feedface", "--volume", `${path.join(capsuleDir, "current", "server.mjs")}:/app/server.mjs:ro`, "--volume", `${path.join(capsuleDir, "current", "public")}:/app/public:ro`, "--volume", `${path.join(capsuleDir, "current", "sporades.json")}:/app/sporades.json:ro`, "--volume", `${path.join(capsuleDir, "data")}:/app/data:rw`, "--workdir", "/app", "--env", "PORT=4000", "--env", "SPORADES_LOG_STDOUT=1", "--env", "SPORADES_SECURITY_SESSION=hosted", "--env", "SPORADES_CLAMAV_MANAGED=1", "--env", "SPORADES_PUBLIC_ORIGIN=https://team-notes.capsules.example.dev", "--env", "SPORADES_RELEASE_ID=20260630T221500Z-feedface", "--publish", "127.0.0.1::4000", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine", "node", "/app/server.mjs"],
        ["inspect", "-f", "{{.State.Running}}", "sporades-capsules-example-dev-team-notes"],
        ["inspect", "-f", "{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostIp}}:{{(index (index .NetworkSettings.Ports \"4000/tcp\") 0).HostPort}}", "sporades-capsules-example-dev-team-notes"],
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
  });
});

test("sporades host helper refuses to install a release for an unregistered Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before pushing a release.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});

test("sporades host helper unregisters a Hosted Capsule without deleting release or data storage", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev.caddy"), "import capsules.example.dev/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "running",
          createdAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:30:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const before = Date.now();
    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    const after = Date.now();

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.idempotent, false);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.preserved.releases, releaseDir);
    assert.equal(output.data.preserved.data, dataDir);
    assert.equal(output.data.route.removed, true);
    assert.equal(output.data.container.removed, true);
    const deleteAfter = Date.parse(output.data.deleteAfter);
    assert.ok(deleteAfter >= before + 90 * 24 * 60 * 60 * 1000);
    assert.ok(deleteAfter <= after + 90 * 24 * 60 * 60 * 1000 + 1000);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "unregistered");
    assert.equal(record.unregistered, true);
    assert.equal(record.deleteAfter, output.data.deleteAfter);
    assert.equal(record.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(record.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args),
      [
        ["stop", "sporades-capsules-example-dev-team-notes"],
        ["rm", "sporades-capsules-example-dev-team-notes"],
      ],
    );
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);

    const duplicate = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const duplicateOutput = JSON.parse(duplicate.stdout);
    assert.equal(duplicateOutput.ok, true);
    assert.equal(duplicateOutput.data.unregistered, true);
    assert.equal(duplicateOutput.data.idempotent, true);
    assert.equal(duplicateOutput.data.deleteAfter, output.data.deleteAfter);

    const stoppedDocker = await installFakeDocker(path.join(dir, "reactivate-docker"), { env: { FAKE_DOCKER_RUNNING: "false" } });
    const reactivate = await runHostHelper(
      {
        action: "capsule.register",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: stoppedDocker.env },
    );
    assert.equal(reactivate.code, 0, reactivate.stderr);
    const reactivateOutput = JSON.parse(reactivate.stdout);
    assert.equal(reactivateOutput.ok, true);
    assert.equal(reactivateOutput.data.registered, true);
    assert.equal(reactivateOutput.data.reactivated, true);
    const reactivatedRecord = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(reactivatedRecord.status, "registered");
    assert.equal(reactivatedRecord.currentRelease.id, "20260630T221500Z-feedface");
    assert.equal(reactivatedRecord.deleteAfter, undefined);
    assert.equal(reactivatedRecord.unregisteredAt, undefined);
    assert.equal(reactivatedRecord.unregistered, undefined);
    assert.equal(await readFile(path.join(releaseDir, "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "persistent sqlite bytes\n");
    assert.match(await readFile(routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);
  });
});

test("sporades host helper deletes unregistered Hosted Capsule storage only", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releaseDir = path.join(capsuleDir, "releases", "20260630T221500Z-feedface");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const otherCapsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "other-notes");
    const otherDomainCapsuleDir = path.join(remoteRoot, "hosts", "other.example.dev", "capsules", "team-notes");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(otherCapsuleDir, { recursive: true });
    await mkdir(otherDomainCapsuleDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(releaseDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(dataDir, "data.db"), "persistent sqlite bytes\n");
    await writeFile(path.join(otherCapsuleDir, "keep.txt"), "same domain, different Capsule\n");
    await writeFile(path.join(otherDomainCapsuleDir, "keep.txt"), "same subname, different domain\n");
    await writeFile(routeFile, "team-notes.capsules.example.dev {\n  respond \"removed\" 410\n}\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify(
        {
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status: "unregistered",
          unregistered: true,
          unregisteredAt: "2026-07-01T12:00:00.000Z",
          deleteAfter: "2026-09-29T12:00:00.000Z",
          currentRelease: { id: "20260630T221500Z-feedface" },
        },
        null,
        2,
      )}\n`,
    );
    const docker = await installFakeDocker(dir);

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.registryRecord.path, registryRecordPath);
    assert.equal(output.data.registryRecord.removed, true);
    assert.equal(output.data.directories.capsule.path, capsuleDir);
    assert.equal(output.data.directories.capsule.removed, true);
    assert.equal(output.data.directories.releases.path, path.join(capsuleDir, "releases"));
    assert.equal(output.data.directories.releases.removed, true);
    assert.equal(output.data.directories.data.path, dataDir);
    assert.equal(output.data.directories.data.removed, true);
    assert.equal(output.data.route.path, routeFile);
    assert.equal(output.data.route.removed, true);
    await assert.rejects(stat(registryRecordPath), { code: "ENOENT" });
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });
    assert.equal(await readFile(path.join(otherCapsuleDir, "keep.txt"), "utf8"), "same domain, different Capsule\n");
    assert.equal(await readFile(path.join(otherDomainCapsuleDir, "keep.txt"), "utf8"), "same subname, different domain\n");
    await assert.rejects(stat(docker.logPath), { code: "ENOENT" });
    assert.deepEqual((await docker.caddyCalls()).map((call) => call.args), [
      ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
    ]);
  });
});

test("sporades host helper refuses to delete active Hosted Capsule registry states", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });

    for (const status of ["registered", "running", "stopped", "released"]) {
      await writeFile(
        registryRecordPath,
        `${JSON.stringify({
          subname: "team-notes",
          domain: "capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          hostedUrl: "https://team-notes.capsules.example.dev",
          status,
        })}\n`,
      );
      const deleted = await runHostHelper(
        {
          action: "capsule.delete",
          host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
          capsule: { subname: "team-notes" },
        },
        { cwd: dir },
      );
      assert.equal(deleted.code, 0, deleted.stderr);
      const output = JSON.parse(deleted.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
      assert.match(output.error.hint, /sporades host unregister team-notes/);
      assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, status);
      assert.equal((await stat(path.join(capsuleDir, "data"))).isDirectory(), true);
    }
  });
});

test("sporades host helper delete recovers partial cleanup and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const dataDir = path.join(capsuleDir, "data");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    await writeFile(path.join(dataDir, "leftover.db"), "partial cleanup leftover\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "unregistered",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const partial = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(partial.code, 0, partial.stderr);
    const partialOutput = JSON.parse(partial.stdout);
    assert.equal(partialOutput.ok, true);
    assert.equal(partialOutput.data.idempotent, false);
    assert.equal(partialOutput.data.registryRecord.removed, true);
    assert.equal(partialOutput.data.registryRecord.alreadyAbsent, false);
    assert.equal(partialOutput.data.directories.capsule.removed, true);
    assert.equal(partialOutput.data.route.removed, false);
    assert.equal(partialOutput.data.route.alreadyAbsent, true);
    await assert.rejects(stat(capsuleDir), { code: "ENOENT" });
    await assert.rejects(stat(routeFile), { code: "ENOENT" });

    const retry = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(retry.code, 0, retry.stderr);
    const retryOutput = JSON.parse(retry.stdout);
    assert.equal(retryOutput.ok, true);
    assert.equal(retryOutput.data.idempotent, true);
    assert.equal(retryOutput.data.registryRecord.alreadyAbsent, true);
    assert.equal(retryOutput.data.directories.capsule.alreadyAbsent, true);
    assert.equal(retryOutput.data.route.alreadyAbsent, true);
  });
});

test("sporades host helper delete refuses missing tombstone when storage remains", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await writeFile(path.join(capsuleDir, "data", "live.db"), "must not delete without tombstone proof\n");

    const deleted = await runHostHelper(
      {
        action: "capsule.delete",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir },
    );

    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule must be unregistered before deletion.");
    assert.match(output.error.hint, /sporades host unregister team-notes/);
    assert.equal(await readFile(path.join(capsuleDir, "data", "live.db"), "utf8"), "must not delete without tombstone proof\n");
  });
});

test("sporades host helper restores the route when unregister tombstone write fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    const routeFile = path.join(remoteRoot, "caddy", "hosts", "capsules.example.dev", "team-notes.caddy");
    await mkdir(path.join(capsuleDir, "releases", "20260630T221500Z-feedface"), { recursive: true });
    await mkdir(path.join(capsuleDir, "data"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await mkdir(path.dirname(routeFile), { recursive: true });
    await mkdir(path.join(remoteRoot, "caddy"), { recursive: true });
    await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import hosts/*.caddy\n");
    const originalRoute = "team-notes.capsules.example.dev {\n  reverse_proxy sporades-capsules-example-dev-team-notes:4000\n}\n";
    await writeFile(routeFile, originalRoute);
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
      })}\n`,
    );
    const docker = await installFakeDocker(dir, { env: { SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: "1" } });

    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Failed to write Hosted Capsule registry record.");
    assert.equal(await readFile(routeFile, "utf8"), originalRoute);
    assert.equal(JSON.parse(await readFile(registryRecordPath, "utf8")).status, "running");
    assert.deepEqual(
      (await docker.caddyCalls()).map((call) => call.args),
      [
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
        ["reload", "--config", path.join(remoteRoot, "caddy", "Caddyfile"), "--adapter", "caddyfile"],
      ],
    );
  });
});

test("sporades host helper fails unregister for a missing Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const unregister = await runHostHelper(
      {
        action: "capsule.unregister",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
      },
      { cwd: dir },
    );

    assert.equal(unregister.code, 0, unregister.stderr);
    assert.deepEqual(JSON.parse(unregister.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register team-notes --host personal` before unregistering the Hosted Capsule.",
      },
    });
  });
});

test("sporades host helper omits unregistered Capsules from list output", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "active.json"),
      `${JSON.stringify({
        subname: "active",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/active",
        hostedUrl: "https://active.capsules.example.dev",
        status: "registered",
      })}\n`,
    );
    await writeFile(
      path.join(registryDir, "old.json"),
      `${JSON.stringify({
        subname: "old",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/old",
        hostedUrl: "https://old.capsules.example.dev",
        status: "unregistered",
        unregistered: true,
        deleteAfter: "2026-09-29T12:00:00.000Z",
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const list = await runHostHelper(
      {
        action: "capsule.list",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: null,
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(
      output.data.capsules.map((capsule) => capsule.subname),
      ["active"],
    );
  });
});

test("sporades host helper derives install paths from Host state instead of request-supplied directories", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    const outsideDir = path.join(dir, "outside-target");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: outsideDir,
            releases: path.join(outsideDir, "releases"),
            release: path.join(outsideDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(outsideDir, "data"),
          },
          currentLink: path.join(outsideDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.release.directory, path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    assert.equal(output.data.release.currentLink, path.join(capsuleDir, "current"));
    assert.equal(await readFile(path.join(capsuleDir, "releases", "20260630T221500Z-feedface", "server.mjs"), "utf8"), "export default 'server bundle';\n");
    assert.equal(await readlink(path.join(capsuleDir, "current")), path.join(capsuleDir, "releases", "20260630T221500Z-feedface"));
    await assert.rejects(stat(path.join(outsideDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(outsideDir, "current")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects known macOS archive metadata before release install", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await mkdir(path.join(runtimeDir, "__MACOSX"), { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, "metadata-root"), "appledouble metadata\n");
    await writeFile(path.join(runtimeDir, "metadata-nested"), "appledouble metadata\n");
    await createTarGzWithTransforms(archivePath, runtimeDir, [
      "|^metadata-root$|._server.mjs|",
      "|^metadata-nested$|__MACOSX/._server.mjs|",
    ], [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "metadata-root",
      "metadata-nested",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule release archive contains unsupported metadata.");
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects unsafe or unexpected release archive entries before extraction", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await symlink("server.mjs", path.join(runtimeDir, "linked-server.mjs"));
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      "source.ts",
      "linked-server.mjs",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
      })}\n`,
    );

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot,
        },
        capsule: {
          subname: "team-notes",
        },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unsafe entries.",
        hint: "Push again so Sporades can package regular runtime files only.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(capsuleDir, "data")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects archives with unexpected or missing runtime files", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "source.ts"), "throw new Error('source must not upload');\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "source.ts"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unexpected files.",
        hint: "Push again so Sporades can package only runtime files.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects release archives with parent-relative paths", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(dir, "outside.txt"), "must not extract outside release\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json", "../outside.txt"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: false,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release archive contains unsafe paths.",
        hint: "Push again so Sporades can package runtime files without absolute or parent-relative paths.",
      },
    });
    await assert.rejects(stat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper rejects duplicate, normalization-colliding, and bounded-public-tree archive abuse", async (t) => {
  for (const mode of ["absolute", "duplicate", "normalization-collision", "prefix-normalization-collision", "overlong", "oversized", "excess-files", "metadata-over-count", "metadata-over-byte"]) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const fixture = await writeArchiveSecurityFixture(dir, mode);
        const install = await runHostHelper(fixture.request, { cwd: dir });
        assert.equal(install.code, 0, install.stderr);
        const output = JSON.parse(install.stdout);
        assert.equal(output.ok, false, `${mode}: ${install.stdout}`);
        if (mode === "prefix-normalization-collision") assert.equal(output.error.message, "Invalid Hosted Capsule release file list.");
        assert.match(output.error.message, /unsafe paths|unexpected files|duplicate paths|file list|exceeds release bounds|archive exceeds bounds/);
        await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
        await assert.rejects(stat(path.join(fixture.capsuleDir, "data")), { code: "ENOENT" });
      });
    });
  }
});

test("sporades host helper restarts the current release after install when requested", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
        lifecycle: {
          mounts: {
            files: [
              { host: path.join(capsuleDir, "current", "server.mjs"), container: "/app/server.mjs", mode: "ro" },
              { host: path.join(capsuleDir, "current", "client.js"), container: "/app/client.js", mode: "ro" },
              { host: path.join(capsuleDir, "current", "index.html"), container: "/app/index.html", mode: "ro" },
              { host: path.join(capsuleDir, "current", "sporades.json"), container: "/app/sporades.json", mode: "ro" },
            ],
            data: { host: path.join(capsuleDir, "data"), container: "/app/data", mode: "rw" },
          },
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.installed, true);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      (await docker.calls()).map((call) => call.args[0]),
      ["inspect", "stop", "rm", "image", "run", "inspect", "inspect"],
    );
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert.equal(output.data.lifecycle.container.publishedPort.hostPort, 49153);
    assert.equal(output.data.lifecycle.route.upstream, "127.0.0.1:49153");
  });
});

test("sporades host helper starts SSH-enabled Hosted Capsules through the Base startup script", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await mkdir(path.join(runtimeDir, ".sporades", "ssh"), { recursive: true });
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(runtimeDir, ".sporades", "ssh", "authorized_keys"), `${TEST_PUBLIC_KEY}\n`);
    await createTarGz(archivePath, runtimeDir, [
      "server.mjs",
      "public/client.js",
      "public/index.html",
      "sporades.json",
      ".sporades/ssh/authorized_keys",
    ]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const docker = await installFakeDocker(dir);

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json", ".sporades/ssh/authorized_keys"],
          ssh: {
            enabled: true,
            authorizedKeysPath: ".sporades/ssh/authorized_keys",
            keyCount: 1,
            fingerprints: ["SHA256:test"],
          },
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(Object.hasOwn(output.data.lifecycle, "ssh"), false);
    assert.deepEqual(
      output.data.lifecycle.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.access.enabled", "ssh.hosted-capsule.start", "completed"]],
    );
    assert.equal(output.data.lifecycle.auditEvents[0].data.surface, "sporades-host-helper/capsule.release.install");
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.enabled, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.running, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.loopbackOnly, true);
    assert.equal(output.data.lifecycle.auditEvents[0].data.metadata.keyCount, 1);
    assert.deepEqual(output.data.lifecycle.auditEvents[0].data.metadata.fingerprints, ["SHA256:test"]);
    assert.doesNotMatch(JSON.stringify(output.data.lifecycle.auditEvents), /authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);

    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], "10001:10001");
    assert(runCall.args.includes(`${path.join(capsuleDir, "current", ".sporades", "ssh", "authorized_keys")}:/run/sporades/ssh/authorized_keys:ro`));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys"));
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "127.0.0.1::4000");
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.1.0-node22-alpine");
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      "/usr/local/bin/sporades-start",
    ]);

    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.releases[0].source.ssh.enabled, true);
    assert.equal(record.releases[0].source.ssh.keyCount, 1);

    const restart = await runHostHelper(
      {
        action: "capsule.restart",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );
    assert.equal(restart.code, 0, restart.stderr);
    const restartOutput = JSON.parse(restart.stdout);
    assert.deepEqual(
      restartOutput.data.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.access.enabled", "ssh.hosted-capsule.restart", "completed"]],
    );
    assert.equal(restartOutput.data.auditEvents[0].data.surface, "sporades-host-helper/capsule.restart");
  });
});

test("sporades host helper verifies a pushed Hosted Capsule release after restart", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        assert.equal(request.headers["x-sporades-host-probe"], undefined);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<script type="module" src="/assets/app-a1b2.js"></script>');
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            runtime: { ready: true },
            checks: {
              sqlite: { ok: true },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verified",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verified-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: {
            enabled: true,
            health: { runtimeHealthUrl: `http://malicious.localhost:${port}/__sporades/health/runtime` },
          },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 0, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.installed, true);
      assert.equal(output.data.restarted, true);
      assert.equal(output.data.verified, true);
      assert.equal(output.data.release.id, fixture.releaseId);
      assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
      assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
      assert.equal(output.data.verification.state, "verified");
      assert.equal(output.data.verification.health.route.responding, true);
      assert.equal(output.data.verification.health.runtime.ready, true);
      assert.deepEqual(output.data.verification.health.public, {
        url: `http://${fixture.subname}.${fixture.domain}/`,
        path: "/",
        responding: true,
        statusCode: 200,
        html: true,
      });
      assert.equal(install.stdout.includes(probeToken), false);
      const installedPublic = path.join(fixture.capsuleDir, "releases", fixture.releaseId, "public");
      assert.match(await readFile(path.join(installedPublic, "index.html"), "utf8"), /app-a1b2\.js/);
      assert.equal(await readFile(path.join(installedPublic, "assets", "app-a1b2.css"), "utf8"), "body{background:url('./images/logo-a1b2.png')}\n");
      assert.deepEqual(await readFile(path.join(installedPublic, "assets", "images", "logo-a1b2.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      assert.equal(await readFile(path.join(installedPublic, "assets", "fonts", "app-a1b2.woff2"), "utf8"), "wOF2fixture");
      await assert.rejects(stat(path.join(fixture.capsuleDir, "releases", fixture.releaseId, "client.js")), { code: "ENOENT" });
      const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
      assert(runCall.args.includes(`${path.join(fixture.capsuleDir, "current", "public")}:/app/public:ro`));
      assert.equal(runCall.args.some((arg) => arg.endsWith(":/app/client.js:ro") || arg.endsWith(":/app/index.html:ro")), false);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "running");
      assert.equal(release.state, "verified");
      assert.equal(release.current, true);
      assert.equal(release.verificationAttempts.length, 1);
      assert.match(release.verificationAttempts[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(release.failure, null);
    });
  });
});

test("sporades host helper waits for a newly started Capsule route to serve its public tree", async () => {
  await withTempDir(async (dir) => {
    let publicAttempts = 0;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        publicAttempts += 1;
        if (publicAttempts === 1) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("upstream is still starting");
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<script type="module" src="/assets/app-a1b2.js"></script>');
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        data: { runtime: { ready: true }, checks: { sqlite: { ok: true }, fileStorage: { ok: true } } },
        error: null,
      }));
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verify-delayed-public-tree",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verify-delayed-public-tree-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: { enabled: true, healthTimeoutMs: 1000 },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 0, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.data.verification.state, "verified");
      assert.equal(output.data.verification.health.public.statusCode, 200);
      assert.equal(publicAttempts, 2);
    });
  });
});

test("sporades host helper marks verified push failed when the Capsule route does not become healthy", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-route-failure",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const docker = await installFakeDocker(path.join(dir, "verify-route-failure-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          healthTimeoutMs: 25,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.release.id, fixture.releaseId);
    assert.equal(output.data.currentAttemptedRelease.id, fixture.releaseId);
    assert.equal(output.data.previousCurrentRelease.id, fixture.previousReleaseId);
    assert.equal(output.data.verified, false);
    assert.equal(output.data.verification.state, "failed");
    assert.equal(output.data.verification.health.failure, "route-failure");
    assert.equal(output.data.rollbackGuidance.command, `sporades host rollback team-notes ${fixture.previousReleaseId} --host personal`);
    assert.equal(output.error.message, "Hosted Capsule release verification failed.");
    assert.match(output.error.hint, /sporades host rollback team-notes 20260629T120000Z-deadbeef --host personal/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
    assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const release = record.releases.find((entry) => entry.id === fixture.releaseId);
    assert.equal(record.currentRelease.id, fixture.releaseId);
    assert.equal(record.status, "failed");
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Hosted Capsule installed public tree did not respond.");
    assert.equal(release.verificationAttempts.length, 1);
    assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule installed public tree did not respond.");
  });
});

test("sporades host helper applies verification fallback only after the previous release restarts", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-fallback-success",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const previousReleaseDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(path.join(previousReleaseDir, "public", "assets"), { recursive: true });
    await writeFile(path.join(previousReleaseDir, "server.mjs"), "export default 'previous';\n");
    await writeFile(path.join(previousReleaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await writeFile(path.join(previousReleaseDir, "public", "index.html"), '<script type="module" src="/assets/previous-deadbeef.js"></script>\n');
    await writeFile(path.join(previousReleaseDir, "public", "assets", "previous-deadbeef.js"), "console.log('previous complete release');\n");
    const docker = await installFakeDocker(path.join(dir, "verify-fallback-success-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          fallbackToPreviousRelease: true,
          healthTimeoutMs: 25,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.fallback.applied, true);
    assert.equal(output.data.fallback.release.id, fixture.previousReleaseId);
    assert.equal(output.data.fallback.lifecycle.release.id, fixture.previousReleaseId);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), previousReleaseDir);
    assert.match(await readFile(path.join(fixture.capsuleDir, "current", "public", "index.html"), "utf8"), /previous-deadbeef\.js/);
    assert.match(await readFile(path.join(fixture.capsuleDir, "current", "public", "assets", "previous-deadbeef.js"), "utf8"), /previous complete release/);
    await assert.rejects(stat(path.join(fixture.capsuleDir, "current", "public", "assets", "app-a1b2.js")), { code: "ENOENT" });

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const failedRelease = record.releases.find((entry) => entry.id === fixture.releaseId);
    const fallbackRelease = record.releases.find((entry) => entry.id === fixture.previousReleaseId);
    assert.equal(record.currentRelease.id, fixture.previousReleaseId);
    assert.equal(record.status, "running");
    assert.equal(failedRelease.current, false);
    assert.equal(failedRelease.fallbackAttempts.length, 1);
    assert.equal(failedRelease.fallbackAttempts[0].releaseId, fixture.previousReleaseId);
    assert.equal(fallbackRelease.current, true);
  });
});

test("sporades host helper leaves current unchanged when fallback inventory is missing a source map", async () => {
  await withTempDir(async (dir) => {
    const port = await reserveUnusedPort();
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "fallback-missing-map",
      domain: `localhost:${port}`,
      scheme: "http",
    });
    const previousDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    const previousFiles = ["server.mjs", "sporades.json", "public/index.html", "public/assets/previous.js", "public/assets/previous.css", "public/assets/previous.woff2", "public/assets/previous.js.map"];
    for (const file of previousFiles) {
      const target = path.join(previousDir, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${file}\n`);
    }
    const inventory = await Promise.all(previousFiles.map(async (file) => {
      const contents = await readFile(path.join(previousDir, ...file.split("/")));
      return { path: file, size: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
    }));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    record.releases[0].source = { files: previousFiles, fileInventory: inventory };
    await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
    await rm(path.join(previousDir, "public", "assets", "previous.js.map"));
    const docker = await installFakeDocker(path.join(dir, "fallback-missing-map-docker"));

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: { enabled: true, fallbackToPreviousRelease: true, healthTimeoutMs: 25 },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "fallback-failed");
    assert.match(output.data.fallback.error.message, /release files are missing|release inventory changed/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
  });
});

test("sporades host helper keeps failed release current when verification fallback restart fails", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleInstallFixture(dir, {
      rootName: "verify-fallback-restart-failure",
    });
    const previousReleaseDir = path.join(fixture.capsuleDir, "releases", fixture.previousReleaseId);
    await mkdir(previousReleaseDir, { recursive: true });
    await writePublicRuntimeFiles(previousReleaseDir);
    await writeFile(path.join(previousReleaseDir, "server.mjs"), "export default 'previous';\n");
    await writeFile(path.join(previousReleaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    const docker = await installFakeDocker(path.join(dir, "verify-fallback-restart-failure-docker"), {
      env: { FAKE_DOCKER_RUN_STATUSES: "0,1" },
    });

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        release: fixture.release,
        lifecycle: fixture.lifecycle,
        verification: {
          enabled: true,
          fallbackToPreviousRelease: true,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 1, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.fallback.applied, false);
    assert.equal(output.data.fallback.reason, "fallback-restart-failed");
    assert.equal(output.data.fallback.release.id, fixture.previousReleaseId);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));

    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    const failedRelease = record.releases.find((entry) => entry.id === fixture.releaseId);
    const fallbackRelease = record.releases.find((entry) => entry.id === fixture.previousReleaseId);
    assert.equal(record.currentRelease.id, fixture.releaseId);
    assert.equal(record.status, "failed");
    assert.equal(failedRelease.current, true);
    assert.equal(failedRelease.state, "failed");
    assert.equal(failedRelease.fallbackAttempts.length, 1);
    assert.equal(failedRelease.fallbackAttempts[0].releaseId, fixture.previousReleaseId);
    assert.equal(failedRelease.fallbackAttempts[0].failure.message, "Hosted Capsule fallback restart failed.");
    assert.equal(fallbackRelease.current, false);
  });
});

test("sporades host helper marks verified push failed when runtime health checks fail", async () => {
  await withTempDir(async (dir) => {
    let probeToken = null;
    await withHttpServer((request, response) => {
      if (request.url === "/") {
        assert.equal(request.headers["x-sporades-host-probe"], undefined);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<div>installed public tree</div>");
        return;
      }
      assert.equal(request.url, "/__sporades/health/runtime");
      probeToken = request.headers["x-sporades-host-probe"];
      assert.equal(typeof probeToken, "string");
      assert.ok(probeToken.length > 0);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          data: {
            runtime: { ready: false },
            checks: {
              sqlite: { ok: false },
              fileStorage: { ok: true },
            },
          },
          error: null,
        }),
      );
    }, async (port) => {
      const fixture = await writeHostedCapsuleInstallFixture(dir, {
        rootName: "verify-runtime-failure",
        domain: `localhost:${port}`,
        scheme: "http",
      });
      const docker = await installFakeDocker(path.join(dir, "verify-runtime-failure-docker"));

      const install = await runHostHelper(
        {
          action: "capsule.release.install",
          host: { alias: "personal", domain: fixture.domain, scheme: "http", remoteRoot: fixture.remoteRoot },
          capsule: { subname: fixture.subname },
          release: fixture.release,
          lifecycle: fixture.lifecycle,
          verification: { enabled: true },
        },
        { cwd: dir, env: docker.env },
      );

      assert.equal(install.code, 1, install.stderr);
      const output = JSON.parse(install.stdout);
      assert.equal(install.stdout.includes(probeToken), false);
      assert.equal(output.ok, false);
      assert.equal(output.data.verification.health.failure, "sqlite-failure");
      assert.equal(output.data.verification.health.runtime.checks.sqlite.ok, false);
      assert.equal(output.data.rollbackGuidance.previousReleaseId, fixture.previousReleaseId);
      assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.capsuleDir, "releases", fixture.releaseId));
      assert.match(await readFile(fixture.lifecycle.routes.unavailable.routeFile, "utf8"), /respond "Hosted Capsule unavailable" 503/);

      const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
      const release = record.releases.find((entry) => entry.id === fixture.releaseId);
      assert.equal(record.currentRelease.id, fixture.releaseId);
      assert.equal(record.status, "failed");
      assert.equal(release.state, "failed");
      assert.equal(release.failure.message, "Hosted Capsule SQLite health check failed.");
      assert.equal(release.verificationAttempts[0].failure.message, "Hosted Capsule SQLite health check failed.");
    });
  });
});

test("sporades host helper reports push restart failure after installing the release", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const registryBefore = await readFile(registryRecordPath);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(JSON.parse(install.stdout), {
      ok: false,
      data: {
        installed: false,
        restartRequested: true,
        restarted: false,
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
        },
        release: {
          id: "20260630T221500Z-feedface",
          directory: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
          currentLink: path.join(capsuleDir, "current"),
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          serverEnvIncluded: false,
        },
        rollback: { applied: true, previousCurrentRelease: null },
      },
      error: {
        message: "Hosted Capsule restart failed.",
        hint: "Check Docker logs for sporades-capsules-example-dev-team-notes; the route has been returned to the Hosted Capsule unavailable response.",
      },
    });
    await assert.rejects(readlink(path.join(capsuleDir, "current")), { code: "ENOENT" });
    assert.deepEqual(await readFile(registryRecordPath), registryBefore);
    await assert.rejects(lstat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper preserves install metadata when push restart route reload fails", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const incomingDir = path.join(remoteRoot, "incoming");
    const runtimeDir = path.join(dir, "runtime-files");
    const archivePath = path.join(incomingDir, "20260630T221500Z-feedface.tar.gz");
    await mkdir(incomingDir, { recursive: true });
    await writePublicRuntimeFiles(runtimeDir);
    await writeFile(path.join(runtimeDir, "server.mjs"), "export default 'server bundle';\n");
    await writeFile(path.join(runtimeDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    await createTarGz(archivePath, runtimeDir, ["server.mjs", "public/client.js", "public/index.html", "sporades.json"]);
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(registryRecordPath, `${JSON.stringify({ subname: "team-notes", domain: "capsules.example.dev" })}\n`);
    const registryBefore = await readFile(registryRecordPath);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false", FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

    const install = await runHostHelper(
      {
        action: "capsule.release.install",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        release: {
          id: "20260630T221500Z-feedface",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
          remoteArchive: archivePath,
          restart: true,
          serverEnvIncluded: false,
          files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"],
          directories: {
            capsule: capsuleDir,
            releases: path.join(capsuleDir, "releases"),
            release: path.join(capsuleDir, "releases", "20260630T221500Z-feedface"),
            data: path.join(capsuleDir, "data"),
          },
          currentLink: path.join(capsuleDir, "current"),
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(install.code, 0, install.stderr);
    const output = JSON.parse(install.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.installed, false);
    assert.equal(output.data.restartRequested, true);
    assert.equal(output.data.restarted, false);
    assert.equal(output.data.release.id, "20260630T221500Z-feedface");
    assert.deepEqual(output.data.rollback, { applied: true, previousCurrentRelease: null });
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    await assert.rejects(readlink(path.join(capsuleDir, "current")), { code: "ENOENT" });
    assert.deepEqual(await readFile(registryRecordPath), registryBefore);
    await assert.rejects(lstat(path.join(capsuleDir, "releases", "20260630T221500Z-feedface")), { code: "ENOENT" });
  });
});

test("sporades host helper rolls back to a recorded release and preserves persistent Capsule data", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const capsuleDir = path.join(remoteRoot, "hosts", "capsules.example.dev", "capsules", "team-notes");
    const releasesDir = path.join(capsuleDir, "releases");
    const currentReleaseDir = path.join(releasesDir, "20260630T221500Z-feedface");
    const rollbackReleaseDir = path.join(releasesDir, "20260629T120000Z-deadbeef");
    const dataDir = path.join(capsuleDir, "data");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(currentReleaseDir, { recursive: true });
    await mkdir(rollbackReleaseDir, { recursive: true });
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    for (const releaseDir of [currentReleaseDir, rollbackReleaseDir]) {
      await writePublicRuntimeFiles(releaseDir);
      await writeFile(path.join(releaseDir, "server.mjs"), `export default ${JSON.stringify(path.basename(releaseDir))};\n`);
      await writeFile(path.join(releaseDir, "sporades.json"), "{\"name\":\"team-notes\"}\n");
    }
    await symlink(currentReleaseDir, path.join(capsuleDir, "current"));
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "photo.bin"), "uploaded bytes\n");
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [
          {
            id: "20260630T221500Z-feedface",
            createdAt: "2026-06-30T22:15:00.000Z",
            uploadedAt: "2026-06-30T22:15:00.000Z",
            state: "started",
            current: true,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"] },
            startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
          },
          {
            id: "20260629T120000Z-deadbeef",
            createdAt: "2026-06-29T12:00:00.000Z",
            uploadedAt: "2026-06-29T12:00:00.000Z",
            state: "verified",
            current: false,
            source: { hostedUrl: "https://team-notes.capsules.example.dev", files: ["server.mjs", "public/client.js", "public/index.html", "sporades.json"] },
            startAttempts: [],
            verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
          },
        ],
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
        rollback: { releaseId: "20260629T120000Z-deadbeef" },
        lifecycle: {
          remoteRoot,
        },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.rolledBack, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.restarted, true);
    assert.equal(output.data.lifecycle.release.id, "20260629T120000Z-deadbeef");
    assert.equal(await readlink(path.join(capsuleDir, "current")), rollbackReleaseDir);
    assert.equal(await readFile(path.join(dataDir, "data.db"), "utf8"), "sqlite bytes\n");
    assert.equal(await readFile(path.join(dataDir, "uploads", "photo.bin"), "utf8"), "uploaded bytes\n");
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.ok(runCall);
    assert.ok(runCall.args.includes(`${dataDir}:/app/data:rw`));
    const record = JSON.parse(await readFile(registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.deepEqual(
      record.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: false },
        { id: "20260629T120000Z-deadbeef", state: "started", current: true },
      ],
    );
    assert.equal(record.releases[1].startAttempts.length, 1);
  });
});

test("sporades host helper rollback after key rotation uses the retained release manifest fingerprint key", async () => {
  await withTempDir(async (dir) => {
    const currentFingerprint = "fedcba9876543210";
    const rollbackFingerprint = "0123456789abcdef";
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      currentRegistryFingerprint: currentFingerprint,
      sealedReleaseFingerprints: {
        "20260630T221500Z-feedface": currentFingerprint,
        "20260629T120000Z-deadbeef": rollbackFingerprint,
      },
    });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    const runCall = (await docker.calls()).find((call) => call.args[0] === "run");
    assert.ok(runCall);
    assert.ok(
      runCall.args.includes(
        `${path.join(fixture.dataDir, "sealed-server-env", "keys", `${rollbackFingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`,
      ),
    );
    assert.ok(
      !runCall.args.includes(
        `${path.join(fixture.dataDir, "sealed-server-env", "keys", `${currentFingerprint}.private.pem`)}:/app/.sporades/sealed-server-env/server-env.private.pem:ro`,
      ),
    );
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.sealedServerEnv.currentKeyFingerprint, currentFingerprint);
    assert.equal(record.releases.find((release) => release.id === fixture.rollbackReleaseId).source.sealedServerEnv.publicKeyFingerprint, rollbackFingerprint);
  });
});

test("sporades host helper rejects rollback to an unknown release", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: "20260628T120000Z-cafebabe" },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    assert.deepEqual(JSON.parse(rollback.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule release is not recorded.",
        hint: "Run `sporades host releases team-notes --host personal --json` and choose a recorded release ID.",
      },
    });
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});

test("sporades host helper rejects rollback when selected release files are missing", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, {
      missingFiles: ["20260629T120000Z-deadbeef/server.mjs"],
    });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.message, "Hosted Capsule release files are missing.");
    assert.match(output.error.hint, /recorded release cannot be started/);
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), path.join(fixture.releasesDir, fixture.currentReleaseId));
  });
});

test("sporades host helper rejects rollback when recorded nested public assets are missing", async (t) => {
  const missingAssets = [
    "public/assets/app-a1b2.js",
    "public/assets/app-a1b2.css",
    "public/assets/fonts/app-a1b2.woff2",
    "public/assets/app-a1b2.js.map",
  ];
  for (const missingAsset of missingAssets) {
    await t.test(missingAsset, async () => {
      await withTempDir(async (dir) => {
        const fixture = await writeHostedCapsuleInstallFixture(dir, { rootName: `rollback-missing-${path.basename(missingAsset)}`, previousReleaseId: null });
        fixture.release.restart = false;
        const installed = await runHostHelper(
          {
            action: "capsule.release.install",
            host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
            capsule: { subname: fixture.subname },
            release: fixture.release,
          },
          { cwd: dir },
        );
        assert.equal(JSON.parse(installed.stdout).ok, true, installed.stdout);
        const nextId = "20260701T120000Z-cafebabe";
        const nextDir = path.join(fixture.capsuleDir, "releases", nextId);
        await mkdir(path.join(nextDir, "public"), { recursive: true });
        await writeFile(path.join(nextDir, "server.mjs"), "export default {};\n");
        await writeFile(path.join(nextDir, "sporades.json"), "{}\n");
        await writeFile(path.join(nextDir, "public", "index.html"), "<div>next</div>\n");
        await rm(path.join(fixture.capsuleDir, "current"));
        await symlink(nextDir, path.join(fixture.capsuleDir, "current"));
        const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
        record.currentRelease = { id: nextId };
        record.releases.push({ id: nextId, state: "verified", current: true, source: { files: ["server.mjs", "sporades.json", "public/index.html"] } });
        await writeFile(fixture.registryRecordPath, `${JSON.stringify(record)}\n`);
        await rm(path.join(fixture.capsuleDir, "releases", fixture.releaseId, ...missingAsset.split("/")));

        const rollback = await runHostHelper(
          {
            action: "capsule.release.rollback",
            host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
            capsule: { subname: fixture.subname },
            rollback: { releaseId: fixture.releaseId },
          },
          { cwd: dir },
        );

        assert.equal(rollback.code, 0, rollback.stderr);
        const output = JSON.parse(rollback.stdout);
        assert.equal(output.ok, false);
        assert.match(output.error.message, /release files are missing|release inventory changed/);
        assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), nextDir);
      });
    });
  }
});

test("sporades host helper starts a stopped Capsule during rollback", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { status: "stopped" });
    const docker = await installFakeDocker(dir);

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.lifecycle.started, true);
    assert.equal(output.data.lifecycle.release.id, fixture.rollbackReleaseId);
    assert.ok((await docker.calls()).some((call) => call.args[0] === "run"));
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "running");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
  });
});

test("sporades host helper rejects rollback for unregistered Capsules and empty release history", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir, { noReleaseHistory: true, currentReleaseId: null, releaseIds: [] });
    const missing = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: "missing" },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(missing.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule is not registered.",
        hint: "Run `sporades host register missing --host personal` before managing the Hosted Capsule lifecycle.",
      },
    });

    const noHistory = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
      },
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(noHistory.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule has no release history.",
        hint: "Push a release before running `sporades host rollback team-notes <release-id> --host personal`.",
      },
    });
  });
});

test("sporades host helper records failed rollback starts and leaves the route unavailable", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_RUNNING: "false" } });

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Hosted Capsule rollback start failed.");
    assert.match(output.error.hint, new RegExp(`Previous current release was ${fixture.currentReleaseId}`));
    assert.equal(await readlink(path.join(fixture.capsuleDir, "current")), fixture.rollbackReleaseDir);
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.currentRelease.id, fixture.rollbackReleaseId);
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.startAttempts.length, 1);
    assert.equal(release.failure.message, "Hosted Capsule container did not stay running.");
  });
});

test("sporades host helper returns rollback route reload failures to the unavailable route", async () => {
  await withTempDir(async (dir) => {
    const fixture = await writeHostedCapsuleRollbackFixture(dir);
    const docker = await installFakeDocker(dir, { env: { FAKE_DOCKER_CADDY_RELOAD_STATUSES: "1,0" } });

    const rollback = await runHostHelper(
      {
        action: "capsule.release.rollback",
        host: { alias: "personal", domain: fixture.domain, scheme: "https", remoteRoot: fixture.remoteRoot },
        capsule: { subname: fixture.subname },
        rollback: { releaseId: fixture.rollbackReleaseId },
        lifecycle: { remoteRoot: fixture.remoteRoot },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.data.previousCurrentRelease.id, fixture.currentReleaseId);
    assert.equal(output.data.currentRelease.id, fixture.rollbackReleaseId);
    assert.equal(output.error.message, "Failed to apply Hosted Capsule route.");
    const route = await readFile(path.join(fixture.remoteRoot, "caddy", "hosts", fixture.domain, `${fixture.subname}.caddy`), "utf8");
    assert.match(route, /respond "Hosted Capsule unavailable" 503/);
    const record = JSON.parse(await readFile(fixture.registryRecordPath, "utf8"));
    assert.equal(record.status, "failed");
    const release = record.releases.find((entry) => entry.id === fixture.rollbackReleaseId);
    assert.equal(release.state, "failed");
    assert.equal(release.current, true);
    assert.equal(release.failure.message, "Failed to apply Hosted Capsule route.");
  });
});

test("sporades host register leaves local binding untouched when authoritative registration fails", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted Capsule subname is already registered for this Hosted domain.",
    hint: "Choose a different Capsule subname for " + request.host.domain + "."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted Capsule subname is already registered for this Hosted domain.",
        hint: "Choose a different Capsule subname for capsules.example.dev.",
      },
    });
    await assert.rejects(readFile(path.join(projectDir, ".sporades", "remote-binding.json"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host register relies on the Host server for domain-scoped uniqueness", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(stdin);
const statePath = process.env.FAKE_REGISTER_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const key = request.host.domain + "/" + request.capsule.subname;
if (state[key]) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: {
      message: "Hosted Capsule subname is already registered for this Hosted domain.",
      hint: "Choose a different Capsule subname for " + request.host.domain + "."
    }
  }) + "\\n");
  process.exit(0);
}
state[key] = true;
writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    registered: true,
    authoritative: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.registration.hostedUrl,
      remoteCapsuleId: request.registration.remoteCapsuleId
    },
    route: request.registration.route
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    const env = { ...hostEnv(configDir), ...fakeSsh.env, FAKE_REGISTER_STATE: path.join(dir, "register-state.json") };

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await runCli(
          ["host", "add", "work", "--server", "root@example.test", "--domain", "apps.work.test", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );

    const first = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(first.code, 0, first.stderr);

    const duplicate = await runCli(["host", "register", "notes", "--host", "personal", "--json"], { cwd: projectDir, env });
    assert.equal(duplicate.code, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.message, "Hosted Capsule subname is already registered for this Hosted domain.");

    const sameSubnameDifferentDomain = await runCli(["host", "register", "notes", "--host", "work", "--json"], { cwd: projectDir, env });
    assert.equal(sameSubnameDifferentDomain.code, 0, sameSubnameDifferentDomain.stderr);
    assert.equal(JSON.parse(sameSubnameDifferentDomain.stdout).data.binding.remoteCapsuleId, "apps.work.test/notes");
  });
});

test("sporades host register reports bootstrap-required failures with TLS file hints", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Hosted domain has not been bootstrapped.",
    hint: "Run \`" + request.registration.bootstrap.command + "\` after installing readable Cloudflare origin certificate and key files at " + request.registration.bootstrap.tls.certificate + " and " + request.registration.bootstrap.tls.key + "."
  }
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    const addHost = await runCli(
      [
        "host",
        "add",
        "personal",
        "--server",
        "root@example.test",
        "--domain",
        "capsules.example.dev",
        "--remote-root",
        "/opt/sporades",
        "--tls",
        "cloudflare-origin",
        "--json",
      ],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const register = await runCli(["host", "register", "notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(register.code, 1);
    assert.deepEqual(JSON.parse(register.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Hosted domain has not been bootstrapped.",
        hint: "Run `sporades host bootstrap --host personal` after installing readable Cloudflare origin certificate and key files at /opt/sporades/hosts/capsules.example.dev/tls/origin.crt and /opt/sporades/hosts/capsules.example.dev/tls/origin.key.",
      },
    });
  });
});

test("sporades host register validates lowercase DNS-safe non-reserved Capsule subnames before SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "register", "Team_Notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Capsule subname.",
        hint: "Use a lowercase DNS-safe label such as `notes` or `team-notes`.",
      },
    });

    const reserved = await runCli(["host", "register", "www", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(reserved.code, 1);
    assert.deepEqual(JSON.parse(reserved.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Reserved Capsule subname.",
        hint: "Choose a Capsule subname other than www, api, admin, root, or host.",
      },
    });

    await fakeSsh.assertNotCalled();
  });
});

test("sporades host unregister invokes the Hosted Capsule unregister helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.unregister") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.unregister." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    unregistered: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.unregister.hostedUrl,
      remoteCapsuleId: request.unregister.remoteCapsuleId
    },
    deleteAfter: "2026-09-29T12:00:00.000Z",
    route: request.unregister.routes.removed,
    container: request.unregister.container
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const unregister = await runCli(["host", "unregister", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(unregister.code, 0, unregister.stderr);
    const output = JSON.parse(unregister.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.unregistered, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");
    assert.equal(output.data.deleteAfter, "2026-09-29T12:00:00.000Z");

    const plain = await runCli(["host", "unregister", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule unregistered: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.unregister",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      unregister: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
        routes: {
          removed: {
            hostname: "team-notes.capsules.example.dev",
            target: "removed",
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          },
        },
      },
    });
  });
});

test("sporades host delete invokes the Hosted Capsule delete helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.delete") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.delete." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    deleted: true,
    idempotent: false,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.delete.hostedUrl,
      remoteCapsuleId: request.delete.remoteCapsuleId
    },
    registryRecord: {
      path: request.delete.registryRecord,
      removed: true,
      alreadyAbsent: false
    },
    directories: {
      capsule: { path: request.delete.directories.capsule, removed: true, alreadyAbsent: false },
      releases: { path: request.delete.directories.releases, removed: true, alreadyAbsent: false },
      data: { path: request.delete.directories.data, removed: true, alreadyAbsent: false }
    },
    route: {
      path: request.delete.routes.removed.routeFile,
      removed: true,
      alreadyAbsent: false
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const deleted = await runCli(["host", "delete", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(deleted.code, 0, deleted.stderr);
    const output = JSON.parse(deleted.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.error, null);
    assert.equal(output.data.deleted, true);
    assert.equal(output.data.capsule.hostedUrl, "https://team-notes.capsules.example.dev");

    const plain = await runCli(["host", "delete", "team-notes", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "Hosted Capsule storage deleted: https://team-notes.capsules.example.dev\n");

    const calls = await readJsonl(fakeSsh.logPath);
    const request = JSON.parse(calls[0].stdin);
    assert.deepEqual(request, {
      action: "capsule.delete",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      delete: {
        subname: "team-notes",
        domain: "capsules.example.dev",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        registryRecord: "/opt/sporades/hosts/capsules.example.dev/registry/capsules/team-notes.json",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
        },
        routes: {
          removed: {
            hostname: "team-notes.capsules.example.dev",
            target: "removed",
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
          },
        },
      },
    });
  });
});

test("sporades host list works from outside a project and reports an empty registry", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: []
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const list = await runCli(["host", "list", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        capsules: [],
      },
      error: null,
    });

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, "No Hosted Capsules registered for capsules.example.dev.\n");

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host releases lists release history for one Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.list") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.list." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    currentRelease: { id: "20260630T221500Z-feedface" },
    releases: [
      {
        id: "20260630T221500Z-feedface",
        createdAt: "2026-06-30T22:15:00.000Z",
        uploadedAt: "2026-06-30T22:15:00.000Z",
        state: "started",
        current: true,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-30T22:16:00.000Z" }],
        verificationAttempts: [],
        failure: null
      },
      {
        id: "20260629T120000Z-deadbeef",
        createdAt: "2026-06-29T12:00:00.000Z",
        uploadedAt: "2026-06-29T12:00:00.000Z",
        state: "verified",
        current: false,
        source: { hostedUrl: "https://team-notes.capsules.example.dev" },
        startAttempts: [{ startedAt: "2026-06-29T12:01:00.000Z" }],
        verificationAttempts: [{ verifiedAt: "2026-06-29T12:02:00.000Z" }],
        failure: null
      }
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const releases = await runCli(["host", "releases", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(releases.code, 0, releases.stderr);
    const output = JSON.parse(releases.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.currentRelease.id, "20260630T221500Z-feedface");
    assert.deepEqual(
      output.data.releases.map((release) => ({ id: release.id, state: release.state, current: release.current })),
      [
        { id: "20260630T221500Z-feedface", state: "started", current: true },
        { id: "20260629T120000Z-deadbeef", state: "verified", current: false },
      ],
    );

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });
  });
});

test("sporades host rollback invokes the Hosted Capsule rollback helper contract", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.release.rollback") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.release.rollback." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    rolledBack: true,
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes"
    },
    previousCurrentRelease: { id: "20260630T221500Z-feedface" },
    currentRelease: { id: request.rollback.releaseId },
    lifecycle: {
      started: true,
      restarted: true,
      release: { id: request.rollback.releaseId },
      container: { name: "sporades-capsules-example-dev-team-notes", running: true }
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const rollback = await runCli(
      ["host", "rollback", "team-notes", "20260629T120000Z-deadbeef", "--host", "personal", "--json"],
      { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(rollback.code, 0, rollback.stderr);
    const output = JSON.parse(rollback.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.previousCurrentRelease.id, "20260630T221500Z-feedface");
    assert.equal(output.data.currentRelease.id, "20260629T120000Z-deadbeef");
    assert.equal(output.data.lifecycle.started, true);

    const calls = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(calls[0].stdin), {
      action: "capsule.release.rollback",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
      rollback: {
        releaseId: "20260629T120000Z-deadbeef",
      },
      lifecycle: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        currentLink: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current",
        directories: {
          capsule: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes",
          releases: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/releases",
          data: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
          logs: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs",
        },
        mounts: {
          files: [
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/server.mjs", container: "/app/server.mjs", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/public", container: "/app/public", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/sporades.json", container: "/app/sporades.json", mode: "ro" },
            { host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.env.sporades.server", container: "/app/.env.sporades.server", mode: "ro", optional: true },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/current/.sporades/sealed-server-env/server-env.sealed.json",
              container: "/app/.sporades/sealed-server-env/server-env.sealed.json",
              mode: "ro",
              optional: true,
            },
            {
              host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data/sealed-server-env/server-env.private.pem",
              container: "/app/.sporades/sealed-server-env/server-env.private.pem",
              mode: "ro",
              optional: true,
            },
          ],
          data: {
            host: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/data",
            container: "/app/data",
            mode: "rw",
          },
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
          user: "10001:10001",
          baseImage: {
            name: "sporades-base",
            image: "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
            version: "0.1.0-node22-alpine",
            updatePolicy: {
              mode: "host-managed",
              autoPatch: { supported: false, reason: "Base image updates are applied by replacing containers, not mutating them in place." },
            },
          },
          labels: {
            "com.sporades.managed": "true",
            "com.sporades.hosted-domain": "capsules.example.dev",
            "com.sporades.capsule-subname": "team-notes",
            "com.sporades.capsule-id": "capsules.example.dev/team-notes",
            "com.sporades.base-image.name": "sporades-base",
            "com.sporades.base-image.version": "0.1.0-node22-alpine",
            "com.sporades.base-image.update-policy": "host-managed",
          },
        },
        routes: {
          running: {
            hostname: "team-notes.capsules.example.dev",
            target: "container",
            containerName: "sporades-capsules-example-dev-team-notes",
            port: 4000,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
          },
          unavailable: {
            hostname: "team-notes.capsules.example.dev",
            target: "hosted-capsule-unavailable",
            statusCode: 503,
            routeFile: "/opt/sporades/caddy/hosts/capsules.example.dev/team-notes.caddy",
            tls: { mode: "automatic", directory: "/opt/sporades/hosts/capsules.example.dev/tls", certificate: null, key: null },
            log: { file: "/opt/sporades/hosts/capsules.example.dev/capsules/team-notes/logs/http.log" },
          },
        },
      },
    });
  });
});

test("sporades host list combines registry release metadata and fake Docker state", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [
      {
        subname: "drafts",
        hostedUrl: "https://drafts.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/drafts",
          registeredAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "registered"
        },
        currentRelease: null,
        docker: null
      },
      {
        subname: "notes",
        hostedUrl: "https://notes.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/notes",
          registeredAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          status: "released"
        },
        currentRelease: {
          id: "20260104T000000Z",
          createdAt: "2026-01-04T00:00:00.000Z",
          bundleHash: "sha256:abc123"
        },
        docker: {
          containerId: "abc123def456",
          containerName: "sporades-capsules-example-dev-notes",
          state: "running",
          status: "Up 2 hours",
          running: true,
          image: "node:22-alpine"
        }
      },
      {
        subname: "archive",
        hostedUrl: "https://archive.capsules.example.dev",
        registry: {
          remoteCapsuleId: "capsules.example.dev/archive",
          registeredAt: "2026-01-05T00:00:00.000Z",
          updatedAt: "2026-01-06T00:00:00.000Z",
          status: "stopped"
        },
        currentRelease: {
          id: "20260106T000000Z",
          createdAt: "2026-01-06T00:00:00.000Z"
        },
        docker: {
          containerId: "fedcba654321",
          containerName: "sporades-capsules-example-dev-archive",
          state: "exited",
          status: "Exited (0) 3 minutes ago",
          running: false,
          image: "node:22-alpine"
        }
      }
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const data = JSON.parse(list.stdout).data;
    assert.equal(data.capsules.length, 3);
    assert.equal(data.capsules[0].subname, "drafts");
    assert.equal(data.capsules[0].currentRelease, null);
    assert.equal(data.capsules[0].docker, null);
    assert.equal(data.capsules[1].currentRelease.bundleHash, "sha256:abc123");
    assert.equal(data.capsules[1].docker.running, true);
    assert.equal(data.capsules[2].docker.running, false);

    const plain = await runCli(["host", "list", "--host", "personal"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /SUBNAME\s+URL\s+REGISTRY\s+RELEASE\s+DOCKER/);
    assert.match(plain.stdout, /drafts\s+https:\/\/drafts\.capsules\.example\.dev\s+registered\s+none\s+unavailable/);
    assert.match(plain.stdout, /notes\s+https:\/\/notes\.capsules\.example\.dev\s+released\s+20260104T000000Z\s+running \(Up 2 hours\)/);
    assert.match(plain.stdout, /archive\s+https:\/\/archive\.capsules\.example\.dev\s+stopped\s+20260106T000000Z\s+stopped \(Exited \(0\) 3 minutes ago\)/);
  });
});

test("sporades host list trusts the Host server registry over a local project binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    capsules: [{
      subname: "registry-notes",
      hostedUrl: "https://registry-notes.capsules.example.dev",
      registry: {
        remoteCapsuleId: "capsules.example.dev/registry-notes",
        registeredAt: "2026-01-01T00:00:00.000Z",
        status: "registered"
      },
      currentRelease: null,
      docker: null
    }]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".sporades", "remote-binding.json"),
      `${JSON.stringify({
        hostAlias: "personal",
        domain: "wrong.example.dev",
        scheme: "https",
        subname: "local-notes",
        hostedUrl: "https://local-notes.wrong.example.dev",
        remoteCapsuleId: "wrong.example.dev/local-notes",
      })}\n`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );

    const list = await runCli(["host", "list", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(list.code, 0, list.stderr);
    const output = JSON.parse(list.stdout);
    assert.equal(output.data.capsules[0].subname, "registry-notes");
    assert.doesNotMatch(list.stdout, /local-notes/);
    assert.doesNotMatch(list.stdout, /wrong\.example\.dev/);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.list",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host ssh uses the local remote binding and reports helper SSH inspection JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.ssh") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.ssh." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: "https://" + request.capsule.subname + "." + request.host.domain,
      remoteCapsuleId: request.host.domain + "/" + request.capsule.subname
    },
    enabled: true,
    running: true,
    user: "sporades",
    host: "127.0.0.1",
    port: 49162,
    targetPort: 22,
    keyCount: 1,
    fingerprints: ["SHA256:test"],
    reason: null
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );
    const createResult = await runCli(["create", "ssh-bound-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "ssh-bound-island");
    await installFakeReact(projectDir);

    const env = { ...hostEnv(configDir), ...fakeSsh.env };
    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: projectDir, env },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], { cwd: projectDir, env })).code, 0);

    const ssh = await runCli(["host", "ssh", "--json"], { cwd: projectDir, env });
    assert.equal(ssh.code, 0, ssh.stderr);
    const output = JSON.parse(ssh.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.enabled, true);
    assert.equal(output.data.running, true);
    assert.equal(output.data.user, "sporades");
    assert.equal(output.data.host, "127.0.0.1");
    assert.equal(output.data.port, 49162);
    assert.equal(output.data.targetPort, 22);
    assert.equal(output.data.keyCount, 1);
    assert.deepEqual(output.data.fingerprints, ["SHA256:test"]);
    assert.equal(output.data.reason, null);

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.ssh",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: {
        subname: "team-notes",
      },
    });
  });
});

test("sporades host helper inspects effective Hosted Capsule SSH state from Docker", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [{
          id: "20260630T221500Z-feedface",
          state: "started",
          current: true,
          source: {
            ssh: {
              enabled: true,
              authorizedKeysPath: ".sporades/ssh/authorized_keys",
              keyCount: 1,
              fingerprints: ["SHA256:test"]
            }
          }
        }]
      })}\n`,
    );
    const docker = await installFakeDocker(dir, {
      env: {
        FAKE_DOCKER_INSPECT_JSON: JSON.stringify({
          State: { Running: true },
          Config: { User: "10001:10001" },
          NetworkSettings: {
            Ports: {
              "22/tcp": [
                { HostIp: "127.0.0.1", HostPort: "49162" },
              ],
            },
          },
        }),
      },
    });

    const result = await runHostHelper(
      {
        action: "capsule.ssh",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.data.capsule, {
      subname: "team-notes",
      domain: "capsules.example.dev",
      hostedUrl: "https://team-notes.capsules.example.dev",
      remoteCapsuleId: "capsules.example.dev/team-notes",
    });
    assert.equal(output.data.enabled, true);
    assert.equal(output.data.running, true);
    assert.equal(output.data.user, "sporades");
    assert.equal(output.data.host, "127.0.0.1");
    assert.equal(output.data.port, 49162);
    assert.equal(output.data.targetPort, 22);
    assert.equal(output.data.keyCount, 1);
    assert.deepEqual(output.data.fingerprints, ["SHA256:test"]);
    assert.equal(output.data.reason, null);
    assert.deepEqual(
      output.data.auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [["ssh.state.inspected", "ssh.hosted-capsule.inspect", "completed"]],
    );
    assert.equal(output.data.auditEvents[0].data.surface, "sporades-host-helper/capsule.ssh");
    assert.equal(output.data.auditEvents[0].data.metadata.enabled, true);
    assert.equal(output.data.auditEvents[0].data.metadata.running, true);
    assert.equal(output.data.auditEvents[0].data.metadata.loopbackOnly, true);
    assert.equal(output.data.auditEvents[0].data.metadata.port, 49162);
    assert.deepEqual(output.data.auditEvents[0].data.metadata.fingerprints, ["SHA256:test"]);
    assert.doesNotMatch(JSON.stringify(output.data.auditEvents), /authorized_keys|ssh-ed25519|AAAAC3NzaC1lZDI1NTE5/);
    assert.deepEqual((await docker.calls()).map((call) => call.args), [
      ["inspect", "--format", "{{json .}}", "sporades-capsules-example-dev-team-notes"],
    ]);
  });
});

test("sporades host helper reports disabled SSH without inspecting Docker when no keys are configured", async () => {
  await withTempDir(async (dir) => {
    const remoteRoot = path.join(dir, "remote-root");
    const registryRecordPath = path.join(remoteRoot, "hosts", "capsules.example.dev", "registry", "capsules", "team-notes.json");
    await mkdir(path.dirname(registryRecordPath), { recursive: true });
    await writeFile(
      registryRecordPath,
      `${JSON.stringify({
        subname: "team-notes",
        domain: "capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        status: "running",
        currentRelease: { id: "20260630T221500Z-feedface" },
        releases: [{
          id: "20260630T221500Z-feedface",
          state: "started",
          current: true,
          source: {}
        }]
      })}\n`,
    );
    const docker = await installFakeDocker(dir);

    const result = await runHostHelper(
      {
        action: "capsule.ssh",
        host: { alias: "personal", domain: "capsules.example.dev", scheme: "https", remoteRoot },
        capsule: { subname: "team-notes" },
      },
      { cwd: dir, env: docker.env },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.enabled, false);
    assert.equal(output.data.running, false);
    assert.equal(output.data.reason, "no-authorized-keys");
    await assert.rejects(readFile(docker.logPath, "utf8"), { code: "ENOENT" });
  });
});

test("sporades host stats resolves a Hosted Capsule and returns normalized Docker stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "capsule.stats") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use capsule.stats." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    capsule: {
      subname: request.capsule.subname,
      domain: request.host.domain,
      hostedUrl: request.stats.hostedUrl,
      remoteCapsuleId: request.stats.remoteCapsuleId
    },
    container: {
      name: request.stats.container.name,
      running: true
    },
    stats: {
      cpuPercent: 3.14,
      memoryUsageBytes: 104857600,
      memoryLimitBytes: 536870912,
      memoryPercent: 19.53,
      networkInputBytes: 2048,
      networkOutputBytes: 4096,
      blockInputBytes: 8192,
      blockOutputBytes: 16384,
      pids: 7
    },
    lifecycle: {
      registered: true,
      registryStatus: "running",
      running: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSeconds: 7200,
      restartCount: 1,
      currentReleaseId: "20260101T000000Z-abcdef12",
      routeTarget: "container"
    },
    raw: {
      Name: "sporades-capsules-example-dev-team-notes",
      CPUPerc: "3.14%",
      MemUsage: "100MiB / 512MiB",
      MemPerc: "19.53%",
      NetIO: "2kB / 4kB",
      BlockIO: "8kB / 16kB",
      PIDs: "7"
    }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "team-notes", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        capsule: {
          subname: "team-notes",
          domain: "capsules.example.dev",
          hostedUrl: "https://team-notes.capsules.example.dev",
          remoteCapsuleId: "capsules.example.dev/team-notes",
        },
        container: {
          name: "sporades-capsules-example-dev-team-notes",
          running: true,
        },
        stats: {
          cpuPercent: 3.14,
          memoryUsageBytes: 104857600,
          memoryLimitBytes: 536870912,
          memoryPercent: 19.53,
          networkInputBytes: 2048,
          networkOutputBytes: 4096,
          blockInputBytes: 8192,
          blockOutputBytes: 16384,
          pids: 7,
        },
        lifecycle: {
          registered: true,
          registryStatus: "running",
          running: true,
          startedAt: "2026-01-01T00:00:00.000Z",
          uptimeSeconds: 7200,
          restartCount: 1,
          currentReleaseId: "20260101T000000Z-abcdef12",
          routeTarget: "container",
        },
        raw: {
          Name: "sporades-capsules-example-dev-team-notes",
          CPUPerc: "3.14%",
          MemUsage: "100MiB / 512MiB",
          MemPerc: "19.53%",
          NetIO: "2kB / 4kB",
          BlockIO: "8kB / 16kB",
          PIDs: "7",
        },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "capsule.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: { subname: "team-notes" },
      stats: {
        domain: "capsules.example.dev",
        subname: "team-notes",
        hostedUrl: "https://team-notes.capsules.example.dev",
        remoteCapsuleId: "capsules.example.dev/team-notes",
        container: {
          name: "sporades-capsules-example-dev-team-notes",
        },
      },
    });
  });
});

test("sporades host stats without a subname resolves the selected Host profile and returns Host server stats as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.stats" || request.capsule !== null) {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected action.", hint: "Use host.stats without a Capsule." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    host: request.host,
    resources: {
      disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
      memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
      load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 }
    },
    services: { docker: { available: true }, caddy: { available: true } },
    capsules: { total: 2, registered: 1, running: 1, stopped: 0 }
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    assert.equal(
      (
        await runCli(
          ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
          { cwd: dir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
        )
      ).code,
      0,
    );
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: dir, env: hostEnv(configDir) })).code, 0);

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: true,
      data: {
        host: {
          alias: "personal",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
        },
        resources: {
          disk: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
          memory: { totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 },
          load: { oneMinute: 0.1, fiveMinutes: 0.2, fifteenMinutes: 0.3 },
        },
        services: { docker: { available: true }, caddy: { available: true } },
        capsules: { total: 2, registered: 1, running: 1, stopped: 0 },
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.stats",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
    });
  });
});

test("sporades host current reports effective Hosted security policy without contacting the Host server", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await writeHostProfileConfig(configDir, {
      currentHostAlias: "personal",
      profiles: {
        personal: {
          server: "root@example.test",
          domain: "capsules.example.dev",
          scheme: "https",
          remoteRoot: "/opt/sporades",
          tls: { mode: "automatic" },
        },
      },
    });
    await writeFile(
      path.join(dir, "sporades.json"),
      `${JSON.stringify(
        {
          name: "hosted-security-island",
          client: { framework: "react" },
          security: {
            cors: { allowedOrigins: ["https://dashboard.example.test"] },
            csp: { mode: "enforce" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const fakeSsh = await installFakeSsh(dir);

    const current = await runCli(["host", "current", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(current.code, 0, current.stderr);
    const body = JSON.parse(current.stdout);
    assert.equal(body.data.alias, "personal");
    assert.equal(body.data.security.csp.header, "content-security-policy");
    assert.deepEqual(body.data.security.cors.allowedOrigins, ["https://dashboard.example.test"]);
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host stats without a Host profile reports a structured JSON failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    const stats = await runCli(["host", "stats", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });

    assert.equal(stats.code, 1);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "No current Host profile selected.",
        hint: "Run `sporades host use <alias>` or pass `--host <alias>`.",
      },
    });
  });
});

test("sporades host stats help text shows the optional Capsule subname form", async () => {
  await withTempDir(async (dir) => {
    const stats = await runCli(["host", "stats", "one", "two", "--json"], { cwd: dir });

    assert.equal(stats.code, 1);
    assert.deepEqual(JSON.parse(stats.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Too many positional arguments.",
        hint: "Use `sporades host stats [subname] --host <alias>`.",
      },
    });
  });
});

test("sporades host stats handles SSH failure and remote helper failure as structured JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
        { cwd: dir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
    };

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    await addHost(transportFailureSsh.env);
    const transportFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Failed to read Hosted Capsule Docker stats.",
    hint: "Check Docker on the Host server and retry \`sporades host stats team-notes --host personal\`."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "stats", "team-notes", "--host", "personal", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Failed to read Hosted Capsule Docker stats.",
        hint: "Check Docker on the Host server and retry `sporades host stats team-notes --host personal`.",
      },
    });
  });
});

test("sporades host logs retrieves default HTTP log lines as JSON", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
if (request.action !== "host.logs" || request.logs?.source !== "http") {
  process.stdout.write(JSON.stringify({
    ok: false,
    data: null,
    error: { message: "Unexpected log request.", hint: "Use host.logs for Caddy combined logs." }
  }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines ?? 200,
    source: request.logs.source,
    entries: ["203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] \\"GET / HTTP/1.1\\" 200 12"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    assert.equal((await runCli(["host", "use", "personal", "--json"], { cwd: projectDir, env: hostEnv(configDir) })).code, 0);

    const logs = await runCli(["host", "logs", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout), {
      ok: true,
      data: {
        lineCount: 200,
        source: "http",
        entries: ['203.0.113.9 - - [01/Jan/2026:00:00:01 +0000] "GET / HTTP/1.1" 200 12'],
      },
      error: null,
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.deepEqual(sshCall.args, ["root@example.test", "/opt/sporades/bin/sporades-host-helper"]);
    assert.deepEqual(JSON.parse(sshCall.stdin), {
      action: "host.logs",
      host: {
        alias: "personal",
        domain: "capsules.example.dev",
        scheme: "https",
        remoteRoot: "/opt/sporades",
      },
      capsule: null,
      logs: {
        source: "http",
      },
    });
  });
});

test("sporades host logs prints only recent HTTP log lines in plain output", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    entries: [
      "198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] \\"GET /one HTTP/1.1\\" 200 10",
      "198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] \\"GET /two HTTP/1.1\\" 404 0"
    ]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "work", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const logs = await runCli(["host", "logs", "http", "--host", "work", "-n", "2"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.equal(
      logs.stdout,
      '198.51.100.4 - - [01/Jan/2026:00:00:02 +0000] "GET /one HTTP/1.1" 200 10\n198.51.100.4 - - [01/Jan/2026:00:00:03 +0000] "GET /two HTTP/1.1" 404 0\n',
    );

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.lines, 2);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
  });
});

test("sporades host logs can request HTTP logs for one Hosted Capsule", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    source: request.logs.source,
    entries: [request.capsule.subname + " http"]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);

    const logs = await runCli(["host", "logs", "http", "--host", "personal", "--subname", "team-notes", "-n", "4", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(logs.code, 0, logs.stderr);
    assert.deepEqual(JSON.parse(logs.stdout).data, {
      lineCount: 4,
      source: "http",
      entries: ["team-notes http"],
    });

    const [sshCall] = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(sshCall.stdin).logs.source, "http");
    assert.equal(JSON.parse(sshCall.stdin).capsule.subname, "team-notes");
  });
});

test("sporades host logs requests capsule stdout and stderr using a Hosted Capsule binding", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installContractFakeSsh(
      dir,
      `const request = JSON.parse(stdin);
process.stdout.write(JSON.stringify({
  ok: true,
  data: {
    lineCount: request.logs.lines,
    source: request.logs.source,
    container: "sporades-capsules-example-dev-team-notes",
    entries: [request.logs.source + " one", request.capsule.subname]
  },
  error: null
}) + "\\n");
process.exit(0);
`,
    );

    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = await runCli(
      ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--remote-root", "/opt/sporades", "--json"],
      { cwd: projectDir, env: { ...hostEnv(configDir), ...fakeSsh.env } },
    );
    assert.equal(addHost.code, 0, addHost.stderr);
    const bind = await runCli(["host", "bind", "team-notes", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: hostEnv(configDir),
    });
    assert.equal(bind.code, 0, bind.stderr);

    const stdout = await runCli(["host", "logs", "stdout", "-n", "7", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stdout.code, 0, stdout.stderr);
    assert.deepEqual(JSON.parse(stdout.stdout).data, {
      lineCount: 7,
      source: "stdout",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stdout one", "team-notes"],
    });

    const stderr = await runCli(["host", "logs", "stderr", "--host", "personal", "--subname", "team-notes", "--lines", "3", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(stderr.code, 0, stderr.stderr);
    assert.deepEqual(JSON.parse(stderr.stdout).data, {
      lineCount: 3,
      source: "stderr",
      container: "sporades-capsules-example-dev-team-notes",
      entries: ["stderr one", "team-notes"],
    });

    const calls = await readJsonl(fakeSsh.logPath);
    assert.equal(JSON.parse(calls[0].stdin).logs.source, "stdout");
    assert.equal(JSON.parse(calls[0].stdin).capsule.subname, "team-notes");
    assert.equal(JSON.parse(calls[1].stdin).logs.source, "stderr");
    assert.equal(JSON.parse(calls[1].stdin).capsule.subname, "team-notes");
  });
});

test("sporades host logs validates invalid line counts without calling SSH", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const fakeSsh = await installFakeSsh(dir);

    const invalid = await runCli(["host", "logs", "--lines", "0", "--json"], {
      cwd: dir,
      env: { ...hostEnv(configDir), ...fakeSsh.env },
    });
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host log line count.",
        hint: "Pass `--lines <n>` with a whole number between 1 and 10000.",
      },
    });
    await fakeSsh.assertNotCalled();
  });
});

test("sporades host logs handles empty logs, SSH failure, and remote helper failure", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = path.join(dir, "todo-island");

    const addHost = async (env) => {
      const result = await runCli(
        ["host", "add", "personal", "--server", "root@example.test", "--domain", "capsules.example.dev", "--json"],
        { cwd: projectDir, env: { ...hostEnv(configDir), ...env } },
      );
      assert.equal(result.code, 0, result.stderr);
    };

    const emptyLogsSsh = await installContractFakeSsh(
      path.join(dir, "empty-logs"),
      `process.stdout.write(JSON.stringify({ ok: true, data: { lineCount: JSON.parse(stdin).logs.lines, entries: [] }, error: null }) + "\\n");
process.exit(0);
`,
    );
    await addHost(emptyLogsSsh.env);
    const emptyLogs = await runCli(["host", "logs", "--host", "personal"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...emptyLogsSsh.env },
    });
    assert.equal(emptyLogs.code, 0, emptyLogs.stderr);
    assert.equal(emptyLogs.stdout, "");

    const transportFailureSsh = await installContractFakeSsh(
      path.join(dir, "transport-failure"),
      `process.stderr.write("ssh: connect to host example.test port 22: Operation timed out\\n");
process.exit(255);
`,
    );
    const transportFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...transportFailureSsh.env },
    });
    assert.equal(transportFailure.code, 1);
    assert.deepEqual(JSON.parse(transportFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "SSH transport failed.",
        hint: "Check the Host profile SSH target, network connectivity, and SSH key access.",
      },
    });

    const helperFailureSsh = await installContractFakeSsh(
      path.join(dir, "helper-failure"),
      `process.stdout.write(JSON.stringify({
  ok: false,
  data: null,
  error: {
    message: "Host server Caddy combined logs are unavailable.",
    hint: "Run \`sporades host bootstrap --host personal\` and check Caddy on the Host server."
  }
}) + "\\n");
process.exit(0);
`,
    );
    const helperFailure = await runCli(["host", "logs", "--host", "personal", "--json"], {
      cwd: projectDir,
      env: { ...hostEnv(configDir), ...helperFailureSsh.env },
    });
    assert.equal(helperFailure.code, 1);
    assert.deepEqual(JSON.parse(helperFailure.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Host server Caddy combined logs are unavailable.",
        hint: "Run `sporades host bootstrap --host personal` and check Caddy on the Host server.",
      },
    });
  });
});

test("sporades host github workflow write dry-runs an inspectable autodeploy workflow", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.file, ".github/workflows/sporades-autodeploy.yml");
    assert.equal(output.data.written, false);
    assert.match(output.data.workflow, /branches: \["main"\]/);
    assert.match(output.data.workflow, /node-version: 22/);
    assert.match(output.data.workflow, /npm ci/);
    assert.match(output.data.workflow, /npm install/);
    assert.match(output.data.workflow, /npm test/);
    assert.match(output.data.workflow, /SPORADES_HOST_ALIAS: personal/);
    assert.match(output.data.workflow, /SPORADES_HOST_SUBNAME: team-notes/);
    assert.match(output.data.workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.match(output.data.workflow, /vars\.SPORADES_HOST_SERVER/);
    assert.match(output.data.workflow, /npx sporades host current --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host health --host "\$SPORADES_HOST_ALIAS" --json/);
    assert.match(output.data.workflow, /npx sporades host push --host "\$SPORADES_HOST_ALIAS" --subname "\$SPORADES_HOST_SUBNAME" --verify --json/);
    assert.deepEqual(output.data.github.secrets, ["SPORADES_HOST_SSH_PRIVATE_KEY"]);
    assert.deepEqual(output.data.github.variables, [
      "SPORADES_HOST_SERVER",
      "SPORADES_HOST_DOMAIN",
      "SPORADES_HOST_REMOTE_ROOT",
    ]);
    await assert.rejects(readFile(path.join(dir, ".github", "workflows", "sporades-autodeploy.yml"), "utf8"), { code: "ENOENT" });
  });
});

test("sporades host github workflow reports successful deploys to GitHub summaries", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY: \$\{\{ runner\.temp \}\}\/sporades-autodeploy-summary\.md/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /Hosted Capsule/);
    assert.match(workflow, /Release ID/);
    assert.match(workflow, /Verification/);
    assert.match(workflow, /data\.capsule\?\.hostedUrl/);
    assert.match(workflow, /data\.release\?\.id/);
    assert.match(workflow, /verification\?\.state/);
  });
});

test("sporades host github workflow reports verification failures without automatic rollback", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Verification failed/);
    assert.match(workflow, /rollbackGuidance\?\.command/);
    assert.match(workflow, /previousCurrentRelease\?\.id/);
    assert.match(workflow, /sporades host rollback/);
    assert.match(workflow, /Sporades did not roll back automatically/);
    assert.doesNotMatch(workflow, /npx sporades host rollback/);
  });
});

test("sporades host github workflow reports command failures without exposing sensitive values", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /Command failed/);
    assert.match(workflow, /No structured Sporades deploy output was available/);
    assert.match(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY/);
    assert.doesNotMatch(workflow, /secrets\.SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*>>/);
    assert.doesNotMatch(workflow, /SPORADES_HOST_SSH_PRIVATE_KEY[^\n]*GITHUB_STEP_SUMMARY/);
    assert.doesNotMatch(workflow, /session token/i);
    assert.doesNotMatch(workflow, /Server env values/);
  });
});

test("sporades host github workflow associates pull request deploy results", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "main", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /pull_request:\n    branches: \["main"\]/);
    assert.match(workflow, /pull-requests: write/);
    assert.match(workflow, /if: always\(\) && github\.event_name == 'pull_request'/);
    assert.match(workflow, /actions\/github-script@v7/);
    assert.match(workflow, /github\.rest\.pulls\.createReview/);
    assert.match(workflow, /pull_number: context\.payload\.pull_request\.number/);
    assert.match(workflow, /SPORADES_AUTODEPLOY_SUMMARY/);
  });
});

test("sporades host github workflow associates branch push deploy results with the workflow run summary", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(
      ["host", "github", "workflow", "write", "--host", "personal", "--subname", "team-notes", "--branch", "release/stable", "--dry-run", "--json"],
      { cwd: dir },
    );

    assert.equal(result.code, 0, result.stderr);
    const workflow = JSON.parse(result.stdout).data.workflow;
    assert.match(workflow, /push:\n    branches: \["release\/stable"\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /fs\.appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /fs\.writeFileSync\(process\.env\.SPORADES_AUTODEPLOY_SUMMARY/);
  });
});

test("sporades host github workflow write writes a workflow and refuses accidental overwrite", async () => {
  await withTempDir(async (dir) => {
    const file = ".github/workflows/custom-sporades.yml";
    const first = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "feat,main", "--file", file, "--json"],
      { cwd: dir },
    );

    assert.equal(first.code, 0, first.stderr);
    const firstOutput = JSON.parse(first.stdout);
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.data.file, file);
    assert.equal(firstOutput.data.written, true);

    const workflowPath = path.join(dir, file);
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /branches: \["feat,main"\]/);
    assert.match(workflow, /SPORADES_HOST_ALIAS: work/);
    assert.match(workflow, /SPORADES_HOST_SUBNAME: field-notes/);

    const second = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "release/stable", "--file", file, "--json"],
      { cwd: dir },
    );
    assert.equal(second.code, 1);
    assert.deepEqual(JSON.parse(second.stdout), {
      ok: false,
      data: null,
      error: {
        message: "GitHub Actions workflow already exists.",
        hint: "Pass `--force` to overwrite it, or choose another path with `--file <path>`.",
      },
    });

    const forced = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--branch", "main", "--file", file, "--force", "--json"],
      { cwd: dir },
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(workflowPath, "utf8"), /branches: \["main"\]/);

    const outsideProject = await runCli(
      ["host", "github", "workflow", "write", "--host", "work", "--subname", "field-notes", "--file", "../outside.yml", "--json"],
      { cwd: dir },
    );
    assert.equal(outsideProject.code, 1);
    assert.deepEqual(JSON.parse(outsideProject.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid GitHub workflow file path.",
        hint: "Pass a relative path inside the project, such as `.github/workflows/sporades-autodeploy.yml`.",
      },
    });
  });
});

test("sporades host validation returns standard JSON errors", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "machine-config");
    await mkdir(configDir, { recursive: true });

    const missingAlias = await runCli(["host", "add", "--server", "root@example.com", "--domain", "example.com", "--json"], {
      cwd: dir,
      env: hostEnv(configDir),
    });
    assert.equal(missingAlias.code, 1);
    assert.deepEqual(JSON.parse(missingAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Missing Host profile alias.",
        hint: "Use `sporades host add <alias> --server <ssh-target> --domain <hosted-domain>`.",
      },
    });

    const invalidDomain = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "bad_domain", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidDomain.code, 1);
    assert.deepEqual(JSON.parse(invalidDomain.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Hosted domain.",
        hint: "Pass a DNS domain such as `example.com` without a scheme, path, or wildcard.",
      },
    });

    const invalidRemoteRoot = await runCli(
      ["host", "add", "bad", "--server", "root@example.com", "--domain", "example.com", "--remote-root", "relative/path", "--json"],
      { cwd: dir, env: hostEnv(configDir) },
    );
    assert.equal(invalidRemoteRoot.code, 1);
    assert.deepEqual(JSON.parse(invalidRemoteRoot.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Invalid Host remote root.",
        hint: "Pass an absolute POSIX path such as `/srv/sporades`.",
      },
    });

    const unknownAlias = await runCli(["host", "use", "missing", "--json"], { cwd: dir, env: hostEnv(configDir) });
    assert.equal(unknownAlias.code, 1);
    assert.deepEqual(JSON.parse(unknownAlias.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unknown Host profile alias: missing",
        hint: "Add it with `sporades host add missing --server <ssh-target> --domain <hosted-domain>`.",
      },
    });
  });
});

test("host profile implementation does not hard-code the first Hosted domain", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /mattgscox\.co\.uk/);
});
