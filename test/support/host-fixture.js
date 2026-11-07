import { createHostFixture, hostFixtureConfig, removeHostFixture } from "./host-fixture-root.js";
import { withFixtureUmask } from "./fixture-umask.js";
import { preservedDeployFilePath } from "../../dist/deploy-files.js";
import assert from "node:assert/strict";
import { chmod, chown, copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

import { createWebSocketHub, openDevDatabase, prepareHttpSecurity, routeConnectionToken, routeRuntimeHealth } from "../../dist/server-runtime-source.js";
import { CLIENT_CAPABILITIES, CLIENT_TEMPLATES } from "../../dist/client-capabilities.js";
import { validateReleaseArchive } from "../../dist/cli/host-helper-archive.js";
import { createHostLifecycleRequest, createHostReleaseRequest } from "../../dist/cli/host-request-builders.js";
import { installProjectVueToolchain } from "./project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./project-solid-toolchain.js";
import { installProjectLitToolchain } from "./project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./project-inferno-toolchain.js";
import { installPrerenderFixture } from "./prerender-capsule.js";
import { createBundle } from "../../dist/bundle-pipeline.js";
import { summarizePublicTree } from "../../dist/public-tree.js";
import { routeHttpAdmission, routeWebSocketAdmission } from "../../dist/http-runtime.js";
import { parseAdmissionPolicy } from "../../dist/admission-policy.js";
import { trustedClientAddress } from "../../dist/client-address.js";
import { ADMISSION_INSPECTION_SCRIPT } from "../../dist/cli/admission-inspection.js";
import { installPrerenderWarnings, assertPrerenderWarnings } from "./prerender-warnings.js";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const cliPath = path.join(repoRoot, "bin", "sporades.js");

const hostHelperPath = path.join(repoRoot, "bin", "sporades-host-helper.js");

const rootPackageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const TEST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDI9R+ElI6awrzqT1DDZjMa6q7iH+jF5bughycSLBOa/ test@example";

const TEST_WEBSOCKET_TIMEOUT_MS = 10000;


// Host helper unit fixtures must never fall through to the workstation's engine
// or systemd. Docker-capable workers may have a loaded real Docker service.
// Tests requiring Docker state prepend their explicit installFakeDocker fixture.
const workstationPath = process.env.PATH;

let unavailableDockerDirectory;

before(async () => {
  unavailableDockerDirectory = await mkdtemp(path.join(tmpdir(), "sporades-host-no-docker-"));
  await writeFile(path.join(unavailableDockerDirectory, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(path.join(unavailableDockerDirectory, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.PATH = `${unavailableDockerDirectory}${path.delimiter}${workstationPath}`;
});

after(async () => {
  process.env.PATH = workstationPath;
  await rm(unavailableDockerDirectory, { recursive: true, force: true });
});


function buildHostLifecycle(remoteRoot, domain, subname, scheme = "https") {
  return createHostLifecycleRequest(
    "personal",
    { domain, scheme, remoteRoot, tls: "automatic" },
    subname,
    { updatePolicyMode: "manual" },
  );
}


async function withTempDir(fn, options = {}) {
  const dir = await createHostFixture("sporades-host-", options);
  try {
    return await withFixtureUmask(() => fn(dir));
  } finally {
    await removeHostFixture(dir);
  }
}


async function withHttpServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
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
    if (routeConnectionToken(request, response, (current) => websocketHub.createConnectionToken(current))) return;
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
    detached: options.detached === true,
    env: {
      ...process.env,
      SPORADES_TEST_ALLOW_RUNTIME_DATA_OWNER_FALLBACK: "1",
      SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, "test", "support", "exec-flock.py"),
      ...options.env,
      ...(options.env?.FAKE_HOST_ROUTE_PROBE_PRELOAD ? { NODE_OPTIONS: `${options.env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ""} --import=${options.env.FAKE_HOST_ROUTE_PROBE_PRELOAD}` } : {}),
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
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
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


async function waitForFileText(filePath, predicate, timeoutMs = 2000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const contents = await readFile(filePath, "utf8");
      if (predicate(contents)) return contents;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!signal?.aborted) assert.fail(`Timed out waiting for expected contents in ${filePath}`);
}


async function waitForHostHelperMarker(action, filePath, predicate, timeoutMs = 15_000) {
  // Key generation and Docker quiescing can exceed two seconds under suite load.
  // Keep startup bounded, but fail immediately if the helper cannot reach the boundary.
  const controller = new AbortController();
  try {
    return await Promise.race([
      waitForFileText(filePath, predicate, timeoutMs, controller.signal),
      action.result.then(({ code, signal, stdout, stderr }) => {
        assert.fail(`Host helper exited before marker ${filePath} (code=${code}, signal=${signal ?? "none"})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}


async function stopHostHelper(action) {
  // These fixtures own a detached group, including the spawnSync/flock action.
  // Killing only the launcher would let its locked child mutate deleted fixtures.
  try { process.kill(-action.child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  await action.result;
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


async function prepareFakeBin(fakeBinDir) {
  await mkdir(fakeBinDir, { recursive: true });
  // Node fixtures use require independently of the surrounding project module mode.
  await writeFile(path.join(fakeBinDir, "package.json"), '{"type":"commonjs"}\n');
}


async function installFakeSsh(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "ssh-calls.jsonl");
  const sshPath = path.join(fakeBinDir, "ssh");
  await prepareFakeBin(fakeBinDir);
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
  await prepareFakeBin(fakeBinDir);
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
  await prepareFakeBin(fakeBinDir);
  await prepareFakeBin(fakeRemoteDir);
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
  await prepareFakeBin(fakeBinDir);
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
  await prepareFakeBin(fakeBinDir);
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_DOCKER_RECOVERY_CONTAINERS && args[0] === 'inspect') {
  const all = JSON.parse(require('node:fs').readFileSync(process.env.FAKE_DOCKER_RECOVERY_CONTAINERS, 'utf8'));
  const container = all[args.at(-1)] || Object.values(all).find(c => c.Id === args.at(-1));
  if (!container) process.exit(1);
  if (args.includes('{{json .}}')) process.stdout.write(JSON.stringify(container));
  else if (args.includes('{{.State.Running}}')) process.stdout.write(String(container.State.Running));
  else process.stdout.write(container.port);
  process.exit(0);
}
if (process.env.FAKE_DOCKER_BACKUP_STATE) {
  const fs = require('node:fs'), file = process.env.FAKE_DOCKER_BACKUP_STATE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[0] === 'stop' || args[0] === 'start') {
    state.running = args[0] === 'start';
    if (state.running) state.port = process.env.FAKE_DOCKER_PUBLISHED_PORT || '127.0.0.1:49154';
    fs.writeFileSync(file, JSON.stringify(state)); process.exit(0);
  }
  if (args[0] === 'inspect') {
    if (args.includes('{{json .}}')) { const container = JSON.parse(process.env.FAKE_DOCKER_INSPECT_JSON); container.State.Running = state.running; process.stdout.write(JSON.stringify(container)); }
    else if (args.includes('{{.State.Running}}')) process.stdout.write(String(state.running));
    else process.stdout.write(state.running ? state.port : '');
    process.exit(0);
  }
}
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
  let running = process.env.FAKE_DOCKER_RUNNING || "true";
  if (process.env.FAKE_DOCKER_RUNNING_VALUES) {
    const { existsSync, readFileSync, writeFileSync } = require("node:fs");
    const statePath = process.env.FAKE_DOCKER_RUNNING_STATE;
    const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
    const values = process.env.FAKE_DOCKER_RUNNING_VALUES.split(","); running = values[Math.min(count, values.length - 1)];
    if (statePath) writeFileSync(statePath, String(count + 1));
  }
  process.stdout.write(running);
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
if (args[0] === "exec") {
  if (process.env.FAKE_DOCKER_RUNTIME_PROBE_PORT) {
    const probeArgs = args.slice(3);
    probeArgs[probeArgs.length - 1] = process.env.FAKE_DOCKER_RUNTIME_PROBE_PORT;
    const probe = require('node:child_process').spawnSync(process.execPath, probeArgs, {
      encoding: 'utf8', env: { ...process.env, SPORADES_RUNTIME_PROBE_TOKEN: 'a'.repeat(64) },
    });
    process.stdout.write(probe.stdout || '');
    process.stderr.write(probe.stderr || '');
    process.exit(probe.status ?? 1);
  }
  const { existsSync, readFileSync, writeFileSync } = require("node:fs");
  if (process.env.FAKE_DOCKER_RUNTIME_PROBE_OBSERVATION) {
    const route = existsSync(process.env.FAKE_DOCKER_RUNTIME_PROBE_ROUTE) ? readFileSync(process.env.FAKE_DOCKER_RUNTIME_PROBE_ROUTE, "utf8") : "";
    const registry = existsSync(process.env.FAKE_DOCKER_RUNTIME_PROBE_REGISTRY) ? JSON.parse(readFileSync(process.env.FAKE_DOCKER_RUNTIME_PROBE_REGISTRY, "utf8")) : {};
    writeFileSync(process.env.FAKE_DOCKER_RUNTIME_PROBE_OBSERVATION, JSON.stringify({ routeRunning: route.includes("reverse_proxy"), registryStatus: registry.status }));
  }
  const statePath = process.env.FAKE_DOCKER_RUNTIME_PROBE_STATE;
  const count = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
  const configured = process.env.FAKE_DOCKER_RUNTIME_PROBE_RESULTS ? JSON.parse(process.env.FAKE_DOCKER_RUNTIME_PROBE_RESULTS) : [];
  const result = configured[Math.min(count, configured.length - 1)] || { status: 200, body: { ok: true, data: { runtime: { ready: true, fileMaxSizeBytes: 10_485_760, httpMaxBodyBytes: 1_048_576 }, checks: { sqlite: { ok: true }, fileStorage: { ok: true }, fileInspection: { ok: true } } }, error: null } };
  if (statePath) writeFileSync(statePath, String(count + 1));
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  else { const checks = result.body?.data?.checks; const runtime = result.body?.data?.runtime; const hasFileMaxSizeBytes = runtime?.fileMaxSizeBytes !== undefined; const hasHttpMaxBodyBytes = runtime?.httpMaxBodyBytes !== undefined; const validBounds = (!hasFileMaxSizeBytes && !hasHttpMaxBodyBytes) || (hasFileMaxSizeBytes && hasHttpMaxBodyBytes && Number.isInteger(runtime.fileMaxSizeBytes) && runtime.fileMaxSizeBytes > 0 && Number.isInteger(runtime.httpMaxBodyBytes) && runtime.httpMaxBodyBytes > 0); process.stdout.write(JSON.stringify({ kind: "response", status: result.status, valid: typeof result.body?.ok === "boolean" && typeof runtime?.ready === "boolean" && validBounds && typeof checks?.sqlite?.ok === "boolean" && typeof checks?.fileStorage?.ok === "boolean" && (checks?.fileInspection === undefined || typeof checks.fileInspection?.ok === "boolean"), ok: result.body?.ok === true, ready: runtime?.ready === true, sqlite: checks?.sqlite?.ok === true, fileStorage: checks?.fileStorage?.ok === true, fileInspection: checks?.fileInspection === undefined ? null : checks.fileInspection?.ok === true })); }
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(Number(result.exitStatus || "0"));
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

  const routeProbePreload = path.join(fakeBinDir, "route-probe.mjs");
  await writeFile(routeProbePreload, `import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (options?.headers?.['user-agent'] !== 'Sporades-Host-Route-Probe' || process.env.FAKE_HOST_ROUTE_PROBE_REAL === '1') return original(url, options);
  if (process.env.FAKE_HOST_ROUTE_PROBE_LOG) fs.appendFileSync(process.env.FAKE_HOST_ROUTE_PROBE_LOG, JSON.stringify({ url: String(url) }) + '\\n');
  let healthy = process.env.FAKE_HOST_ROUTE_PROBE_FAIL !== '1';
  if (process.env.FAKE_HOST_ROUTE_PROBE_REQUIRE_RELOAD) healthy &&= fs.existsSync(process.env.FAKE_DOCKER_CADDY_LOG) && fs.readFileSync(process.env.FAKE_DOCKER_CADDY_LOG,'utf8').includes('reload');
  const publication = process.env.FAKE_DOCKER_BACKUP_STATE ? JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_BACKUP_STATE,'utf8')).port : process.env.FAKE_DOCKER_PUBLISHED_PORT;
  if (process.env.FAKE_HOST_ROUTE_PROBE_FAIL_FINAL === '1' && publication === '127.0.0.1:49155') healthy = false;
  if (process.env.FAKE_HOST_ROUTE_PROBE_ROUTE) healthy &&= fs.readFileSync(process.env.FAKE_HOST_ROUTE_PROBE_ROUTE, 'utf8').includes('reverse_proxy ' + publication);
  let sent = false; const bytes = Buffer.from(JSON.stringify({ ok: healthy, data: { runtime: { ready: healthy }, checks: { sqlite: {ok:true}, fileStorage: {ok:true} } } }));
  return { status: healthy ? 200 : 502, body: { getReader: () => ({ read: async () => { if (sent) return {done:true}; sent = true; return {done:false,value:bytes}; }, cancel: async () => {} }) } };
};`);

  return {
    fakeBinDir,
    logPath,
    caddyLogPath,
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_HOST_ROUTE_PROBE_PRELOAD: routeProbePreload,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${routeProbePreload}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_CADDY_LOG: caddyLogPath,
      FAKE_DOCKER_CADDY_STATE: path.join(dir, "caddy-state.txt"),
      FAKE_DOCKER_RUN_STATE: path.join(dir, "docker-run-state.txt"),
      FAKE_DOCKER_RUNNING_STATE: path.join(dir, "docker-running-state.txt"),
      FAKE_DOCKER_RUNTIME_PROBE_STATE: path.join(dir, "docker-runtime-probe-state.txt"),
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
  await prepareFakeBin(fakeBinDir);
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
  await prepareFakeBin(fakeBinDir);
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
  await prepareFakeBin(fakeBinDir);
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
  if (process.env.SPORADES_TEST_QA === "1" || process.env.SPORADES_REAL_HOST !== "1") return null;
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
  if (process.env.SPORADES_TEST_QA === "1" || process.env.SPORADES_REAL_HOST !== "1") return null;
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
    // Preserve explicitly supplied hostile entries, but omit incidental macOS xattrs.
    // GNU tar otherwise encodes a duplicate file argument as a hard link.
    const regularFileArgs = process.platform === "linux" ? ["--hard-dereference", "--absolute-names"] : [];
    const child = spawn("tar", ["-czf", archivePath, ...regularFileArgs, "-C", sourceDir, ...entries], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
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
  assert.equal(result.code, 0, result.stderr);
}


async function createTarGzWithTransforms(archivePath, sourceDir, transforms, entries) {
  const transformArgs = transforms.flatMap((rule) => process.platform === "darwin"
    ? ["-s", rule]
    : ["--transform", `s${rule}`]);
  const args = ["-czf", archivePath, ...(process.platform === "linux" ? ["--absolute-names"] : []), "-C", sourceDir, ...transformArgs, ...entries];
  const result = await new Promise((resolve) => {
    const child = spawn("tar", args, {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  await writeFile(path.join(runtimeDir, "sporades.json"), JSON.stringify({name:"team-notes", ...(options.admissionPolicy ? {admissionPolicy:options.admissionPolicy} : {})})+"\n");
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
  const deployFiles = options.deployFiles ?? [];
  for (const file of deployFiles) {
    const target = path.join(runtimeDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, options.fileContents ?? "seed");
  }
  await createTarGz(archivePath, runtimeDir, ["server.mjs", "sporades.json", ...publicFiles, ...deployFiles.map((file) => file.path)]);
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
      files: ["server.mjs", "sporades.json", ...publicFiles, ...deployFiles.map((file) => file.path)],
      deployFiles,
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


async function customDomainFixture(dir, domains = ["capsules.example.dev"]) {
  const remoteRoot = path.join(dir, "remote-root");
  const docker = await installFakeDocker(dir);
  await mkdir(path.join(remoteRoot, "caddy", "hosts"), { recursive: true });
  await writeFile(path.join(remoteRoot, "caddy", "Caddyfile"), "import ./sporades-hosted-domains.caddy\n");
  for (const domain of domains) {
    await writeFile(path.join(remoteRoot, "caddy", "hosts", `${domain}.caddy`), `import ./${domain}/*.caddy\n`);
  }
  const request = {
    action: "capsule.register",
    host: { alias: "personal", domain: domains[0], scheme: "https", remoteRoot },
    capsule: { subname: "team-notes" },
    registration: { aliasDomains: ["fourteen.example", "app.fourteen.example"] },
  };
  const invoke = (input = request, env = {}) => runHostHelper(input, { cwd: dir, env: { ...docker.env, ...env } });
  return { remoteRoot, docker, request, invoke };
}


async function withBackupRouteFixture(fn) {
  const dir = await createHostFixture('sporades-backup-route-', { privateAncestors: true });
  try {
    await withFixtureUmask(async () => {
      const fixture = await writeLegacySealedInstallFixture(dir, { rootName: 'route-recovery', restart: false });
      await alignSealedFixtureWithBuiltLifecycle(fixture);
      const record = JSON.parse(await readFile(fixture.registryRecordPath, 'utf8'));
      record.status = 'running';
      record.runtimeProbe = { header: 'x-sporades-host-probe', token: 'a'.repeat(64) };
      record.aliasDomains = ['alias.example.test'];
      await writeFile(fixture.registryRecordPath, JSON.stringify(record));
      await writeFile(fixture.routeFile, `team-notes.${fixture.domain} {\n reverse_proxy 127.0.0.1:49153 {\n }\n}\n`);
      const data = path.join(fixture.capsuleDir, 'data');
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(data, 'data.db'));
      db.exec('CREATE TABLE samples (value TEXT); INSERT INTO samples VALUES (\'synthetic\')'); db.close();
      const h = { alias: 'personal', domain: fixture.domain, scheme: 'https', remoteRoot: fixture.remoteRoot };
      const { hostBackupDirectory, atomicBackupJson } = await import('../../dist/cli/host-backups.js');
      const backups = hostBackupDirectory(h);
      await mkdir(backups, { recursive: true, mode: 0o700 });
      const password = path.join(dir, 'password');
      await writeFile(password, 'test-only-password', { mode: 0o600 });
      await atomicBackupJson(path.join(backups, 'policy.json'), { repository: path.join(dir, 'repository'), passwordFile: password, schedule: null, retention: 1, maxAgeHours: 26 });
      const state = path.join(dir, 'docker-state.json');
      await writeFile(state, JSON.stringify({ running: true, port: '127.0.0.1:49153' }));
      const docker = await installFakeDocker(path.join(dir, 'docker'), { env: {
        FAKE_DOCKER_BACKUP_STATE: state, FAKE_DOCKER_PUBLISHED_PORT: '127.0.0.1:49154',
        FAKE_HOST_ROUTE_PROBE_ROUTE: fixture.routeFile,
        FAKE_DOCKER_INSPECT_JSON: JSON.stringify({ Id: 'b'.repeat(64), State: { Running: true }, Config: { Labels: {
          'com.sporades.managed': 'true', 'com.sporades.hosted-domain': fixture.domain,
          'com.sporades.capsule-subname': fixture.subname, 'com.sporades.release-id': record.currentRelease.id,
        } } }),
      } });
      const resticLog = path.join(dir, 'restic-observation.json');
      const uploadRestart = path.join(dir, 'restart-during-upload');
      await writeFile(path.join(docker.fakeBinDir, 'restic'), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(resticLog)}, JSON.stringify({route:fs.readFileSync(${JSON.stringify(fixture.routeFile)},'utf8'),journal:fs.existsSync(${JSON.stringify(path.join(fixture.capsuleDir, '.backup-resume.json'))})})); if (fs.existsSync(${JSON.stringify(uploadRestart)})) fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({running:true,port:'127.0.0.1:49155'})); console.log(JSON.stringify({message_type:'summary',snapshot_id:'c'.repeat(64)}));\n`, { mode: 0o755 });
      await fn({ ...fixture, dir, data, record, docker, state, resticLog, uploadRestart, journal: path.join(fixture.capsuleDir, '.backup-resume.json'),
        request: { action: 'capsule.backup.create', host: h, capsule: { subname: fixture.subname } } });
    });
  } finally { await removeHostFixture(dir); }
}


async function runRouteRecoveryPass(f, env = {}) {
  return startExecutable(process.execPath, [hostHelperPath, '--reconcile-host-routes', Buffer.from(JSON.stringify(f.request.host)).toString('base64url')], {
    cwd: f.dir, env: { ...f.docker.env, SPORADES_TEST_FLOCK_PATH: path.join(repoRoot, 'test/support/exec-flock.py'), ...env },
  }).result;
}
export {
repoRoot,
cliPath,
hostHelperPath,
rootPackageJson,
TEST_PUBLIC_KEY,
TEST_WEBSOCKET_TIMEOUT_MS,
workstationPath,
unavailableDockerDirectory,
buildHostLifecycle,
withTempDir,
withHttpServer,
withHostedRuntimeTransportServer,
reserveUnusedPort,
openRawWebSocketHandshake,
runCli,
startHostHelper,
runHostHelper,
startExecutable,
writeFakeProcEntry,
waitForFileText,
waitForHostHelperMarker,
stopHostHelper,
waitForPath,
waitForChildPid,
hostEnv,
writeHostProfileConfig,
prepareFakeBin,
installFakeSsh,
installFakeShellSsh,
installContractFakeSsh,
installFakeScp,
installFakeDocker,
installFakeCaddy,
installFakeJournalctl,
installFakeCaddyUserCommands,
setupRootCapsuleHttpLogFixture,
readJsonl,
readProjectAuditEvents,
writeHostedCapsuleRollbackFixture,
escapeRegExp,
readHostBootstrapSmokeEnv,
readHostRegisterSmokeEnv,
readHostPushRoutingSmokeEnv,
readHostLogsSmokeEnv,
readDotEnv,
listArchiveEntries,
listArchiveVerboseEntries,
extractArchiveFile,
withCacheBust,
writePublicRuntimeFiles,
createTarGz,
createTarGzWithTransforms,
writeArchiveSecurityFixture,
writeHostedCapsuleInstallFixture,
writeLegacySealedInstallFixture,
alignSealedFixtureWithBuiltLifecycle,
installFakeReact,
installFakePreact,
installVue,
writePackage,
prepareRouteLockFixture,
prepareUnregisterRouteFixture,
customDomainFixture,
withBackupRouteFixture,
runRouteRecoveryPass
};
