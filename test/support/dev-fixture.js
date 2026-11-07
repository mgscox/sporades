import { waitForProcessJson } from './process-json.js';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNpmPackJson } from "../../scripts/npm-pack-json.mjs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

import { withFakeS3CompatibleService } from "./fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./libsql-http-service.js";
import { installProjectVueToolchain } from "./project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./project-solid-toolchain.js";
import { installProjectLitToolchain } from "./project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./project-inferno-toolchain.js";
import { installProjectTailwindToolchain } from "./project-tailwind-toolchain.js";
import { CLIENT_CAPABILITIES } from "../../dist/client-capabilities.js";
import { installPrerenderFixture } from "./prerender-capsule.js";
import { mountLitTemplate } from "./lit-template-harness.js";
import { mountSvelteTemplate } from "./svelte-template-harness.js";
import { mountSolidTemplate } from "./solid-template-harness.js";
import { mountVueTemplate } from "./vue-template-harness.js";
import { mountInfernoTemplate } from "./inferno-template-harness.js";
import { createBundle } from "../../dist/bundle-pipeline.js";
import { buildClientToolchain } from "../../dist/client-toolchain.js";
import { cleanupPublicTrees, discardPublicTree } from "../../dist/public-tree.js";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const cliPath = path.join(repoRoot, "bin", "sporades.js");

// Fixture startup may include several parallel compiler processes; behavior assertions keep their own budgets.
const TEST_PROCESS_EVENT_TIMEOUT_MS = 30000;
const TEST_STARTUP_TIMEOUT_MS = 60000;

const TEST_WEBSOCKET_TIMEOUT_MS = 10000;

const TEAM_RUNTIME_TABLES = [
  "sporades_team_bootstrap",
  "sporades_team_join_link_counters",
  "sporades_team_join_link_redemptions",
  "sporades_team_join_link_secrets",
  "sporades_team_join_link_throttles",
  "sporades_team_join_links",
  "sporades_team_membership_application_roles",
  "sporades_team_membership_counters",
  "sporades_team_memberships",
  "sporades_teams",
];


async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-dev-"));
  // Scratch CommonJS helpers must not inherit an enclosing checkout's ESM scope.
  await writeFile(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


async function getTestAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}


async function runRealBrowserRedirectTracer(url) {
  const executable = process.env.SPORADES_REAL_BROWSER_CHROME;
  if (!executable) return false;
  const profile = await mkdtemp(path.join(tmpdir(), "sporades-oauth-browser-"));
  let child = null;
  try {
    child = spawn(executable, [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 20_000;
    let debuggingPort = null;
    let finalTarget = null;
    while (Date.now() < deadline && !finalTarget) {
      if (debuggingPort === null) {
        const activePort = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => null);
        debuggingPort = activePort ? Number(activePort.split("\n")[0]) : null;
      }
      if (Number.isInteger(debuggingPort) && debuggingPort > 0) {
        const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
          .then((response) => response.json())
          .catch(() => []);
        finalTarget = Array.isArray(targets)
          ? targets.find((target) => {
            try { return new URL(target.url).pathname === "/after"; } catch { return false; }
          })
          : null;
      }
      if (!finalTarget) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(finalTarget, `Real browser OAuth redirect tracer timed out. ${stderr.slice(-1000)}`);
    child.kill("SIGTERM");
    let killTimer;
    const forcedExit = new Promise((resolve) => {
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, signal: "SIGKILL" });
      }, 2_000);
    });
    const result = await Promise.race([
      exited,
      forcedExit,
    ]);
    clearTimeout(killTimer);
    assert.notEqual(result.signal, "SIGKILL", "Real browser tracer required forced termination.");
    return true;
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}


async function snapshotProjectTree(root, current = root) {
  const snapshot = {};
  for (const name of (await readdir(current)).sort()) {
    const filePath = path.join(current, name);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const metadata = await lstat(filePath);
    if (metadata.isDirectory()) {
      snapshot[`${relativePath}/`] = "directory";
      Object.assign(snapshot, await snapshotProjectTree(root, filePath));
    } else if (metadata.isSymbolicLink()) {
      snapshot[relativePath] = `symlink:${await readFile(filePath, "utf8").catch(() => "")}`;
    } else {
      snapshot[relativePath] = (await readFile(filePath)).toString("base64");
    }
  }
  return snapshot;
}


function runCliFrom(selectedCliPath, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [selectedCliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);

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


function runCli(args, options = {}) {
  return runCliFrom(cliPath, args, options);
}


function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...options.env };
    for (const name of options.unsetEnv ?? []) delete env[name];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
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


function startCliFrom(selectedCliPath, args, options = {}) {
  return spawn(process.execPath, [selectedCliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}


function startCli(args, options = {}) {
  return startCliFrom(cliPath, args, options);
}


async function packCandidateInto(dir) {
  const packed = await runCommand(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
    { cwd: repoRoot },
  );
  assert.equal(packed.code, 0, packed.stderr);
  const [candidate] = parseNpmPackJson(packed.stdout);
  assert.equal(typeof candidate?.filename, "string", packed.stdout);
  assert.match(candidate.shasum, /^[a-f0-9]{40}$/);
  assert.match(candidate.integrity, /^sha512-/);
  return { packed, candidate, tarballPath: path.join(dir, candidate.filename) };
}


async function installPackedCandidate(projectDir, tarballPath) {
  const packagePath = path.join(projectDir, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.devDependencies.sporades = `file:${tarballPath}`;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const installed = await runCommand(
    "npm",
    ["install", "--offline", "--include=dev", "--no-audit", "--no-fund"],
    { cwd: projectDir, unsetEnv: ["npm_config_allow_scripts", "NPM_CONFIG_ALLOW_SCRIPTS"] },
  );
  assert.equal(installed.code, 0, installed.stderr);
  const packageRoot = path.join(projectDir, "node_modules", "sporades");
  return {
    installed,
    packageRoot,
    cliPath: path.join(packageRoot, "bin", "sporades.js"),
  };
}


async function installPackedCandidateCli(dir, tarballPath) {
  const runnerDir = path.join(dir, "packed-candidate-cli");
  await mkdir(runnerDir, { recursive: true });
  await writeFile(path.join(runnerDir, "package.json"), `${JSON.stringify({
    private: true,
    allowScripts: {
      esbuild: true,
      fsevents: true,
    },
    devDependencies: { sporades: `file:${tarballPath}` },
  }, null, 2)}\n`);
  const installed = await runCommand(
    "npm",
    ["install", "--offline", "--include=dev", "--no-audit", "--no-fund"],
    { cwd: runnerDir, unsetEnv: ["npm_config_allow_scripts", "NPM_CONFIG_ALLOW_SCRIPTS"] },
  );
  assert.equal(installed.code, 0, installed.stderr);
  return {
    installed,
    cliPath: path.join(runnerDir, "node_modules", "sporades", "bin", "sporades.js"),
  };
}


async function assertGeneratedLifecycleScriptAllowlist(projectDir) {
  const generatedPackage = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  assert.deepEqual(generatedPackage.allowScripts, {
    esbuild: true,
    fsevents: true,
  }, "generated packed-install fixtures declare lifecycle-script authority in package.json");
}


async function installFakeDocker(dir) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(path.join(fakeBinDir, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const call = { args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(call) + "\\n");
if (call.args[0] === "compose" && call.args.includes("ps")) {
  const status = process.env.FAKE_DOCKER_STATUS_FILE
    ? require("node:fs").readFileSync(process.env.FAKE_DOCKER_STATUS_FILE, "utf8").trim()
    : process.env.FAKE_DOCKER_COMPOSE_STATUS || "healthy";
  const output = {
    Service: call.args[call.args.length - 1],
    State: status === "exited" ? "exited" : "running",
  };
  if (status !== "no-health") {
    output.Health = status;
  }
  process.stdout.write(JSON.stringify(output) + "\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("port")) {
  process.stdout.write("127.0.0.1:" + (process.env.FAKE_DOCKER_SERVICE_PORT || "49170") + "\\n");
  process.exit(0);
}
`,
  );
  await chmod(dockerPath, 0o755);

  return {
    statusPath: path.join(dir, "fake-docker-status.txt"),
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
    },
    async calls() {
      const raw = await readFile(logPath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}


async function withFakeServiceEndpoint(fn) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}\\n');
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    return await fn({ port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}


function headerNames(headers) {
  return new Set([...headers.keys()].map((name) => name.toLowerCase()));
}


async function rawHttpStatus(baseUrl, requestPath) {
  const response = await rawHttpResponse(baseUrl, requestPath);
  const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
  if (!match) throw new Error(`Invalid HTTP response: ${response}`);
  return Number(match[1]);
}


async function rawHttpResponse(baseUrl, requestTarget, options = {}) {
  const url = new URL(baseUrl);
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write([
        `${method} ${requestTarget} HTTP/1.1`,
        `Host: ${headers.host ?? url.host}`,
        ...Object.entries(headers).filter(([name]) => name.toLowerCase() !== "host").map(([name, value]) => `${name}: ${value}`),
        ...(Object.keys(headers).some((name) => name.toLowerCase() === "connection") ? [] : ["Connection: close"]),
        "",
        "",
      ].join("\r\n"));
    });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for HTTP response to ${requestTarget}.`));
    }, TEST_PROCESS_EVENT_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}


function waitForJsonLine(child) { return waitForProcessJson(child); }


async function waitForJsonEvent(child, predicate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON event.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_STARTUP_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (predicate(event)) {
          cleanup();
          resolve(event);
          return;
        }
      }
    }
    function onStderr(chunk) {
      stderr += chunk;
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code} before JSON event.\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}


function captureJsonEvents(child) {
  let buffer = "";
  let stderr = "";
  const events = [];
  const waiters = new Set();
  const onStdout = (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.delete(waiter);
        events.splice(events.indexOf(event), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(event);
        break;
      }
    }
  };
  const onStderr = (chunk) => { stderr += chunk; };
  const onExit = (code) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`Process exited with ${code} before JSON event.\nstderr:\n${stderr}`));
    }
    waiters.clear();
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.on("exit", onExit);
  return {
    events,
    get stderr() { return stderr; },
    next(predicate) {
      const existingIndex = events.findIndex(predicate);
      if (existingIndex >= 0) return Promise.resolve(events.splice(existingIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for captured JSON event.\nstderr:\n${stderr}`));
        }, TEST_STARTUP_TIMEOUT_MS);
        waiters.add(waiter);
      });
    },
    dispose() {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      for (const waiter of waiters) clearTimeout(waiter.timeout);
      waiters.clear();
    },
  };
}


function assertDevRefreshDelivery(refresh, sequence) {
  assert.equal(refresh.sequence, sequence);
  assert.equal(refresh.clientsAttempted, 1);
  assert.equal(refresh.clientsDelivered, 1);
  assert.equal(refresh.clientsTimedOut, 0);
  assert.equal(refresh.clientsDisconnected, 0);
  assert(refresh.framesAttempted >= 1, JSON.stringify(refresh));
  assert(refresh.framesWritten >= 0 && refresh.framesWritten <= refresh.framesAttempted, JSON.stringify(refresh));
  assert(refresh.framesBackpressured >= 0 && refresh.framesBackpressured <= refresh.framesAttempted, JSON.stringify(refresh));
  assert(refresh.framesFailed >= 0 && refresh.framesFailed <= refresh.framesAttempted, JSON.stringify(refresh));
}


async function waitForStdoutLine(child, predicate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stdout line.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TEST_STARTUP_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }
    function onStdout(chunk) {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
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
    {
      ".": "./index.js",
      "./hooks": "./hooks.js",
      "./jsx-runtime": "./jsx-runtime.js",
    },
    {
      "index.js": "export function render() {}\n",
      "hooks.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js":
        "export const Fragment = Symbol.for('preact.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    },
  );
}


async function installVue(projectDir) {
  await installProjectVueToolchain(projectDir, repoRoot);
}


async function installSvelte(projectDir) {
  await installProjectSvelteToolchain(projectDir, repoRoot);
}


function nodeText(node) {
  return `${node?.text ?? ""}${(node?.children ?? []).map(nodeText).join("")}`;
}


function sessionState() {
  return {
    loading: false,
    auth: null,
    providers: {
      anonymous: { enabled: true, configured: true, runtimeAvailable: true },
      google: { enabled: true, configured: true, runtimeAvailable: true },
    },
    isAuthenticated() { return Boolean(this.auth && !this.auth.isGuest && this.auth.provider !== "anonymous"); },
  };
}


function authStub(overrides = {}) {
  return {
    async signIn() { return { data: null, error: null }; },
    async signOut() { return { data: null, error: null }; },
    async signUp() { return { data: null, error: null }; },
    ...overrides,
  };
}


async function createVueCampfire(dir, name) {
  const created = await runCli(["create", name, "--template", "campfire", "--framework", "vue", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr);
  const projectDir = path.join(dir, name);
  await installVue(projectDir);
  return projectDir;
}


async function createSvelteTemplate(dir, name, template) {
  const created = await runCli(["create", name, "--template", template, "--framework", "svelte", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr);
  const projectDir = path.join(dir, name);
  await installSvelte(projectDir);
  return projectDir;
}


async function createSolidTemplate(dir, name, template) {
  const created = await runCli(["create", name, "--template", template, "--framework", "solid", "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr || created.stdout);
  const projectDir = path.join(dir, name);
  await installProjectSolidToolchain(projectDir, repoRoot);
  return projectDir;
}


function campfireHarnessState(calls, journeyOverrides = {}) {
  const mutation = (name) => ({ loading: false, error: null, async run(input) { calls.push([name, input]); return { data: name === "seedCampfire" ? { failed: [], created: [], alreadyPresent: [] } : null, error: null }; } });
  return {
    session: sessionState(),
    queries: {
      profiles: { loading: false, data: null, error: null },
      messagesGeneral: { loading: false, data: [{ id: "m1", authorName: "Athos", body: "All for one", createdAt: "2026-07-11T12:00:00.000Z", reactions: {} }], error: null },
      messagesIdeas: { loading: false, data: [], error: null },
      messagesRandom: { loading: false, data: [], error: null },
      messagesProtectTheCrown: { loading: false, data: [], error: null },
    },
    mutations: {
      sendMessage: mutation("sendMessage"), toggleReaction: mutation("toggleReaction"),
      seedCampfire: mutation("seedCampfire"), registerFixture: mutation("registerFixture"),
    },
    auth: authStub(), files: {},
    journey: {
      async enable(options) { calls.push(["journey.enable", options]); return { data: null, error: null }; },
      async disable() { calls.push(["journey.disable"]); return { data: null, error: null }; },
      async set(value) { calls.push(["journey.set", value]); return { data: null, error: null }; },
      subscribe() { return { unsubscribe() { calls.push(["unsubscribe"]); } }; },
      ...journeyOverrides,
    },
    preferences: {
      async get() { calls.push(["preferences.get"]); return { data: { preferences: { campfireShareActivity: true } }, error: null }; },
      async update(value) { calls.push(["preferences.update", value]); return { data: { preferences: value }, error: null }; },
    },
  };
}


function litSource(initial, counts = { starts: 0, stops: 0 }) {
  const listeners = new Set();
  return { counts, subscribe(listener) { counts.starts += 1; listeners.add(listener); listener(initial); return { unsubscribe() { if (listeners.delete(listener)) counts.stops += 1; } }; }, publish(value) { initial = value; for (const listener of [...listeners]) listener(value); } };
}


async function createLitTemplate(dir, name, template) {
  const created = await runCli(["create", name, "--framework", "lit", "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr || created.stdout);
  const projectDir = path.join(dir, name); await installProjectLitToolchain(projectDir, repoRoot); return projectDir;
}


async function runProjectTsc(projectDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectDir, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}


async function createInfernoTemplate(dir, name, template, { omitToolchain = false, toolchain = "esbuild" } = {}) {
  const created = await runCli(["create", name, "--framework", "inferno", "--toolchain", toolchain, "--template", template, "--no-install", "--no-git", "--json"], { cwd: dir });
  assert.equal(created.code, 0, created.stderr || created.stdout);
  const projectDir = path.join(dir, name);
  if (omitToolchain) {
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    delete config.client.toolchain;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  await installProjectInfernoToolchain(projectDir, repoRoot);
  return projectDir;
}


function litCampfireState(calls, journeyOverrides = {}) {
  const mutation = (name) => ({ async run(input) { calls.push([name, input]); return { data: null, error: null }; } });
  let subscriber = () => {};
  const journey = {
    async enable(options) { calls.push(["journey.enable", options]); return { data: null, error: null }; },
    async disable() { calls.push(["journey.disable"]); return { data: null, error: null }; },
    async set(value) { calls.push(["journey.set", value]); return { data: null, error: null }; },
    subscribe(callback) { subscriber = callback; calls.push(["journey.subscribe"]); return { unsubscribe() { calls.push(["journey.unsubscribe"]); } }; },
    ...journeyOverrides,
  };
  return { auth: authStub(), files: {}, journey, preferences: { async get() { calls.push(["preferences.get"]); return { data: { preferences: { campfireShareActivity: true } }, error: null }; }, async update(value) { calls.push(["preferences.update", value]); return { data: { preferences: value }, error: null }; } }, session: litSource({ ...sessionState(), loading: false }), queries: { profiles: litSource({ data: null, error: null, loading: false }), messagesGeneral: litSource({ data: [{ id: "m1", authorName: "Athos", body: "All for one", reactions: {} }], error: null, loading: false }), messagesIdeas: litSource({ data: [], error: null, loading: false }), messagesRandom: litSource({ data: [], error: null, loading: false }), messagesProtectTheCrown: litSource({ data: [], error: null, loading: false }) }, mutations: { sendMessage: mutation("sendMessage"), toggleReaction: mutation("toggleReaction"), seedCampfire: mutation("seedCampfire"), registerFixture: mutation("registerFixture") }, publishJourney(event) { subscriber(event); } };
}


async function writePackage(projectDir, packageName, exports, files) {
  const packageDir = path.join(projectDir, "node_modules", packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0", type: "module", exports }, null, 2)}\n`,
  );
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)),
  );
}


async function withFakeGoogleServer(fn) {
  const requests = [];
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "fake-google-key", alg: "RS256", use: "sig" });
  let nonce = null;
  const identityToken = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce,
      sub: "google-subject-mira",
      email: "mira@example.com",
      email_verified: true,
      name: "Mira",
      picture: "https://example.com/mira.png",
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: requestUrl.pathname });

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const body = await new Promise((resolve) => {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => resolve(new URLSearchParams(raw)));
      });
      requests.at(-1).body = Object.fromEntries(body.entries());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: identityToken(), access_token: "server-owned-access-token", token_type: "Bearer" }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  try {
    return await fn({
      tokenUrl: `http://127.0.0.1:${port}/token`,
      jwksUrl: `http://127.0.0.1:${port}/jwks`,
      requests,
      setNonce(value) {
        nonce = value;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}


async function withFakeFacebookServer(fn) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: requestUrl.pathname,
      query: Object.fromEntries(requestUrl.searchParams),
      body: Object.fromEntries(new URLSearchParams(body)),
      authorization: request.headers.authorization ?? null,
    });
    response.writeHead(200, { "content-type": "application/json" });
    if (requestUrl.pathname === "/token") {
      response.end(JSON.stringify({ access_token: "facebook-provider-access-token", token_type: "bearer" }));
      return;
    }
    response.end(JSON.stringify({
      id: "facebook-subject-mira",
      name: "Mira Without Email",
      picture: { data: { url: "https://example.com/mira-facebook.png" } },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    return await fn({
      tokenUrl: `http://127.0.0.1:${port}/token`,
      graphUrl: `http://127.0.0.1:${port}/v23.0/me`,
      requests,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}


async function withFakeAppleServer(fn) {
  const requests = [];
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "fake-apple-key", alg: "RS256", use: "sig" });
  let nonce = null;
  const identityToken = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "com.example.web",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce,
      sub: "apple-subject-mira",
      email: "mira@privaterelay.appleid.com",
      email_verified: "true",
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: requestUrl.pathname });
    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const body = await new Promise((resolve) => {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => resolve(new URLSearchParams(raw)));
      });
      requests.at(-1).body = Object.fromEntries(body.entries());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: identityToken(), token_type: "Bearer" }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    return await fn({
      tokenUrl: `http://127.0.0.1:${port}/token`,
      jwksUrl: `http://127.0.0.1:${port}/jwks`,
      requests,
      setNonce(value) { nonce = value; },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}


async function withFakeMicrosoftServer(fn) {
  const requests = [];
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, {
    kid: "fake-microsoft-key",
    alg: "RS256",
    use: "sig",
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
  });
  const tenantId = "11111111-2222-3333-4444-555555555555";
  let nonce = null;
  let origin = null;
  const identityToken = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce,
      tid: tenantId,
      sub: "microsoft-subject-mira",
      name: "Mira Microsoft",
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: requestUrl.pathname });
    if (request.method === "GET" && requestUrl.pathname === "/discovery") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
      }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/authorize") {
      nonce = requestUrl.searchParams.get("nonce");
      response.writeHead(302, {
        location: `${requestUrl.searchParams.get("redirect_uri")}?code=microsoft-code&state=${requestUrl.searchParams.get("state")}`,
      });
      response.end();
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const body = await new Promise((resolve) => {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => resolve(new URLSearchParams(raw)));
      });
      requests.at(-1).body = Object.fromEntries(body.entries());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: identityToken(), access_token: "server-owned-secret-token" }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ discoveryUrl: `${origin}/discovery`, origin, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}


async function withAppleHttpsTunnel(upstreamUrl, publicPort, fn) {
  const upstream = new URL(upstreamUrl);
  const [key, cert] = await Promise.all([
    readFile(path.join(repoRoot, "test", "support", "apple-tls-key.pem")),
    readFile(path.join(repoRoot, "test", "support", "apple-tls-cert.pem")),
  ]);
  let publicOrigin = null;
  const tunnelSockets = new Set();
  const forwardedHeaders = (headers) => ({
    ...headers,
    host: new URL(publicOrigin).host,
    origin: headers.origin ?? publicOrigin,
    "x-forwarded-host": new URL(publicOrigin).host,
    "x-forwarded-proto": "https",
  });
  const proxy = createHttpsServer({ key, cert }, (request, response) => {
    const outgoing = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    outgoing.on("error", (error) => response.destroy(error));
    request.pipe(outgoing);
  });
  proxy.on("upgrade", (request, socket, head) => {
    const upstreamSocket = connect(Number(upstream.port), upstream.hostname, () => {
      const headers = forwardedHeaders(request.headers);
      upstreamSocket.write([
        `${request.method} ${request.url} HTTP/${request.httpVersion}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"));
      if (head.length > 0) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstreamSocket.on("error", () => socket.destroy());
  });
  proxy.on("connection", (socket) => {
    tunnelSockets.add(socket);
    socket.on("close", () => tunnelSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(publicPort, "127.0.0.1", resolve);
  });
  publicOrigin = `https://apple.example.test:${proxy.address().port}`;
  try {
    return await fn({
      publicOrigin,
      socketOptions: {
        connectHost: "127.0.0.1",
        connectionTokenBaseUrl: upstreamUrl,
      },
      postForm(pathname, values) {
        const body = new URLSearchParams(values).toString();
        return new Promise((resolve, reject) => {
          const request = httpsRequest({
            hostname: "127.0.0.1",
            port: proxy.address().port,
            path: pathname,
            method: "POST",
            rejectUnauthorized: false,
            servername: "apple.example.test",
            headers: {
              host: new URL(publicOrigin).host,
              origin: publicOrigin,
              "content-type": "application/x-www-form-urlencoded",
              "content-length": Buffer.byteLength(body),
            },
          }, (response) => {
            let responseBody = "";
            response.on("data", (chunk) => { responseBody += chunk; });
            response.on("end", () => resolve({
              status: response.statusCode,
              headers: response.headers,
              body: responseBody,
            }));
          });
          request.on("error", reject);
          request.end(body);
        });
      },
    });
  } finally {
    for (const socket of tunnelSockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
}


// A test-only Capsule query exposing bounded, non-secret facts about ctx.env. Sporades ships no
// browser-readable env query (#289); tests that inspect server env declare their own probe.
async function installEnvProbeQuery(projectDir, probeBody = "Object.keys(ctx.env).sort()") {
  const serverPath = path.join(projectDir, "server", "index.ts");
  const source = await readFile(serverPath, "utf8");
  assert.match(source, /^  queries: \{$/m);
  await writeFile(serverPath, source.replace(/^  queries: \{$/m, `  queries: {\n    testEnvProbe: query((ctx) => (${probeBody})),`));
}


function assertUnknownEnvQuery(message, id) {
  assert.deepEqual(message, {
    id,
    type: "query.result",
    query: "ctx.env",
    data: null,
    error: { message: "Unknown query: ctx.env", hint: "Use a query defined by the capsule." },
  });
}


async function openSocket(baseUrl, sessionToken = null) {
  const connectionToken = await readPageConnectionToken(baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = new WebSocket(url);
    socketMessageQueue(socket);
    installSessionTokenEnvelope(socket, sessionToken);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}


async function subscribeDevRefresh(socket) {
  const ready = readSocketMessage(socket);
  socket.send(JSON.stringify({ id: "dev-refresh-ready", type: "dev.refresh.subscribe" }));
  const message = await ready;
  assert.equal(message.id, "dev-refresh-ready");
  assert.equal(message.type, "dev.refresh.ready");
  assert.equal(message.data?.mode, "full-page");
  assert.equal(typeof message.data?.sequence, "number");
  socket.addEventListener("message", (event) => {
    const refresh = JSON.parse(event.data);
    if (refresh.type === "refresh" && Number.isInteger(refresh.data?.sequence)) {
      socket.send(JSON.stringify({ id: null, type: "dev.refresh.received", sequence: refresh.data.sequence }));
    }
  });
  return message;
}


async function readPageConnectionToken(baseUrl) {
  const response = await fetch(new URL("/", baseUrl), { headers: { "sec-fetch-dest": "document" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, "Expected served page to include a Sporades connection token.");
  return match[1];
}


function readWebSocketUpgradeResponse(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket handshake response."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      cleanup();
      socket.destroy();
      resolve(buffer.subarray(0, marker).toString("utf8"));
    }

    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${url.pathname} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}


function installSessionTokenEnvelope(socket, sessionToken) {
  if (!sessionToken) return;
  const send = socket.send.bind(socket);
  socket.send = (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage);
      if (message && typeof message === "object" && !message.sessionToken) {
        send(JSON.stringify({ ...message, sessionToken }));
        return;
      }
    } catch {
      // Fall through to the original payload for non-JSON test frames.
    }
    send(rawMessage);
  };
}


async function openSocketWithHeaders(baseUrl, headers = {}, options = {}) {
  const connectionToken = await readPageConnectionToken(options.connectionTokenBaseUrl ?? baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = url.protocol === "https:"
      ? connectTls({
          host: options.connectHost ?? url.hostname,
          port: Number(url.port || 443),
          servername: url.hostname,
          rejectUnauthorized: false,
        })
      : connect(Number(url.port), options.connectHost ?? url.hostname);
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out opening raw WebSocket."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onHandshakeData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onHandshakeData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      const response = buffer.subarray(0, marker).toString("utf8");
      if (!response.startsWith("HTTP/1.1 101")) {
        cleanup();
        socket.destroy();
        reject(new Error(`Unexpected WebSocket handshake response: ${response}`));
        return;
      }
      const remaining = buffer.subarray(marker + 4);
      buffer = remaining;
      cleanup();
      resolve({
        sendJson(payload) {
          socket.write(encodeClientWebSocketFrame(JSON.stringify(payload)));
        },
        sendCloseFrame() {
          socket.write(encodeClientWebSocketCloseFrame());
        },
        readJson() {
          return readRawWebSocketJson(socket, buffer);
        },
        waitForClose() {
          return waitForRawSocketClose(socket);
        },
        close() {
          socket.end();
        },
        destroy() {
          socket.destroy();
        },
      });
    }

    socket.on("error", onError);
    socket.on("data", onHandshakeData);
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


function encodeClientWebSocketFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])]);
  const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    encoded[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, encoded]);
}


function encodeClientWebSocketCloseFrame() {
  const mask = randomBytes(4);
  return Buffer.from([0x88, 0x80, ...mask]);
}


function readRawWebSocketJson(socket, initialBuffer = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buffer = initialBuffer;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raw WebSocket message."));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const lengthCode = buffer[1] & 0x7f;
      let offset = 2;
      let length = lengthCode;
      if (lengthCode === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (lengthCode === 127) {
        cleanup();
        reject(new Error("Raw WebSocket helper only supports 16-bit message lengths."));
        return;
      }
      if (buffer.length < offset + length) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")));
    }

    socket.on("data", onData);
    socket.on("error", onError);
    onData(Buffer.alloc(0));
  });
}


function waitForRawSocketClose(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raw WebSocket close."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
    }
    function onClose() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on("close", onClose);
    socket.on("error", onError);
  });
}


const socketMessageQueues = new WeakMap();
function socketMessageQueue(socket) {
  let queue = socketMessageQueues.get(socket);
  if (!queue) {
    queue = captureSocketMessages(socket);
    socketMessageQueues.set(socket, queue);
    if (typeof socket.send === "function") {
      const send = socket.send.bind(socket);
      socket.send = (...args) => { queue.discard(); return send(...args); };
    }
  }
  return queue;
}

function readSocketMessage(socket) {
  return socketMessageQueue(socket).next(() => true);
}


function captureSocketMessages(socket) {
  const messages = [];
  let closed;
  const history = [];
  const waiters = new Set();
  const onMessage = (event) => {
    const message = JSON.parse(event.data);
    history.push(message);
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      messages.splice(messages.indexOf(message), 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      break;
    }
  };
  const onError = (event) => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(event.error ?? new Error("WebSocket failed."));
    }
    waiters.clear();
  };
  const onClose = event => {
    closed = new Error(`WebSocket closed before expected message (code ${event.code ?? "unknown"}).`);
    for (const waiter of waiters) { clearTimeout(waiter.timeout); waiter.reject(closed); }
    waiters.clear();
  };
  socket.addEventListener("close", onClose);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  return {
    history,
    discard() { messages.length = 0; },
    next(predicate) {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]);
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for captured WebSocket message. History: ${JSON.stringify(history)}`));
        }, TEST_WEBSOCKET_TIMEOUT_MS);
        waiters.add(waiter);
      });
    },
    dispose() {
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      for (const waiter of waiters) clearTimeout(waiter.timeout);
      waiters.clear();
    },
  };
}


function waitForSocketClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    }
    function onClose() {
      cleanup();
      resolve();
    }
    function onError(event) {
      cleanup();
      reject(event.error ?? new Error("WebSocket failed."));
    }

    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}


async function closeSocketGracefully(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    socket.addEventListener("close", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  if (socket.readyState !== WebSocket.CLOSING) socket.close();
  await closed;
}


async function openWebSocket(url) {
  const webSocketUrl = new URL(url);
  const pageBaseUrl = new URL(url);
  pageBaseUrl.protocol = pageBaseUrl.protocol === "wss:" ? "https:" : "http:";
  pageBaseUrl.pathname = "/";
  pageBaseUrl.search = "";
  webSocketUrl.searchParams.set("connectionToken", await readPageConnectionToken(pageBaseUrl));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    socketMessageQueue(socket);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}


function waitForSocketMessage(socket, predicate) {
  const queue = socketMessageQueue(socket);
  // Callers commonly arm the waiter immediately before send(); let send clear
  // preceding-request updates before consulting retained same-turn frames.
  return Promise.resolve().then(() => queue.next(predicate));
}


export {
  repoRoot,
  cliPath,
  TEST_PROCESS_EVENT_TIMEOUT_MS,
  TEST_WEBSOCKET_TIMEOUT_MS,
  TEAM_RUNTIME_TABLES,
  withTempDir,
  getTestAvailablePort,
  runRealBrowserRedirectTracer,
  snapshotProjectTree,
  runCliFrom,
  runCli,
  runCommand,
  startCliFrom,
  startCli,
  packCandidateInto,
  installPackedCandidate,
  installPackedCandidateCli,
  assertGeneratedLifecycleScriptAllowlist,
  installFakeDocker,
  withFakeServiceEndpoint,
  headerNames,
  rawHttpStatus,
  rawHttpResponse,
  waitForJsonLine,
  waitForJsonEvent,
  captureJsonEvents,
  assertDevRefreshDelivery,
  waitForStdoutLine,
  installFakeReact,
  installFakePreact,
  installVue,
  installSvelte,
  nodeText,
  sessionState,
  authStub,
  createVueCampfire,
  createSvelteTemplate,
  createSolidTemplate,
  campfireHarnessState,
  litSource,
  createLitTemplate,
  runProjectTsc,
  createInfernoTemplate,
  litCampfireState,
  writePackage,
  withFakeGoogleServer,
  withFakeFacebookServer,
  withFakeAppleServer,
  withFakeMicrosoftServer,
  withAppleHttpsTunnel,
  installEnvProbeQuery,
  assertUnknownEnvQuery,
  openSocket,
  subscribeDevRefresh,
  readPageConnectionToken,
  readWebSocketUpgradeResponse,
  installSessionTokenEnvelope,
  openSocketWithHeaders,
  encodeClientWebSocketFrame,
  encodeClientWebSocketCloseFrame,
  readRawWebSocketJson,
  waitForRawSocketClose,
  readSocketMessage,
  captureSocketMessages,
  waitForSocketClose,
  closeSocketGracefully,
  openWebSocket,
  waitForSocketMessage
};
