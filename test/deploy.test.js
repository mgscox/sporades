import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withFakeS3CompatibleService } from "./support/fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";
import { installProjectVueToolchain } from "./support/project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./support/project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./support/project-solid-toolchain.js";
import { installProjectLitToolchain } from "./support/project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./support/project-inferno-toolchain.js";
import { CLIENT_CAPABILITIES } from "../dist/client-capabilities.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const TEST_WEBSOCKET_TIMEOUT_MS = 10000;
const BASE_IMAGE_RUNTIME_USER = "10001:10001";
const TEST_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDI9R+ElI6awrzqT1DDZjMa6q7iH+jF5bughycSLBOa/ test@example";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-deploy-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function relativeFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(root, entryPath));
    else files.push(path.relative(root, entryPath).split(path.sep).join("/"));
  }
  return files.sort();
}

async function readOptional(file) {
  return readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function waitForPublicTreeCandidate(projectDir, excluded = new Set()) {
  const treesDir = path.join(projectDir, ".sporades", "build", ".public-trees");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entries = await readdir(treesDir, { withFileTypes: true }).catch(() => []);
    const candidate = entries.find((entry) => entry.isDirectory() && !excluded.has(entry.name) && /^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(entry.name));
    if (candidate) return path.join(treesDir, candidate.name);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a staged public-tree candidate.");
}

async function deployOwnedContainer(projectDir, dir, containerId = "container-old") {
  const docker = await installFakeDocker(path.join(dir, "owned-container"), containerId);
  const result = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
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

async function installFakeDocker(dir, containerId = "container-new", options = {}) {
  const fakeBinDir = path.join(dir, "fake-bin");
  const logPath = path.join(dir, "docker-calls.jsonl");
  const dockerPath = path.join(fakeBinDir, "docker");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const call = { args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(call) + "\\n");
const recordedCalls = readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").trim().split("\\n").map(JSON.parse);
const failOnceActions = new Set((process.env.FAKE_DOCKER_FAIL_ONCE_ACTIONS ?? "").split(",").filter(Boolean));
if (failOnceActions.has(call.args[0])) {
  if (recordedCalls.filter((entry) => entry.args[0] === call.args[0]).length === 1) {
    process.stderr.write("injected one-time " + call.args[0] + " failure\\n");
    process.exit(1);
  }
}
const missingContainerActions = new Set((process.env.FAKE_DOCKER_MISSING_CONTAINER_ACTIONS ?? "").split(",").filter(Boolean));
if (missingContainerActions.has(call.args[0])) {
  process.stderr.write("Error response from daemon: No such container: " + call.args[1] + "\\n");
  process.exit(1);
}
const missingInspectIds = new Set((process.env.FAKE_DOCKER_MISSING_INSPECT_IDS ?? "").split(",").filter(Boolean));
if (call.args[0] === "inspect" && missingInspectIds.has(call.args.at(-1))) {
  const subject = process.env.FAKE_DOCKER_MISSING_INSPECT_SUBJECT || "container";
  process.stderr.write("Error response from daemon: No such " + subject + ": " + call.args.at(-1) + "\\n");
  process.exit(1);
}
if (call.args[0] === "ps") {
  process.stdout.write(process.env.FAKE_DOCKER_CONTAINER_ID + "\\n");
  process.exit(0);
}
if (call.args[0] === "inspect" && call.args.includes("{{json .Mounts}}")) {
  process.stdout.write(JSON.stringify([
    { Source: process.env.FAKE_DOCKER_DATA_DIR, Destination: "/app/data" }
  ]) + "\\n");
  process.exit(0);
}
if (call.args[0] === "inspect" && call.args.includes("{{json .}}")) {
  const latestRun = recordedCalls.filter((entry) => entry.args[0] === "run").at(-1);
  const runLabels = {};
  if (latestRun) {
    for (let index = 0; index < latestRun.args.length; index += 1) {
      if (latestRun.args[index] !== "--label") continue;
      const [key, ...value] = latestRun.args[index + 1].split("=");
      runLabels[key] = value.join("=");
    }
  }
  const inspected = process.env.FAKE_DOCKER_INSPECT_JSON ? JSON.parse(process.env.FAKE_DOCKER_INSPECT_JSON) : {
    Id: call.args.at(-1),
    Name: latestRun ? "/" + latestRun.args[latestRun.args.indexOf("--name") + 1] : null,
    State: { Running: true },
    Config: { User: process.env.FAKE_DOCKER_CONFIG_USER || "10001:10001", Labels: runLabels },
    NetworkSettings: {
      Ports: {
        "22/tcp": [
          { HostIp: "127.0.0.1", HostPort: "49162" }
        ]
      }
    }
  };
  if (latestRun && call.args.at(-1) === process.env.FAKE_DOCKER_CONTAINER_ID) {
    inspected.Id = call.args.at(-1);
    inspected.Name = "/" + latestRun.args[latestRun.args.indexOf("--name") + 1];
    inspected.Config = { ...(inspected.Config || {}), Labels: { ...(inspected.Config?.Labels || {}), ...runLabels } };
  }
  process.stdout.write(JSON.stringify(inspected) + "\\n");
  process.exit(0);
}
if (call.args[0] === "logs") {
  process.stdout.write(JSON.stringify({
    schema: "sporades.log.v1",
    timestamp: "2026-07-04T06:32:08.180Z",
    category: "platform",
    event: "runtime.started",
    level: "info",
    message: "Capsule runtime started",
    capsule: { name: "todo-island", id: "todo-island" },
    release: null,
    request: null,
    correlation: null,
    data: null,
    truncated: false
  }) + "\\n");
  process.exit(0);
}
if (call.args[0] === "image" && call.args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_IMAGE_INSPECT_STATUS ?? "0"));
}
if (call.args[0] === "pull") {
  process.exit(Number(process.env.FAKE_DOCKER_PULL_STATUS ?? "0"));
}
if (call.args[0] === "build") {
  process.exit(Number(process.env.FAKE_DOCKER_BUILD_STATUS ?? "0"));
}
if (call.args[0] === "compose" && call.args.includes("up")) {
  process.exit(Number(process.env.FAKE_DOCKER_COMPOSE_UP_STATUS ?? "0"));
}
if (call.args[0] === "compose" && call.args.includes("ps")) {
  const delayMs = Number(process.env.FAKE_DOCKER_COMPOSE_PS_DELAY_MS || "0");
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  process.stdout.write(process.env.FAKE_DOCKER_COMPOSE_PS_OUTPUT + "\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("port")) {
  process.stdout.write(process.env.FAKE_DOCKER_COMPOSE_PORT_OUTPUT + "\\n");
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("down")) {
  process.exit(Number(process.env.FAKE_DOCKER_COMPOSE_DOWN_STATUS ?? "0"));
}
if (call.args[0] === "network" && call.args[1] === "inspect") {
  process.exit(Number(process.env.FAKE_DOCKER_NETWORK_INSPECT_STATUS ?? "0"));
}
if (call.args[0] === "image" && call.args[1] === "ls") {
  if (call.args.includes("ghcr.io/tursodatabase/libsql-server:v0.24.32")) {
    process.stdout.write("third-party-libsql\\n");
    process.exit(0);
  }
  process.stdout.write(process.env.FAKE_DOCKER_SPORADES_IMAGES ?? "");
  process.exit(0);
}
if (call.args[0] === "rmi") {
  process.exit(0);
}
if (call.args[0] === "run") {
  process.stdout.write(process.env.FAKE_DOCKER_CONTAINER_ID + "\\n");
}
`,
  );
  await chmod(dockerPath, 0o755);

  return {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: logPath,
      FAKE_DOCKER_CONTAINER_ID: containerId,
      FAKE_DOCKER_DATA_DIR: options.dataDir ?? "",
      FAKE_DOCKER_MISSING_CONTAINER_ACTIONS: options.missingContainerActions?.join(",") ?? "",
      FAKE_DOCKER_MISSING_INSPECT_IDS: options.missingInspectIds?.join(",") ?? "",
      FAKE_DOCKER_MISSING_INSPECT_SUBJECT: options.missingInspectSubject ?? "",
      FAKE_DOCKER_FAIL_ONCE_ACTIONS: options.failOnceActions?.join(",") ?? "",
      FAKE_DOCKER_IMAGE_INSPECT_STATUS: String(options.imageInspectStatus ?? 0),
      FAKE_DOCKER_PULL_STATUS: String(options.pullStatus ?? 0),
      FAKE_DOCKER_BUILD_STATUS: String(options.buildStatus ?? 0),
      FAKE_DOCKER_COMPOSE_UP_STATUS: String(options.composeUpStatus ?? 0),
      FAKE_DOCKER_COMPOSE_DOWN_STATUS: String(options.composeDownStatus ?? 0),
      FAKE_DOCKER_COMPOSE_PS_OUTPUT: options.composePsOutput ?? JSON.stringify({ State: "running", Health: "healthy" }),
      FAKE_DOCKER_COMPOSE_PS_DELAY_MS: String(options.composePsDelayMs ?? 0),
      FAKE_DOCKER_COMPOSE_PORT_OUTPUT: options.composePortOutput ?? "127.0.0.1:49161",
      FAKE_DOCKER_NETWORK_INSPECT_STATUS: String(options.networkInspectStatus ?? 0),
      FAKE_DOCKER_SPORADES_IMAGES: options.sporadesImages ?? "",
      FAKE_DOCKER_INSPECT_JSON: options.inspectJson ?? "",
      FAKE_DOCKER_CONFIG_USER: options.configUser ?? "",
    },
    async calls() {
      let raw = "";
      try {
        raw = await readFile(logPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

async function readProjectAuditEvents(projectDir) {
  const eventsPath = path.join(projectDir, ".sporades", "data", "logs", "events.jsonl");
  return (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.category === "audit");
}

function expectedLocalContainerRuntimeUser() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (Number.isInteger(uid) && Number.isInteger(gid) && uid >= 0 && gid >= 0) {
    return `${uid}:${gid}`;
  }
  return BASE_IMAGE_RUNTIME_USER;
}

function firstDockerRunCall(calls) {
  return calls.find((call) => call.args[0] === "run");
}

function capsuleServiceCredentialsPath(projectDir) {
  return path.join(projectDir, ".sporades", "services", "credentials.json");
}

async function readCapsuleServiceCredentials(projectDir) {
  return JSON.parse(await readFile(capsuleServiceCredentialsPath(projectDir), "utf8"));
}

async function seedCapsuleServiceCredentials(projectDir, overrides = {}) {
  const credentials = {
    databaseUser: "sporades",
    databasePassword: "sporades",
    storageAccessKey: "sporades",
    storageSecretKey: "sporades-minio-local-secret",
    ...overrides,
  };
  await mkdir(path.dirname(capsuleServiceCredentialsPath(projectDir)), { recursive: true });
  await writeFile(capsuleServiceCredentialsPath(projectDir), `${JSON.stringify(credentials, null, 2)}\n`);
  return credentials;
}

function dockerRunEnv(runCall, prefix) {
  const entries = [];
  for (const arg of runCall.args) {
    if (!arg.startsWith(prefix)) continue;
    const separator = arg.indexOf("=");
    entries.push([arg.slice(0, separator), arg.slice(separator + 1)]);
  }
  return Object.fromEntries(entries);
}

function assertVolume(args, mount) {
  assert(args.includes(mount), `Expected docker args to include volume: ${mount}\n${args.join(" ")}`);
}

async function updateSporadesConfig(projectDir, updater) {
  const configPath = path.join(projectDir, "sporades.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  updater(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function openSshPublicKeyLine(keyType, fields, comment = "test@example") {
  const blob = Buffer.concat([sshString(keyType), ...fields.map((field) => sshString(field))]);
  return `${keyType} ${blob.toString("base64")} ${comment}`;
}

async function writeHttpHostBridge(dir, sourceEndpoint, targetEndpoint) {
  const bridgePath = path.join(dir, "bridge-container-service-host.mjs");
  await writeFile(
    bridgePath,
    `import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const source = new URL(${JSON.stringify(sourceEndpoint)});
const target = new URL(${JSON.stringify(targetEndpoint)});

function redirectedOptions(options) {
  if (!options || typeof options !== "object") {
    return options;
  }
  const optionHost = options.hostname ?? options.host;
  const optionPort = String(options.port ?? (source.protocol === "https:" ? "443" : "80"));
  if (optionHost !== source.hostname || optionPort !== source.port) {
    return options;
  }
  return {
    ...options,
    hostname: target.hostname,
    host: target.hostname,
    port: target.port || (target.protocol === "https:" ? "443" : "80"),
  };
}

const originalHttpRequest = http.request.bind(http);
http.request = function request(options, callback) {
  return originalHttpRequest(redirectedOptions(options), callback);
};

const originalHttpsRequest = https.request.bind(https);
https.request = function request(options, callback) {
  return originalHttpsRequest(redirectedOptions(options), callback);
};

syncBuiltinESMExports();
`,
  );
  return pathToFileURL(bridgePath).href;
}

function nodeOptionsWithImport(importUrl) {
  return [process.env.NODE_OPTIONS, `--import=${importUrl}`].filter(Boolean).join(" ");
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
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(packageDir, name), contents)),
  );
}

async function withFakeGoogleServer(fn) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid: "fake-google-key", alg: "RS256", use: "sig" });
  let nonce = null;
  let audience = "client-id";
  const identityToken = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "https://accounts.google.com",
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce,
      sub: "google-subject-mira",
      email: "mira@example.com",
      name: "Mira",
      picture: "https://example.com/mira.png",
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      const body = await new Promise((resolve) => {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => resolve(new URLSearchParams(raw)));
      });
      audience = body.get("client_id");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: identityToken(), access_token: "container-access-token", token_type: "Bearer" }));
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
      setNonce(value) {
        nonce = value;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withFakeMicrosoftServer(fn) {
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
      sub: "microsoft-container-subject",
      preferred_username: "mutable-login@example.com",
      name: "Container Microsoft",
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
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
        location: `${requestUrl.searchParams.get("redirect_uri")}?code=container-code&state=${requestUrl.searchParams.get("state")}`,
      });
      response.end();
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id_token: identityToken(), access_token: "container-secret-access-token" }));
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
    return await fn({ discoveryUrl: `${origin}/discovery` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withFakeCapsuleService(fn) {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  try {
    return await fn({ port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withFakePostgresService(fn) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let startupHandled = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!startupHandled && buffer.length >= 4) {
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) {
          return;
        }
        buffer = buffer.subarray(length);
        startupHandled = true;
        socket.write(postgresMessage("R", int32(0)));
        socket.write(postgresMessage("Z", Buffer.from("I")));
      }
      while (startupHandled && buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < 1 + length) {
          return;
        }
        buffer = buffer.subarray(1 + length);
        if (type === "Q") {
          socket.write(postgresMessage("C", Buffer.from("SELECT 1\0")));
          socket.write(postgresMessage("Z", Buffer.from("I")));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  try {
    return await fn({ port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postgresMessage(type, body) {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child, expectedStatus = null) {
  const deadline = Date.now() + 5000;
  let lastError;
  let childStderr = "";
  child.stderr?.on("data", (chunk) => { childStderr += String(chunk); });

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server bundle exited before serving ${url}: ${childStderr.trim()}`);
    }

    try {
      const response = await fetch(url);
      if (expectedStatus === null ? response.ok : response.status === expectedStatus) {
        return response;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw lastError;
}

async function waitForJsonStdoutLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON stdout.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

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
      reject(new Error(`Server bundle exited with ${code} before JSON stdout.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await closed;
}

test("sporades deploy --json bundles and starts a container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, "uploads"), 0o755);
    await chmod(path.join(dataDir, "data.db"), 0o644);
    await chmod(path.join(dataDir, "uploads", "file.bin"), 0o644);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: true,
      data: {
        url: "http://localhost:4321",
        port: 4321,
        containerId: "container-first",
        restartPolicy: {
          mode: "bounded",
          maxAttempts: 3,
          backoffMs: 1000,
          dockerRestart: "on-failure:3",
          restartFatalEvents: ["unhandledRejection", "uncaughtException", "initHookFailed"],
          exitFatalEvents: ["sigterm", "sigint", "shutdownHookFailed"],
        },
      },
      error: null,
    });

    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(serverBundle, /todo-island/);
    assert.match(clientBundle, /Sporades Todos/);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.containerId, "container-first");
    assert.equal(binding.containerName, "sporades-todo-island");
    assert.equal(binding.clientRelease.framework, "react");
    assert.equal(binding.clientRelease.toolchain, "esbuild");
    assert.equal(binding.clientRelease.htmlEntry, "index.html");
    assert.equal(binding.clientRelease.fileCount, 3);
    assert.deepEqual(binding.clientRelease.paths, ["client.js", "client.js.map", "index.html"]);
    assert.equal(binding.clientRelease.truncated, false);

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.cwd, projectDir);
    assert.equal(runCall.args[0], "run");
    assert(runCall.args.includes("--detach"));
    assert.equal(runCall.args[runCall.args.indexOf("--name") + 1], "sporades-todo-island");
    assert.equal(runCall.args[runCall.args.indexOf("--restart") + 1], "on-failure:3");
    assert(runCall.args.includes("--read-only"));
    assert.equal(runCall.args[runCall.args.indexOf("--tmpfs") + 1], "/tmp:rw,nosuid,nodev,noexec");
    assert.equal(runCall.args[runCall.args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(runCall.args[runCall.args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert.equal(runCall.args[runCall.args.indexOf("--publish") + 1], "4321:4000");
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", "server.mjs")}:/app/server.mjs:ro`);
    const activeTree = JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree;
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "build", ".public-trees", activeTree)}:/app/public:ro`);
    assert.equal(runCall.args.some((arg) => arg.endsWith(":/app/client.js:ro") || arg.endsWith(":/app/index.html:ro")), false);
    assertVolume(runCall.args, `${path.join(projectDir, "sporades.json")}:/app/sporades.json:ro`);
    assertVolume(runCall.args, `${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`);
    assert.equal(runCall.args[runCall.args.indexOf("--env-file") + 1], path.join(projectDir, ".env.sporades.server"));
    assertVolume(runCall.args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], expectedLocalContainerRuntimeUser());
    assert(runCall.args.includes("com.sporades.base-image.name=sporades-base"));
    assert(runCall.args.includes("com.sporades.base-image.version=0.1.0-node22-alpine"));
    assert(runCall.args.includes("com.sporades.base-image.update-policy=host-managed"));
    assert(runCall.args.includes("SPORADES_LOG_STDOUT=1"));
    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.1.0-node22-alpine");
    assert(imageIndex > -1);
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      "node",
      "/app/server.mjs",
    ]);
    const preparedDataDir = await stat(dataDir);
    const preparedUploadsDir = await stat(path.join(dataDir, "uploads"));
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    const preparedUpload = await stat(path.join(dataDir, "uploads", "file.bin"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedUploadsDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedUpload.mode & 0o777, 0o600);
    assert.equal(preparedDataDir.uid, process.getuid());
    assert.equal(preparedDataDir.gid, process.getgid());
    assert.equal(preparedDatabase.uid, process.getuid());
    assert.equal(preparedDatabase.gid, process.getgid());

    const statusResult = await runCli(["deploy", "status", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    const statusData = JSON.parse(statusResult.stdout).data;
    assert.equal(statusData.container.containerId, "container-first");
    assert.deepEqual(statusData.container.clientRelease, binding.clientRelease);
  });
});

test("sporades deploy assembles a Vanilla TypeScript release without leaking Server env", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "vanilla-release", "--template", "blank", "--framework", "vanilla", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "vanilla-release"));
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SECRET_TOKEN=vanilla-server-only\n");
    const docker = await installFakeDocker(dir, "vanilla-container");
    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, "vanilla");
    assert.equal(binding.clientRelease.toolchain, "esbuild");
    assert.deepEqual(binding.clientRelease.paths, ["client.js", "client.js.map", "index.html"]);
    const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
    assert.match(clientBundle, /Vanilla Sporades/);
    assert.doesNotMatch(clientBundle, /vanilla-server-only|SECRET_TOKEN/);
  });
});

for (const capability of CLIENT_CAPABILITIES) test(`matrix Container packaging validates ${capability.framework}/${capability.toolchain}`, async () => {
  await withTempDir(async (dir) => {
    const name = `matrix-${capability.framework}-${capability.toolchain}`;
    const created = await runCli(["create", name, "--template", "blank", "--framework", capability.framework, "--toolchain", capability.toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, name));
    await (capability.framework === "vanilla" ? async () => {}
      : capability.framework === "react" ? installFakeReact
      : capability.framework === "preact" ? installFakePreact
      : capability.framework === "inferno" ? (project) => installProjectInfernoToolchain(project, repoRoot)
      : capability.framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot)
      : capability.framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot)
      : capability.framework === "vue" ? installVue
      : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), "SERVER_ONLY_MATRIX=container-secret\n");
    const docker = await installFakeDocker(dir, name);
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, capability.framework);
    assert.equal(binding.clientRelease.toolchain, capability.toolchain);
    assert(binding.clientRelease.paths.includes("index.html"));
    assert(binding.clientRelease.paths.some((file) => file.endsWith(".js")));
    assert(binding.clientRelease.paths.every((file) => !file.includes("..") && !file.includes("\\")));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.filter((file) => /\.(?:html|js|css|map|svg)$/.test(file)).map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    assert.doesNotMatch(output, /SERVER_ONLY_MATRIX|container-secret|\/@vite\/client|react-refresh/);
    assertVolume(firstDockerRunCall(await docker.calls()).args, `${publicRoot}:/app/public:ro`);
  });
});

for (const toolchain of ["esbuild", "vite"]) for (const template of ["blank", "todo", "guestbook", "photo-library", "campfire"]) test(`sporades deploy mounts native Inferno/${toolchain} ${template} output without Server env`, async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", `inferno-${template}-release`, "--template", template, "--framework", "inferno", "--toolchain", toolchain, "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, `inferno-${template}-release`));
    await installProjectInfernoToolchain(projectDir, repoRoot);
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}INFERNO_SERVER_ONLY=inferno-container-secret\n`);
    const docker = await installFakeDocker(dir, `inferno-${template}-container`);
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env }); assert.equal(deployed.code, 0, deployed.stderr);
    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, "inferno"); assert.equal(binding.clientRelease.toolchain, toolchain);
    assert(binding.clientRelease.paths.includes(toolchain === "esbuild" ? "client.js" : "index.html")); assert(binding.clientRelease.paths.some((file) => file.endsWith(".js.map"))); assert(binding.clientRelease.paths.some((file) => file.endsWith(".css")));
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
    assert.doesNotMatch(output, /inferno-container-secret|INFERNO_SERVER_ONLY|react-dom|react\/jsx-runtime|node_modules\/react/);
    const runCall = firstDockerRunCall(await docker.calls()); assertVolume(runCall.args, `${publicRoot}:/app/public:ro`);
  });
});

for (const { framework, template } of [
  { framework: "react", template: "blank" },
  { framework: "preact", template: "blank" },
  { framework: "lit", template: "blank" },
  { framework: "lit", template: "todo" },
  { framework: "lit", template: "guestbook" },
  { framework: "lit", template: "photo-library" },
  { framework: "lit", template: "campfire" },
  { framework: "solid", template: "blank" },
  { framework: "solid", template: "todo" },
  { framework: "solid", template: "guestbook" },
  { framework: "solid", template: "photo-library" },
  { framework: "solid", template: "campfire" },
  { framework: "vue", template: "blank" },
  { framework: "vue", template: "todo" },
  { framework: "vue", template: "guestbook" },
  { framework: "vue", template: "photo-library" },
  { framework: "vue", template: "campfire" },
  { framework: "svelte", template: "blank" },
  { framework: "svelte", template: "todo" },
  { framework: "svelte", template: "guestbook" },
  { framework: "svelte", template: "photo-library" },
  { framework: "svelte", template: "campfire" },
]) test(`sporades deploy mounts the complete normalized ${framework} Vite ${template} public tree`, async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(
      ["create", "vite-release", "--template", template, "--framework", framework, "--toolchain", "vite", "--no-install", "--no-git", "--json"],
      { cwd: dir },
    );
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "vite-release"));
    await (framework === "react" ? installFakeReact : framework === "preact" ? installFakePreact : framework === "lit" ? (project) => installProjectLitToolchain(project, repoRoot) : framework === "solid" ? (project) => installProjectSolidToolchain(project, repoRoot) : framework === "vue" ? installVue : (project) => installProjectSvelteToolchain(project, repoRoot))(projectDir);
    await writeFile(path.join(projectDir, ".env.sporades.server"), `${template === "photo-library" ? "GOOGLE_CLIENT_ID=dummy-client\nGOOGLE_CLIENT_SECRET=dummy-secret\n" : ""}SERVER_ONLY_TOKEN=vite-container-secret\n`);
    const docker = await installFakeDocker(dir, "vite-container");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.clientRelease.framework, framework);
    assert.equal(binding.clientRelease.toolchain, "vite");
    assert(binding.clientRelease.paths.includes("index.html"));
    assert(binding.clientRelease.paths.some((file) => /^assets\/index-[^/]+\.js$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => /^assets\/index-[^/]+\.css$/.test(file)));
    if (framework === "react" || framework === "preact") assert(binding.clientRelease.paths.some((file) => /^assets\/vite-scaffold-[^/]+\.js$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => /^assets\/sporades-mark-[^/]+\.svg$/.test(file)));
    assert(binding.clientRelease.paths.some((file) => file.endsWith(".js.map")));
    assert.equal(binding.clientRelease.paths.includes("client.js"), false);

    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", binding.clientRelease.publicTree);
    const output = (await Promise.all(binding.clientRelease.paths.map((file) => readFile(path.join(publicRoot, file), "utf8")))).join("\n");
    const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
    assert.doesNotMatch(output, /dev\.refresh\.(?:subscribe|ready|received)/, "Container client output omits Dev refresh protocol");
    assert.doesNotMatch(serverBundle, /dev\.refresh\.(?:subscribe|ready|received)/, "Container server output omits Dev refresh capability and hints");
    assert.doesNotMatch(output, /vite-container-secret|SERVER_ONLY_TOKEN|\/@vite\/client|react-refresh|vite\/hmr/i);
    if (framework === "preact") assert.doesNotMatch(output, /node_modules\/react(?:-dom)?\/|from ["']react(?:-dom)?/);
    if (framework === "solid") {
      assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(output, /react-dom|react\/jsx-runtime/);
    }
    if (framework === "lit") {
      assert.match(output, { blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/, "photo-library": /Photo Library/, campfire: /Campfire/ }[template]);
      assert.doesNotMatch(output, /react-dom|react\/jsx-runtime|node_modules\/react/);
    }
    if (framework === "vue") assert.match(output, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    if (framework === "svelte") assert.match(output, {
      blank: /Blank Sporades Capsule/, todo: /Sporades Todos/, guestbook: /Leave a note from this island/,
      "photo-library": /Photo Library/, campfire: /Campfire/,
    }[template]);
    const runCall = firstDockerRunCall(await docker.calls());
    assertVolume(runCall.args, `${publicRoot}:/app/public:ro`);
  });
});

test("sporades deploy does not require changing local runtime data ownership", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root does not exercise the normal local non-root container user");
  }

  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "data.db"), "sqlite bytes\n");
    await writeFile(path.join(dataDir, "uploads", "file.bin"), "uploaded bytes\n");
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-first");

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], expectedLocalContainerRuntimeUser());

    const preparedDataDir = await stat(dataDir);
    const preparedDatabase = await stat(path.join(dataDir, "data.db"));
    assert.equal(preparedDataDir.mode & 0o777, 0o700);
    assert.equal(preparedDatabase.mode & 0o777, 0o600);
    assert.equal(preparedDataDir.uid, process.getuid());
    assert.equal(preparedDataDir.gid, process.getgid());
    assert.equal(preparedDatabase.uid, process.getuid());
    assert.equal(preparedDatabase.gid, process.getgid());
  });
});

test("Container replacement switches one complete public tree while persistent data stays separate", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "replacement-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "replacement-island"));
    await installFakeReact(projectDir);
    const dataMarker = path.join(projectDir, ".sporades", "data", "persistent.txt");
    await mkdir(path.dirname(dataMarker), { recursive: true });
    await writeFile(dataMarker, "keep me");
    const docker = await installFakeDocker(dir, "container-replacement");

    const first = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(first.code, 0, first.stderr);
    const firstBinding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const firstRoot = path.join(projectDir, ".sporades", "build", ".public-trees", firstBinding.clientRelease.publicTree);
    assert.match(await readFile(path.join(firstRoot, "client.js"), "utf8"), /Sporades Todos/);

    const clientEntry = path.join(projectDir, "client", "index.tsx");
    await writeFile(clientEntry, (await readFile(clientEntry, "utf8")).replaceAll("Sporades Todos", "Sporades Replacement Todos"));
    const second = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(second.code, 0, second.stderr);
    const secondBinding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    const secondRoot = path.join(projectDir, ".sporades", "build", ".public-trees", secondBinding.clientRelease.publicTree);
    assert.notEqual(secondRoot, firstRoot);
    assert.doesNotMatch(await readFile(path.join(firstRoot, "client.js"), "utf8"), /Replacement Todos/);
    assert.match(await readFile(path.join(secondRoot, "client.js"), "utf8"), /Sporades Replacement Todos/);
    assert.equal(await readFile(dataMarker, "utf8"), "keep me");

    const calls = await docker.calls();
    const runs = calls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2);
    assertVolume(runs[0].args, `${firstRoot}:/app/public:ro`);
    assertVolume(runs[1].args, `${secondRoot}:/app/public:ro`);
    assertVolume(runs[0].args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    assertVolume(runs[1].args, `${path.join(projectDir, ".sporades", "data")}:/app/data:rw`);
    const stopIndex = calls.findIndex((call, index) => index > calls.indexOf(runs[0]) && call.args[0] === "stop");
    assert.ok(stopIndex > calls.indexOf(runs[0]));
    assert.ok(calls.indexOf(runs[1]) > stopIndex);
  });
});

test("Container replacement restores the previous committed state across Docker transaction failures", async (t) => {
  for (const failedAction of ["rename", "stop", "run", "rm"]) {
    await t.test(failedAction, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `rollback-${failedAction}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `rollback-${failedAction}-island`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-old-${failedAction}`);
        const initial = await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env });
        assert.equal(initial.code, 0, initial.stderr);
        const buildDir = path.join(projectDir, ".sporades", "build");
        const statePaths = {
          binding: path.join(projectDir, ".sporades", "binding.json"),
          active: path.join(buildDir, ".public-trees", "active.json"),
          consumer: path.join(buildDir, ".public-trees", ".consumers", "container.json"),
          server: path.join(buildDir, "server.mjs"),
          client: path.join(buildDir, "client.js"),
        };
        const before = Object.fromEntries(await Promise.all(Object.entries(statePaths).map(async ([key, value]) => [key, await readFile(value, "utf8")])));
        const entry = path.join(projectDir, "client", "index.tsx");
        await writeFile(entry, `${await readFile(entry, "utf8")}\nconsole.log('candidate-${failedAction}');\n`);
        const failingDocker = await installFakeDocker(path.join(dir, "failure"), `container-new-${failedAction}`, { failOnceActions: [failedAction] });
        const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: failingDocker.env });
        assert.equal(failed.code, 1, `${failedAction}: ${failed.stderr}\n${failed.stdout}`);
        for (const [key, value] of Object.entries(statePaths)) {
          assert.equal(await readFile(value, "utf8"), before[key], `${failedAction} changed ${key}`);
        }
        const calls = await failingDocker.calls();
        if (failedAction === "rename") {
          assert.equal(calls.some((call) => call.args[0] === "rm"), false, "rename failure must not remove the old canonical Container");
        } else {
          assert.ok(calls.some((call) => call.args[0] === "rename" && call.args.at(-1) === `sporades-rollback-${failedAction}-island`));
          assert.ok(calls.some((call) => call.args[0] === "start" && call.args[1] === `sporades-rollback-${failedAction}-island`));
        }
      });
    });
  }
});

test("Container replacement restores publication, consumer, binding, and cleanup faults", async (t) => {
  for (const fault of ["publication", "consumer", "binding", "cleanup"]) {
    await t.test(fault, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `rollback-${fault}-state`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `rollback-${fault}-state`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-old-${fault}`);
        assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
        const buildDir = path.join(projectDir, ".sporades", "build");
        const paths = [
          path.join(projectDir, ".sporades", "binding.json"),
          path.join(buildDir, ".public-trees", "active.json"),
          path.join(buildDir, ".public-trees", ".consumers", "container.json"),
          path.join(buildDir, "server.mjs"),
          path.join(buildDir, "client.js"),
        ];
        const before = await Promise.all(paths.map((file) => readFile(file, "utf8")));
        const entry = path.join(projectDir, "client", "index.tsx");
        await writeFile(entry, `${await readFile(entry, "utf8")}\nconsole.log('fault-${fault}');\n`);
        const docker = await installFakeDocker(path.join(dir, "failure"), `container-new-${fault}`);
        const failed = await runCli(["deploy", "--json"], {
          cwd: projectDir,
          env: { ...docker.env, SPORADES_TEST_CONTAINER_REPLACEMENT_FAULT: fault },
        });
        assert.equal(failed.code, 1, failed.stdout);
        assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, "utf8"))), before);
        const calls = await docker.calls();
        assert.ok(calls.some((call) => call.args[0] === "rename" && call.args.at(-1) === `sporades-rollback-${fault}-state`));
        assert.ok(calls.some((call) => call.args[0] === "start" && call.args[1] === `sporades-rollback-${fault}-state`));
      });
    });
  }
});

test("Container replacement fails closed before mutation when binding and consumer ownership disagree", async (t) => {
  const cases = [
    "stale-binding-successor-consumer",
    "tokenless-binding-successor-consumer",
    "missing-binding-existing-consumer",
    "binding-token-missing-consumer",
    "malformed-consumer",
    "consumer-identity-mismatch",
    "public-tree-mismatch",
    "container-name-mismatch",
  ];
  for (const mode of cases) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `ownership-${mode}`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `ownership-${mode}`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-${mode}`);
        const initial = await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env });
        assert.equal(initial.code, 0, initial.stderr);

        const buildDir = path.join(projectDir, ".sporades", "build");
        const bindingPath = path.join(projectDir, ".sporades", "binding.json");
        const consumerPath = path.join(buildDir, ".public-trees", ".consumers", "container.json");
        const binding = JSON.parse(await readFile(bindingPath, "utf8"));
        const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
        if (mode === "stale-binding-successor-consumer") {
          consumer.token = "a".repeat(32);
          consumer.identity = "successor-container";
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "tokenless-binding-successor-consumer") {
          delete binding.clientRelease.consumerToken;
          consumer.token = "b".repeat(32);
          consumer.identity = "successor-container";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "missing-binding-existing-consumer") {
          await rm(bindingPath);
        } else if (mode === "binding-token-missing-consumer") {
          await rm(consumerPath);
        } else if (mode === "malformed-consumer") {
          await writeFile(consumerPath, "{not-json\n");
        } else if (mode === "consumer-identity-mismatch") {
          consumer.identity = "different-container";
          await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
        } else if (mode === "public-tree-mismatch") {
          binding.clientRelease.publicTree = "different-public-tree";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        } else if (mode === "container-name-mismatch") {
          binding.containerName = "sporades-different-capsule";
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        }

        const observedPaths = {
          binding: bindingPath,
          consumer: consumerPath,
          active: path.join(buildDir, ".public-trees", "active.json"),
          server: path.join(buildDir, "server.mjs"),
          client: path.join(buildDir, "client.js"),
        };
        const before = Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)])));
        const beforeFiles = await relativeFiles(buildDir);
        const docker = await installFakeDocker(path.join(dir, "replacement"), `candidate-${mode}`);

        const replacement = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });

        assert.equal(replacement.code, 1, `${mode}: ${replacement.stderr}\n${replacement.stdout}`);
        assert.deepEqual(await docker.calls(), [], `${mode} reached Docker`);
        assert.deepEqual(
          Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)]))),
          before,
          `${mode} mutated committed state`,
        );
        assert.deepEqual(await relativeFiles(buildDir), beforeFiles, `${mode} mutated public-tree/build publication state`);
      });
    });
  }
});

test("Container ownership preflight rejects configured SSH changes before access or audit mutation", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "ssh-ownership-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "ssh-ownership-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = { authorizedKeys: [{ key: TEST_PUBLIC_KEY }] };
    });
    await deployOwnedContainer(projectDir, dir, "ssh-owned-container");

    const buildDir = path.join(projectDir, ".sporades", "build");
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const consumerPath = path.join(buildDir, ".public-trees", ".consumers", "container.json");
    const authorizedKeysPath = path.join(projectDir, ".sporades", "ssh", "authorized_keys");
    const auditPath = path.join(projectDir, ".sporades", "data", "logs", "events.jsonl");
    const lockPath = path.join(projectDir, ".sporades", ".container-lifecycle-lock");
    const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
    consumer.token = "c".repeat(32);
    consumer.identity = "ssh-successor-container";
    await writeFile(consumerPath, `${JSON.stringify(consumer)}\n`);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh.authorizedKeys = [{ key: TEST_PUBLIC_KEY.replace("test@example", "changed@example") }];
    });

    const observedPaths = {
      authorizedKeys: authorizedKeysPath,
      audit: auditPath,
      binding: bindingPath,
      consumer: consumerPath,
      active: path.join(buildDir, ".public-trees", "active.json"),
      server: path.join(buildDir, "server.mjs"),
      client: path.join(buildDir, "client.js"),
    };
    const before = Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)])));
    const beforeFiles = await relativeFiles(buildDir);
    const docker = await installFakeDocker(path.join(dir, "replacement"), "ssh-candidate-container");

    const replacement = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(replacement.code, 1, `${replacement.stderr}\n${replacement.stdout}`);
    assert.equal(JSON.parse(replacement.stdout).error.message, "Container replacement ownership could not be verified.");
    assert.deepEqual(await docker.calls(), []);
    assert.deepEqual(
      Object.fromEntries(await Promise.all(Object.entries(observedPaths).map(async ([key, file]) => [key, await readOptional(file)]))),
      before,
    );
    assert.deepEqual(await relativeFiles(buildDir), beforeFiles);
    await assert.rejects(stat(lockPath), (error) => error.code === "ENOENT");
  });
});

test("ambiguous docker run failure never removes an unrelated canonical-name container", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "name-conflict-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "name-conflict-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "unrelated-container", { failOnceActions: ["run"] });
    const failed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).error.message, "Failed to start the container session.");
    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
    assert.equal(calls.some((call) => call.args[0] === "inspect" && call.args.at(-1) === "unrelated-container"), false);
    await assert.rejects(stat(path.join(projectDir, ".sporades", "binding.json")), (error) => error.code === "ENOENT");
  });
});

test("unsafe Container public output fails validation before replacing the running session", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "unsafe-public-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "unsafe-public-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const outside = path.join(projectDir, "outside-client.js");
    await writeFile(outside, "unsafe replacement");

    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-never-started", { composePortOutput: `127.0.0.1:${port}`, composePsDelayMs: 750 });
      const existingTrees = new Set(await readdir(path.join(projectDir, ".sporades", "build", ".public-trees")));
      const deploying = runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
      const candidate = await waitForPublicTreeCandidate(projectDir, existingTrees);
      await rm(path.join(candidate, "client.js"));
      await symlink(outside, path.join(candidate, "client.js"));
      const result = await deploying;
      assert.equal(result.code, 1);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.error.message, "Container public tree validation failed.");
      assert.match(envelope.error.hint, /symbolic link|regular file/i);
      assert.deepEqual(envelope.error.diagnostics, {
        phase: "public",
        framework: "react",
        toolchain: "esbuild",
        cause: "Invalid public tree.",
      });
      const calls = await docker.calls();
      assert.equal(calls.some((call) => call.args[0] === "stop" || call.args[0] === "rm" || call.args[0] === "run"), false);
      assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-old");
    });
  });
});

test("missing and over-limit Container public inputs fail before replacement with guidance", async (t) => {
  for (const scenario of ["missing", "over-limit"]) {
    await t.test(scenario, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `invalid-${scenario}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `invalid-${scenario}-island`));
        await installFakeReact(projectDir);
        await deployOwnedContainer(projectDir, dir);
        if (scenario === "missing") await rm(path.join(projectDir, "index.html"));
        else await writeFile(path.join(projectDir, "index.html"), Buffer.alloc(16 * 1024 * 1024 + 1, 1));
        const docker = await installFakeDocker(dir, "container-never-started");
        const result = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
        assert.equal(result.code, 1);
        const envelope = JSON.parse(result.stdout);
        if (scenario === "missing") {
          assert.equal(envelope.error.message, "Missing HTML shell: index.html");
          assert.match(envelope.error.hint, /Restore index\.html/);
        } else {
          assert.equal(envelope.error.message, "Invalid public tree.");
          assert.match(envelope.error.hint, /index\.html exceeds the per-file public output limit/);
        }
        const calls = await docker.calls();
        assert.equal(calls.some((call) => call.args[0] === "stop" || call.args[0] === "rm" || call.args[0] === "run"), false);
        assert.equal(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")).containerId, "container-old");
      });
    });
  }
});

test("sporades deploy enables configured SSH access for local Container sessions", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "ssh-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const deployBody = JSON.parse(deployResult.stdout);
    assert.equal(deployBody.data.containerId, "container-ssh");
    assert.equal(Object.hasOwn(deployBody.data, "ssh"), false);

    const generatedKeysPath = path.join(projectDir, ".sporades", "ssh", "authorized_keys");
    assert.equal(await readFile(generatedKeysPath, "utf8"), `${TEST_PUBLIC_KEY}\n`);
    assert.equal((await stat(generatedKeysPath)).mode & 0o777, 0o644);

    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], BASE_IMAGE_RUNTIME_USER);
    assertVolume(runCall.args, `${generatedKeysPath}:/run/sporades/ssh/authorized_keys:ro`);
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"));
    assert(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_TARGET=/app/data/ssh/authorized_keys"));

    const imageIndex = runCall.args.indexOf("ghcr.io/sporades/sporades-base:0.1.0-node22-alpine");
    assert(imageIndex > -1);
    assert.deepEqual(runCall.args.slice(imageIndex), [
      "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
      "/usr/local/bin/sporades-start",
    ]);
  });
});

test("sporades deploy rejects invalid SSH keys before replacing the existing Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "invalid-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "invalid-ssh-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-existing");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: "not a public key" },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-new");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const body = JSON.parse(deployResult.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /Malformed SSH authorized key material/);
    assert.match(body.error.hint, /authorized_keys-compatible public key/);
    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});

test("sporades deploy rejects malformed SSH key blobs before replacing the existing Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bad-blob-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "bad-blob-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-existing");
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: "ssh-ed25519 @@@" },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-new");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const body = JSON.parse(deployResult.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /Malformed SSH authorized key material/);
    assert.match(body.error.hint, /authorized_keys-compatible public key/);
    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});

test("sporades deploy ssh --json reports effective local Container SSH state", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "inspect-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "inspect-ssh-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh", {
      inspectJson: JSON.stringify({
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
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const sshResult = await runCli(["deploy", "ssh", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(sshResult.code, 0, sshResult.stderr);
    const body = JSON.parse(sshResult.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.enabled, true);
    assert.equal(body.data.running, true);
    assert.equal(body.data.user, "sporades");
    assert.equal(body.data.runtimeUser, "10001:10001");
    assert.equal(body.data.host, "127.0.0.1");
    assert.equal(body.data.port, 49162);
    assert.equal(body.data.targetPort, 22);
    assert.equal(body.data.keyCount, 1);
    assert.equal(body.data.fingerprints.length, 1);
    assert.match(body.data.fingerprints[0], /^SHA256:/);
    assert.equal(body.data.reason, null);
  });
});

test("sporades deploy accepts authorized_keys file entries and treats empty effective SSH keys as disabled", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "file-ssh-island"));
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, "ops.keys"), `# ops\n\n${TEST_PUBLIC_KEY}\n`);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { file: "ops.keys" },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-file-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(
      await readFile(path.join(projectDir, ".sporades", "ssh", "authorized_keys"), "utf8"),
      `${TEST_PUBLIC_KEY}\n`,
    );

    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [],
      };
    });
    const disabledDocker = await installFakeDocker(dir, "container-disabled-ssh");
    const disabledResult = await runCli(["deploy", "--force", "--json"], {
      cwd: projectDir,
      env: disabledDocker.env,
    });
    assert.equal(disabledResult.code, 0, disabledResult.stderr);
    const runCall = (await disabledDocker.calls()).filter((call) => call.args[0] === "run").at(-1);
    assert.equal(runCall.args.includes("127.0.0.1::22"), false);
    assert.equal(runCall.args.includes("SPORADES_SSH_AUTHORIZED_KEYS_PATH=/run/sporades/ssh/authorized_keys"), false);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.slice(-2).map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.metadata.enabled, entry.data.metadata.reason]),
      [
        ["ssh.config.validated", "ssh.config.validate", "completed", false, "no-authorized-keys"],
        ["ssh.access.disabled", "ssh.container.disabled", "completed", false, "no-authorized-keys"],
      ],
    );
  });
});

test("sporades deploy accepts OpenSSH security-key public key material", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "sk-ssh-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "sk-ssh-island"));
    await installFakeReact(projectDir);
    const skPublicKey = openSshPublicKeyLine("sk-ssh-ed25519@openssh.com", [
      Buffer.alloc(32, 7),
      "ssh:",
    ]);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: skPublicKey },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-sk-ssh");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(
      await readFile(path.join(projectDir, ".sporades", "ssh", "authorized_keys"), "utf8"),
      `${skPublicKey}\n`,
    );
    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args[runCall.args.indexOf("--user") + 1], BASE_IMAGE_RUNTIME_USER);
    assert.equal(runCall.args[runCall.args.lastIndexOf("--publish") + 1], "127.0.0.1::22");
  });
});

test("sporades deploy audits SSH validation, enabled lifecycle, and inspection without leaking key material", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "ssh-audit-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "ssh-audit-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: TEST_PUBLIC_KEY },
        ],
      };
    });
    const docker = await installFakeDocker(dir, "container-ssh-audit");

    const deploy = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.equal(JSON.parse(deploy.stdout).data.ssh, undefined);
    assert.doesNotMatch(deploy.stdout, /ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|SHA256:/);

    const inspection = await runCli(["deploy", "ssh", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(inspection.code, 0, inspection.stderr);

    const logs = await runCli(["logs", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(logs.code, 0, logs.stderr);
    const auditEvents = JSON.parse(logs.stdout).data.entries.filter((entry) => entry.category === "audit");
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome]),
      [
        ["ssh.config.validated", "ssh.config.validate", "completed"],
        ["ssh.access.enabled", "ssh.container.start", "completed"],
        ["ssh.state.inspected", "ssh.container.inspect", "completed"],
      ],
    );
    const [validation, lifecycle, inspected] = auditEvents;
    assert.equal(validation.data.actorKind, "platform");
    assert.equal(validation.data.surface, "sporades/deploy");
    assert.equal(validation.data.targetResourceKind, "container-ssh-config");
    assert.equal(validation.data.metadata.enabled, true);
    assert.equal(validation.data.metadata.keyCount, 1);
    assert.deepEqual(validation.data.metadata.fingerprints, lifecycle.data.metadata.fingerprints);
    assert.equal(lifecycle.data.metadata.loopbackOnly, true);
    assert.equal(lifecycle.data.metadata.targetPort, 22);
    assert.equal(inspected.data.metadata.running, true);
    assert.equal(inspected.data.metadata.port, 49162);
    assert.equal(inspected.data.metadata.host, "127.0.0.1");
    assert.doesNotMatch(JSON.stringify(auditEvents), /ssh-ed25519|AAAAC3NzaC1lZDI1NTE5|OPENSSH PRIVATE KEY|authorized_keys/);
  });
});

test("sporades deploy rejects private-key-looking SSH material", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "private-key-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "private-key-island"));
    await installFakeReact(projectDir);
    await updateSporadesConfig(projectDir, (config) => {
      config.ssh = {
        authorizedKeys: [
          { key: "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----" },
        ],
      };
    });

    const result = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: (await installFakeDocker(dir)).env,
    });

    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout);
    assert.match(body.error.message, /private key/);
    assert.match(body.error.hint, /public authorized_keys material only/);
    const auditEvents = await readProjectAuditEvents(projectDir);
    assert.deepEqual(
      auditEvents.map((entry) => [entry.event, entry.data.operation, entry.data.outcome, entry.data.safeErrorCode]),
      [["ssh.config.validated", "ssh.config.validate", "errored", "SSH_CONFIG_INVALID"]],
    );
    assert.equal(auditEvents[0].data.metadata.reason, "invalid-ssh-config");
    assert.doesNotMatch(JSON.stringify(auditEvents), /OPENSSH PRIVATE KEY|nope/);
  });
});

test("Sporades Base image includes dormant OpenSSH and Fail2ban startup capability", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile.base"), "utf8");
  assert.match(dockerfile, /apk add --no-cache openssh-server/);
  assert.match(dockerfile, /apk add --no-cache openssh-server fail2ban/);
  assert.match(dockerfile, /\/usr\/local\/bin\/sporades-start/);
  assert.match(dockerfile, /PasswordAuthentication=no/);
  assert.match(dockerfile, /PermitRootLogin=no/);
  assert.match(dockerfile, /AllowUsers=sporades/);
  assert.match(dockerfile, /AuthorizedKeysFile="\$target"/);
  assert.match(dockerfile, /HostKey="\$ssh_dir\/ssh_host_ed25519_key"/);
  assert.match(dockerfile, /PidFile=\/tmp\/sporades-sshd\.pid/);
  assert.match(dockerfile, /adduser -u 10001 -S sporades -G sporades -s \/bin\/sh/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.doesNotMatch(dockerfile, /adduser -u 10001 -S sporades -G sporades\s+\\/);
  assert.doesNotMatch(dockerfile, /fail2ban-(?:client|server)|systemctl enable --now fail2ban|service fail2ban start/);
  assert.doesNotMatch(dockerfile, /sudoers|NOPASSWD|PermitRootLogin=yes|PasswordAuthentication=yes/);
});

test("sporades deploy writes a server bundle that serves the capsule", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const rootResponse = await waitForHttp(`http://127.0.0.1:${port}/`, child);
      assert.match(await rootResponse.text(), /<div id="app"><\/div>/);
      const clientResponse = await waitForHttp(`http://127.0.0.1:${port}/client.js`, child);
      assert.match(await clientResponse.text(), /Sporades Todos/);
    } finally {
      await stopChild(child);
    }
  });
});

test("bundled Container runtime supports email sign-in after sign-up and sign-out", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bundled-email-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "bundled-email-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auth = { providers: { anonymous: true, email: true } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-email-runtime");
    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);
      socket.send(JSON.stringify({ id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "mira@example.com", password: "correct horse battery staple", name: "Mira" } }));
      const signUp = await readSocketMessage(socket);
      assert.equal(signUp.type, "auth.signUp.result");
      socket.send(JSON.stringify({ id: "signout", type: "auth.signOut" }));
      const signOut = await readSocketMessage(socket);
      assert.equal(signOut.type, "auth.signOut.result");
      socket.send(JSON.stringify({ id: "signin", type: "auth.signIn", provider: "email", credentials: { email: "mira@example.com", password: "correct horse battery staple" } }));
      const signIn = await readSocketMessage(socket);
      assert.equal(signIn.type, "auth.signIn.result", JSON.stringify(signIn));
      assert.equal(signIn.error, null);
      assert.equal(signIn.data.auth.email, "mira@example.com");
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});

test("generated runtime does not serve fixed root client files outside the public tree", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "hosted-legacy-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "hosted-legacy-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-hosted-legacy");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const legacyRoot = path.join(dir, "legacy-hosted-mounts");
    await mkdir(legacyRoot);
    await writeFile(path.join(legacyRoot, "index.html"), "<html><body>legacy hosted html</body></html>");
    await writeFile(path.join(legacyRoot, "client.js"), "console.log('legacy hosted client');\n");
    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: legacyRoot,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(legacyRoot, "data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const root = await waitForHttp(`http://127.0.0.1:${port}/`, child, 404);
      assert.equal(root.status, 404);
      assert.equal(await root.text(), "Not found");
      const client = await waitForHttp(`http://127.0.0.1:${port}/client.js`, child, 404);
      assert.equal(client.status, 404);
      assert.equal(await client.text(), "Not found");
    } finally {
      await stopChild(child);
    }
  });
});

test("direct runtime prefers the active built tree over a conventional source public directory", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "active-tree-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "active-tree-island"));
    await installFakeReact(projectDir);
    await mkdir(path.join(projectDir, "public"));
    await writeFile(path.join(projectDir, "public", "favicon.ico"), "source-only favicon");
    const docker = await installFakeDocker(dir, "container-active-tree");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const serverBundle = path.join(projectDir, ".sporades", "build", "server.mjs");
    const start = async () => {
      const port = await getAvailablePort();
      const child = spawn(process.execPath, [serverBundle], {
        cwd: projectDir,
        env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", `active-${port}.db`) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { port, child };
    };

    const active = await start();
    try {
      const root = await waitForHttp(`http://127.0.0.1:${active.port}/`, active.child);
      assert.match(await root.text(), /<div id="app"><\/div>/);
      const client = await waitForHttp(`http://127.0.0.1:${active.port}/client.js`, active.child);
      assert.match(await client.text(), /Sporades Todos/);
      const sourceOnly = await waitForHttp(`http://127.0.0.1:${active.port}/favicon.ico`, active.child, 404);
      assert.equal(await sourceOnly.text(), "Not found");
    } finally {
      await stopChild(active.child);
    }

    const activeReference = path.join(projectDir, ".sporades", "build", ".public-trees", "active.json");
    for (const state of ["malformed", "missing"]) {
      if (state === "malformed") await writeFile(activeReference, "{\"tree\":");
      else await rm(activeReference);
      const fallback = await start();
      try {
        const sourceOnly = await waitForHttp(`http://127.0.0.1:${fallback.port}/favicon.ico`, fallback.child);
        assert.equal(await sourceOnly.text(), "source-only favicon", state);
        const root = await waitForHttp(`http://127.0.0.1:${fallback.port}/`, fallback.child, 404);
        assert.equal(await root.text(), "Not found", state);
      } finally {
        await stopChild(fallback.child);
      }
    }
  });
});

test("Container public-tree runtime serves nested built assets with stable MIME types", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "asset-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "asset-island"));
    await installFakeReact(projectDir);
    await writeFile(path.join(projectDir, "client", "lazy.ts"), "export const lazyValue = 'nested lazy chunk';\n");
    await writeFile(path.join(projectDir, "client", "styles.css"), "@font-face { font-family: Capsule; src: url('./capsule.woff2'); } body { color: teal; }\n");
    await writeFile(path.join(projectDir, "client", "capsule.woff2"), Buffer.from("fake-font"));
    await writeFile(path.join(projectDir, "client", "capsule.png"), Buffer.from("fake-png"));
    await writeFile(
      path.join(projectDir, "client", "index.tsx"),
      `${await readFile(path.join(projectDir, "client", "index.tsx"), "utf8")}\nimport './styles.css';\nimport logo from './capsule.png';\nconsole.log(logo);\nimport('./lazy').then((value) => console.log(value.lazyValue));\n`,
    );
    await writeFile(
      path.join(projectDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/client.css"></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>\n',
    );
    const docker = await installFakeDocker(dir, "container-assets");
    const deployed = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
    assert.equal(deployed.code, 0, deployed.stderr);

    const activeTreeName = JSON.parse(await readFile(path.join(projectDir, ".sporades", "build", ".public-trees", "active.json"), "utf8")).tree;
    const publicRoot = path.join(projectDir, ".sporades", "build", ".public-trees", activeTreeName);
    const files = await relativeFiles(publicRoot);
    const nestedJs = files.find((file) => /^assets\/lazy-.*\.js$/.test(file));
    const nestedMap = files.find((file) => /^assets\/lazy-.*\.js\.map$/.test(file));
    const nestedImage = files.find((file) => /^assets\/capsule-.*\.png$/.test(file));
    const nestedFont = files.find((file) => /^assets\/capsule-.*\.woff2$/.test(file));
    for (const expected of ["index.html", "client.js", "client.js.map", "assets/client.css", "assets/client.css.map", nestedJs, nestedMap, nestedImage, nestedFont]) {
      assert.ok(expected && files.includes(expected), `Expected built public asset ${expected}; got ${files.join(", ")}`);
    }

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "asset-data.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const expectedTypes = new Map([
        ["/", "text/html; charset=utf-8"],
        ["/client.js", "text/javascript; charset=utf-8"],
        ["/assets/client.css", "text/css; charset=utf-8"],
        [`/${nestedJs}`, "text/javascript; charset=utf-8"],
        [`/${nestedMap}`, "application/json; charset=utf-8"],
        [`/${nestedImage}`, "image/png"],
        [`/${nestedFont}`, "font/woff2"],
      ]);
      for (const [urlPath, contentType] of expectedTypes) {
        const response = await waitForHttp(`http://127.0.0.1:${port}${urlPath}`, child);
        assert.equal(response.status, 200, urlPath);
        assert.equal(response.headers.get("content-type"), contentType, urlPath);
      }
    } finally {
      await stopChild(child);
    }
  });
});

test("container server bundle reads injected service env and selects the libSQL adapter", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakeCapsuleService(async ({ port: serviceReadyPort }) => {
      const docker = await installFakeDocker(dir, "container-with-libsql-bundle", {
        composePortOutput: `127.0.0.1:${serviceReadyPort}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr || deployResult.stdout);
    });

    await withFakeLibsqlService(path.join(dir, "container-libsql.db"), async ({ url, requests }) => {
      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
          SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
          SPORADES_SERVICE_DATABASE_URL: url,
          SPORADES_SERVICE_DATABASE_AUTH_TOKEN: "server-only-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        const health = await fetch(`http://127.0.0.1:${port}/__sporades/health/runtime`, {
          headers: { "x-sporades-host-probe": "test" },
        });
        assert.equal(health.status, 200, await health.text());
        assert(
          requests.some((request) => request.requests?.some((entry) => entry.stmt?.sql === 'SELECT 1 AS "ok"')),
          JSON.stringify(requests),
        );
        const socket = await openSocket(`http://127.0.0.1:${port}`);
        try {
          socket.send(JSON.stringify({ id: "env-1", type: "query.subscribe", query: "ctx.env" }));
          assert.deepEqual(await readSocketMessage(socket), {
            id: "env-1",
            type: "query.result",
            query: "ctx.env",
            data: {},
            error: null,
          });
        } finally {
          socket.close();
        }
      } finally {
        await stopChild(child);
      }
    });
  });
});

test("container server bundle uses injected MinIO storage env for file lifecycle routes", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "file-island", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "file-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { storage: { kind: "storage", engine: "minio" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await seedCapsuleServiceCredentials(projectDir);

    await withFakeS3CompatibleService(async ({ endpoint, port: serviceReadyPort, requests, objects }) => {
      const docker = await installFakeDocker(dir, "container-with-minio-bundle", {
        composePortOutput: `127.0.0.1:${serviceReadyPort}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr || deployResult.stdout);

      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-file-island-services");
      const storageEnv = dockerRunEnv(runCall, "SPORADES_SERVICE_STORAGE_");
      assert.deepEqual(storageEnv, {
        SPORADES_SERVICE_STORAGE_ENGINE: "minio",
        SPORADES_SERVICE_STORAGE_ENDPOINT: "http://sporades-file-island-storage:9000",
        SPORADES_SERVICE_STORAGE_ACCESS_KEY: "sporades",
        SPORADES_SERVICE_STORAGE_SECRET_KEY: "sporades-minio-local-secret",
        SPORADES_SERVICE_STORAGE_BUCKET: "sporades-files",
        SPORADES_SERVICE_STORAGE_REGION: "us-east-1",
        SPORADES_SERVICE_STORAGE_NAMESPACE: "file-island",
      });

      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const bridgeImport = await writeHttpHostBridge(dir, storageEnv.SPORADES_SERVICE_STORAGE_ENDPOINT, endpoint);
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithImport(bridgeImport),
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
          ...storageEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let socket;
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitForHttp(`${baseUrl}/`, child);
        const health = await fetch(`${baseUrl}/__sporades/health/runtime`, {
          headers: { "x-sporades-host-probe": "test" },
        });
        assert.equal(health.status, 200, await health.text());

        socket = await openSocket(baseUrl);
        async function sendAndWait(payload) {
          socket.send(JSON.stringify(payload));
          return await waitForSocketMessage(socket, (message) => message.id === payload.id);
        }

        const auth = await sendAndWait({ id: "auth", type: "auth.get" });
        const uploadUrl = await sendAndWait({
          id: "upload-url",
          type: "file.uploadUrl",
          file: { name: "proof.txt", type: "text/plain", size: 9, path: "/proof/container/minio.txt" },
        });
        assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
        const uploadResponse = await fetch(new URL(uploadUrl.data.uploadUrl, baseUrl), {
          method: uploadUrl.data.method,
          body: "minio-one",
        });
        if (uploadResponse.status !== 200) {
          assert.fail(await uploadResponse.text());
        }
        const uploaded = await uploadResponse.json();
        assert.equal(uploaded.ok, true, uploaded.error?.message);
        assert.equal(uploaded.data.file.path, "/proof/container/minio.txt");
        const firstObjectKey = `capsules/file-island/files/${uploaded.data.file.id}/${uploaded.data.file.version}`;
        assert.equal(objects.get(firstObjectKey).toString("utf8"), "minio-one");

        const privateUrl = await sendAndWait({
          id: "private-url",
          type: "file.url",
          fileReference: "/proof/container/minio.txt",
        });
        assert.equal(privateUrl.error, null);
        const privateRead = await fetch(new URL(privateUrl.data.url, baseUrl), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(privateRead.status, 200);
        assert.equal(await privateRead.text(), "minio-one");

        const publicUrl = await sendAndWait({
          id: "public-url",
          type: "file.publicUrl.create",
          fileId: uploaded.data.file.id,
          options: { noExpiry: true },
        });
        assert.equal(publicUrl.error, null);
        const publicRead = await fetch(new URL(publicUrl.data.publicUrl.url, baseUrl));
        assert.equal(publicRead.status, 200);
        assert.equal(await publicRead.text(), "minio-one");

        const replaceUrl = await sendAndWait({
          id: "replace-url",
          type: "file.uploadUrl",
          replace: true,
          fileReference: "/proof/container/minio.txt",
          file: { name: "proof-v2.txt", type: "text/plain", size: 9 },
        });
        assert.equal(replaceUrl.error, null, replaceUrl.error?.message);
        const replaceResponse = await fetch(new URL(replaceUrl.data.uploadUrl, baseUrl), {
          method: replaceUrl.data.method,
          body: "minio-two",
        });
        if (replaceResponse.status !== 200) {
          assert.fail(await replaceResponse.text());
        }
        const replaced = await replaceResponse.json();
        assert.equal(replaced.data.file.id, uploaded.data.file.id);
        assert.notEqual(replaced.data.file.version, uploaded.data.file.version);
        assert.equal(objects.has(firstObjectKey), false);
        const replacementObjectKey = `capsules/file-island/files/${replaced.data.file.id}/${replaced.data.file.version}`;
        assert.equal(objects.get(replacementObjectKey).toString("utf8"), "minio-two");

        const stalePrivateRead = await fetch(new URL(privateUrl.data.url, baseUrl), {
          headers: { "x-sporades-session-token": auth.data.sessionToken },
        });
        assert.equal(stalePrivateRead.status, 404);
        const stalePublicRead = await fetch(new URL(publicUrl.data.publicUrl.url, baseUrl));
        assert.equal(stalePublicRead.status, 404);

        const deleteResult = await sendAndWait({
          id: "delete",
          type: "file.delete",
          fileReference: "/proof/container/minio.txt",
        });
        assert.equal(deleteResult.error, null);
        assert.equal(objects.has(replacementObjectKey), false);
        const missingAfterDelete = await fetch(new URL(`/__sporades/files/public/${publicUrl.data.publicUrl.id}?v=${replaced.data.file.version}`, baseUrl));
        assert.equal(missingAfterDelete.status, 404);

        const firstWriteRequest = requests.find((request) => request.method === "PUT" && request.url === `/sporades-files/${firstObjectKey}`);
        assert(firstWriteRequest, JSON.stringify(requests.map((request) => [request.method, request.url])));
        assert.equal(firstWriteRequest.headers.host, "sporades-file-island-storage:9000");
        const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
        assert.doesNotMatch(clientBundle, /SPORADES_SERVICE_STORAGE_/);
        assert.doesNotMatch(clientBundle, /sporades-minio-local-secret/);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});

test("sporades logs and db can inspect a local Container session by published port", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const dataDir = path.join(projectDir, ".sporades", "data");
    await mkdir(dataDir, { recursive: true });
    const docker = await installFakeDocker(dir, "container-first", { dataDir });

    const deployResult = await runCli(["deploy", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const serverPort = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(serverPort),
        SPORADES_DATABASE_PATH: path.join(dataDir, "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${serverPort}/`, child);
    } finally {
      await stopChild(child);
    }

    const logsResult = await runCli(["logs", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(logsResult.code, 0, logsResult.stderr);
    assert.deepEqual(JSON.parse(logsResult.stdout).data, {
      source: "docker",
      containerId: "container-first",
      entries: [
        {
          schema: "sporades.log.v1",
          timestamp: "2026-07-04T06:32:08.180Z",
          category: "platform",
          event: "runtime.started",
          level: "info",
          message: "Capsule runtime started",
          capsule: { name: "todo-island", id: "todo-island" },
          release: null,
          request: null,
          correlation: null,
          data: null,
          truncated: false,
        },
      ],
    });

    const dbResult = await runCli(["db", "list", "--port", "4321", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(dbResult.code, 0, dbResult.stderr || dbResult.stdout);
    assert.deepEqual(JSON.parse(dbResult.stdout).data, {
      source: "sqlite-file",
      tables: [
        "sporades",
        "sporades_auth_access_key_owners",
        "sporades_auth_access_keys",
        "sporades_auth_identities",
        "sporades_auth_oauth_states",
        "sporades_auth_sessions",
        "sporades_auth_users",
        "sporades_file_buckets",
        "sporades_file_public_urls",
        "sporades_file_uploads",
        "sporades_files",
        "sporades_jobs",
        "sporades_schedule_legacy_adoption",
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
        "sporades_user_preferences",
        "todos",
      ],
    });
  });
});

test("container server bundle requires explicit CORS and can enforce CSP", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "secure-container-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "secure-container-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.security.cors.allowedOrigins = ["https://dashboard.example.test"];
    config.security.csp.mode = "enforce";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "secure-container-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => ({
      headers: { "x-powered-by": "custom-stack", server: "custom-server" },
      body: { ok: true },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const securityResult = await runCli(["security", "--session", "hosted", "--json"], { cwd: projectDir });
    assert.equal(securityResult.code, 0, securityResult.stderr);
    const security = JSON.parse(securityResult.stdout).data.security;
    assert.deepEqual(security.cors.allowedOrigins, ["https://dashboard.example.test"]);
    assert.equal(security.csp.header, "content-security-policy");

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const blocked = await fetch(`http://127.0.0.1:${port}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://evil.example.test" },
      });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.headers.get("access-control-allow-origin"), null);
      assert.equal(blocked.headers.get("x-powered-by"), null);
      assert.equal(blocked.headers.get("server"), null);
      assert.match(blocked.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(blocked.headers.get("content-security-policy-report-only"), null);

      const allowed = await fetch(`http://127.0.0.1:${port}/integrations/ping`, {
        method: "POST",
        headers: { origin: "https://dashboard.example.test" },
      });
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://dashboard.example.test");
    } finally {
      await stopChild(child);
    }
  });
});

test("generated server bundle emits JSON logs to stdout when requested", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "stdout-data.db"),
        SPORADES_LOG_STDOUT: "1",
        SPORADES_RELEASE_ID: "20260630T221500Z-feedface",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const event = await waitForJsonStdoutLine(child);
      assert.equal(event.schema, "sporades.log.v1");
      assert.equal(event.category, "platform");
      assert.equal(event.event, "runtime.started");
      assert.equal(event.level, "info");
      assert.equal(event.message, "Capsule runtime started");
      assert.deepEqual(event.data.diagnostics.journey, { sessionInactivityMinutes: 30 });
      assert.equal(event.capsule.name, "todo-island");
      assert.deepEqual(event.release, { id: "20260630T221500Z-feedface" });
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy accepts object-shaped Base image update policy config", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.baseImage = { updatePolicy: { mode: "manual" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-manual-policy");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const runCall = firstDockerRunCall(await docker.calls());
    assert(runCall.args.includes("com.sporades.base-image.update-policy=manual"));
  });
});

test("sporades deploy writes a server bundle that runs bundled Capsule query handlers", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "query-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "query-island"));
    await writeFile(
      path.join(projectDir, "server", "helpers.ts"),
      `export function decorateGreeting(name: string) {
  return \`Hello from \${name}\`;
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, query } from "sporades/server";
import { decorateGreeting } from "./helpers";

const island = "the bundle";

export default capsule({
  name: "query-island",

  queries: {
    greeting: query(() => ({
      text: decorateGreeting(island),
      nested: { source: "container" },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);
      socket.send(JSON.stringify({ id: "greeting-1", type: "query.subscribe", query: "greeting" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "greeting-1",
        type: "query.result",
        query: "greeting",
        data: {
          text: "Hello from the bundle",
          nested: { source: "container" },
        },
        error: null,
      });
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that runs Capsule mutation handlers from the bundled module", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "bundled-mutation-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "bundled-mutation-island"));
    await writeFile(
      path.join(projectDir, "server", "todo-text.ts"),
      `export function cleanTodoText(value: string, prefix: string) {
  return prefix + value.trim().replace(/\\s+/g, " ");
}
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, mutation, query, String, table } from "sporades/server";
import { cleanTodoText } from "./todo-text";

const TODO_PREFIX = "container:";

export default capsule({
  name: "bundled-mutation-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({
        text: cleanTodoText(text, TODO_PREFIX),
        ownerId: ctx.auth.userId,
      });
      if (text.trim() === "rollback") {
        throw Object.assign(new Error("No rollback todos."), {
          hint: "Try calmer todo text.",
        });
      }
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "record", type: "mutation.run", mutation: "addTodo", args: ["  imported   helper  "] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "record",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: null,
      });

      const refreshed = await readSocketMessage(socket);
      assert.equal(refreshed.id, "todos");
      assert.equal(refreshed.type, "query.result");
      assert.equal(refreshed.error, null);
      assert.deepEqual(
        refreshed.data.map((todo) => todo.text),
        ["container:imported helper"],
      );

      socket.send(JSON.stringify({ id: "rollback", type: "mutation.run", mutation: "addTodo", args: ["rollback"] }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "rollback",
        type: "mutation.result",
        mutation: "addTodo",
        data: null,
        error: {
          message: "No rollback todos.",
          hint: "Try calmer todo text.",
        },
      });
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that awaits async Capsule handlers", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "async-container-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "async-container-island"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint, message, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "async-container-island",

  schema: {
    todos: table({
      text: String(),
      ownerId: String(),
    }).acl({ read: () => true, write: () => true }),
    auditLogs: table({
      text: String(),
      ownerId: String(),
    }),
  },

  middleware: [
    async (ctx) => {
      await Promise.resolve();
      return { ...ctx, marker: "async:" + ctx.kind };
    },
  ],

  queries: {
    greeting: query(async (ctx) => {
      await Promise.resolve();
      return { marker: ctx.marker };
    }),
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
    auditLogs: query((ctx) =>
      ctx.db.auditLogs
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "asc")
        .all()
    ),
  },

  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      ctx.db.todos.insert({ text: text + ":before-await", ownerId: ctx.auth.userId });
      await Promise.resolve();
      ctx.db.todos.insert({ text: text + ":after-await", ownerId: ctx.auth.userId });
      return { inserted: 2, marker: ctx.marker };
    }),
    privilegedEcho: mutation((ctx) =>
      ctx.privileged.run(
        { operation: "test.echo", targetResourceKind: "capsule-db" },
        (privilegedCtx) => ({ userId: privilegedCtx.auth.userId }),
      )
    ),
    privilegedMissingFile: mutation((ctx) =>
      ctx.privileged.run(
        { operation: "test.file.delete", targetResourceKind: "files" },
        (privilegedCtx) => privilegedCtx.files.delete("missing-file"),
      )
    ),
    privilegedFileOwner: mutation((ctx, fileId: string) =>
      ctx.privileged.run(
        { operation: "test.file.owner", targetResourceKind: "files" },
        async (privilegedCtx) => {
          const inspected = await privilegedCtx.files.url(fileId);
          return {
            callerUserId: ctx.auth.userId,
            ownerId: inspected.ok ? inspected.data.file.ownerId : null,
          };
        },
      )
    ),
  },

  endpoints: {
    status: endpoint({ method: "GET", path: "/status" }, async (ctx) => {
      await Promise.resolve();
      return { status: 202, body: { marker: ctx.marker } };
    }),
  },

  messages: {
    echo: message(async (ctx, data) => {
      await Promise.resolve();
      return { marker: ctx.marker, received: data };
    }),
  },

  hooks: {
    beforeMutation: [
      async ({ ctx }) => {
        await Promise.resolve();
        ctx.db.auditLogs.insert({ text: "before-hook:" + ctx.marker, ownerId: ctx.auth.userId });
      },
    ],
    afterMutation: [
      async ({ ctx, result }) => {
        await Promise.resolve();
        const todoCount = ctx.db.todos.where("ownerId", ctx.auth.userId).all().length;
        ctx.db.auditLogs.insert({
          text: "after-hook:" + result.data.inserted + ":" + todoCount,
          ownerId: ctx.auth.userId,
        });
      },
    ],
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);

      socket.send(JSON.stringify({ id: "auth", type: "auth.get" }));
      const auth = await waitForSocketMessage(socket, (message) => message.id === "auth");
      socket.send(JSON.stringify({
        id: "upload-url",
        type: "file.uploadUrl",
        file: { name: "owner-proof.txt", type: "text/plain", size: 5 },
      }));
      const uploadUrl = await waitForSocketMessage(
        socket,
        (message) => message.id === "upload-url",
      );
      assert.equal(uploadUrl.error, null, uploadUrl.error?.message);
      const uploadResponse = await fetch(
        new URL(uploadUrl.data.uploadUrl, `http://127.0.0.1:${port}`),
        { method: uploadUrl.data.method, body: "proof" },
      );
      if (uploadResponse.status !== 200) {
        assert.fail(await uploadResponse.text());
      }
      const uploaded = await uploadResponse.json();
      assert.equal(uploaded.ok, true, uploaded.error?.message);
      socket.send(JSON.stringify({ id: "greeting", type: "query.subscribe", query: "greeting" }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "greeting",
        type: "query.result",
        query: "greeting",
        data: { marker: "async:query" },
        error: null,
      });

      const endpointResponse = await fetch(`http://127.0.0.1:${port}/status`);
      assert.equal(endpointResponse.status, 202);
      assert.deepEqual(await endpointResponse.json(), { marker: "async:endpoint" });

      socket.send(JSON.stringify({ id: "echo", type: "app.send", message: "echo", data: { ok: true } }));
      assert.deepEqual(await readSocketMessage(socket), {
        id: "echo",
        type: "app.result",
        message: "echo",
        data: { marker: "async:message", received: { ok: true } },
        error: null,
      });

      socket.send(JSON.stringify({ id: "todos", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);
      socket.send(JSON.stringify({ id: "audits", type: "query.subscribe", query: "auditLogs" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      const mutationResult = waitForSocketMessage(
        socket,
        (message) => message.id === "add" && message.type === "mutation.result",
      );
      const todosRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "todos" && message.type === "query.result" && message.data.length === 2,
      );
      const auditsRefresh = waitForSocketMessage(
        socket,
        (message) => message.id === "audits" && message.type === "query.result" && message.data.length === 2,
      );
      socket.send(JSON.stringify({ id: "add", type: "mutation.run", mutation: "addTodo", args: ["ship"] }));
      assert.deepEqual(await mutationResult, {
        id: "add",
        type: "mutation.result",
        mutation: "addTodo",
        data: { inserted: 2, marker: "async:mutation" },
        error: null,
      });
      assert.deepEqual(
        (await todosRefresh).data.map((todo) => todo.text),
        ["ship:before-await", "ship:after-await"],
      );
      assert.deepEqual(
        (await auditsRefresh).data.map((audit) => audit.text),
        ["before-hook:async:mutation", "after-hook:2:2"],
      );

      socket.send(JSON.stringify({
        id: "privileged-file-owner",
        type: "mutation.run",
        mutation: "privilegedFileOwner",
        args: [uploaded.data.file.id],
      }));
      assert.deepEqual(await waitForSocketMessage(
        socket,
        (message) => message.id === "privileged-file-owner",
      ), {
        id: "privileged-file-owner",
        type: "mutation.result",
        mutation: "privilegedFileOwner",
        data: {
          callerUserId: auth.data.auth.userId,
          ownerId: auth.data.auth.userId,
        },
        error: null,
      });

      socket.send(JSON.stringify({ id: "privileged", type: "mutation.run", mutation: "privilegedEcho", args: [] }));
      assert.deepEqual(await waitForSocketMessage(
        socket,
        (message) => message.id === "privileged" && message.type === "mutation.result",
      ), {
        id: "privileged",
        type: "mutation.result",
        mutation: "privilegedEcho",
        data: { userId: "__privileged__" },
        error: null,
      });

      socket.send(JSON.stringify({
        id: "privileged-file",
        type: "mutation.run",
        mutation: "privilegedMissingFile",
        args: [],
      }));
      const privilegedFileResult = await waitForSocketMessage(
        socket,
        (message) => message.id === "privileged-file" && message.type === "mutation.result",
      );
      assert.equal(privilegedFileResult.error, null);
      assert.equal(privilegedFileResult.data.ok, false);
      assert.equal(privilegedFileResult.data.error.message, "File not found.");
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that serves registered capsule endpoints", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    ping: endpoint({ method: "POST", path: "/integrations/ping" }, () => "pong"),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/ping`, { method: "POST" });
      assert.equal(endpointResponse.status, 200);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await endpointResponse.text(), "pong");

      const missResponse = await fetch(`http://127.0.0.1:${port}/integrations/ping`);
      assert.equal(missResponse.status, 404);
      assert.equal(await missResponse.text(), "Not found");
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle that applies additive table migrations on Container session startup", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const databasePath = path.join(projectDir, ".sporades", "data", "data.db");
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const firstPort = await getAvailablePort();
    const firstServer = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(firstPort),
        SPORADES_DATABASE_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let firstSocket;
    let secondSocket;
    try {
      await waitForHttp(`http://127.0.0.1:${firstPort}/`, firstServer);
      firstSocket = await openSocket(`http://127.0.0.1:${firstPort}`);
      firstSocket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
      const sessionToken = (await readSocketMessage(firstSocket)).data.sessionToken;
      firstSocket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(firstSocket)).data, []);
      const addTodoResultPromise = waitForSocketMessage(
        firstSocket,
        (message) => message.id === "add-todo" && message.type === "mutation.result",
      );
      const todosAfterPromise = waitForSocketMessage(
        firstSocket,
        (message) =>
          message.id === "todos-before" &&
          message.type === "query.result" &&
          message.query === "todos" &&
          message.data.some((todo) => todo.text === "Container keeps me"),
      );
      firstSocket.send(
        JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Container keeps me"] }),
      );
      assert.equal((await addTodoResultPromise).error, null);
      assert.deepEqual(
        (await todosAfterPromise).data.map((todo) => todo.text),
        ["Container keeps me"],
      );
      firstSocket.close();
      firstSocket = null;
      await stopChild(firstServer);

      const serverPath = path.join(projectDir, "server", "index.ts");
      const originalServer = await readFile(serverPath, "utf8");
      await writeFile(
        serverPath,
        originalServer
          .replace(
            "todos: table({",
            `notes: table({
      text: String(),
      ownerId: String(),
    }),
    todos: table({`,
          )
          .replace(
            "todos: query((ctx) =>",
            `notes: query((ctx) =>
      ctx.db.notes
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),

    todos: query((ctx) =>`,
          )
          .replace(
            "addTodo: mutation((ctx, text: string) => {",
            `addNote: mutation((ctx, text: string) => {
      ctx.db.notes.insert({ text, ownerId: ctx.auth.userId });
    }),

    addTodo: mutation((ctx, text: string) => {`,
          ),
      );

      const redeployResult = await runCli(["deploy", "--force", "--json"], {
        cwd: projectDir,
        env: {
          ...docker.env,
          FAKE_DOCKER_CONTAINER_ID: "container-second",
          FAKE_DOCKER_MISSING_INSPECT_IDS: "container-first",
        },
      });
      assert.equal(redeployResult.code, 0, redeployResult.stderr);

      const secondPort = await getAvailablePort();
      const secondServer = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(secondPort),
          SPORADES_DATABASE_PATH: databasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForHttp(`http://127.0.0.1:${secondPort}/`, secondServer);
        secondSocket = await openSocket(`http://127.0.0.1:${secondPort}`, sessionToken);
        secondSocket.send(JSON.stringify({ id: "todos-after", type: "query.subscribe", query: "todos" }));
        assert.deepEqual(
          (await readSocketMessage(secondSocket)).data.map((todo) => todo.text),
          ["Container keeps me"],
        );
        secondSocket.send(JSON.stringify({ id: "notes-before", type: "query.subscribe", query: "notes" }));
        assert.deepEqual((await readSocketMessage(secondSocket)).data, []);
        const notesAfterPromise = waitForSocketMessage(
          secondSocket,
          (message) =>
            message.id === "notes-before" &&
            message.type === "query.result" &&
            message.query === "notes" &&
            message.data.length === 1,
        );
        const addNoteResultPromise = waitForSocketMessage(
          secondSocket,
          (message) => message.id === "add-note" && message.type === "mutation.result",
        );
        secondSocket.send(
          JSON.stringify({
            id: "add-note",
            type: "mutation.run",
            mutation: "addNote",
            args: ["Container new table works"],
          }),
        );
        assert.equal((await addNoteResultPromise).error, null);
        const notesAfter = await notesAfterPromise;
        assert.equal(notesAfter.data[0].text, "Container new table works");
      } finally {
        secondSocket?.close();
        await stopChild(secondServer);
      }
    } finally {
      firstSocket?.close();
      await stopChild(firstServer);
    }
  });
});

test("sporades deploy writes a server bundle that creates app tables from imported and shared Capsule field definitions", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "composed-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "composed-island"));
    await installFakeReact(projectDir);
    await writeFile(
      path.join(projectDir, "server", "schema.ts"),
      `import { Boolean, Date, String } from "sporades/server";

const ownershipFields = {
  ownerId: String(),
};

export const todoFields = {
  text: String(),
  done: Boolean().default(false),
  ...ownershipFields,
  dueAt: Date().default("2026-07-03T12:00:00.000Z"),
};
`,
    );
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, table } from "sporades/server";
import { todoFields } from "./schema";

export default capsule({
  name: "composed-island",

  schema: {
    todos: table(todoFields),
  },
});
`,
    );

    const docker = await installFakeDocker(dir, "container-first");
    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let socket;
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      socket = await openSocket(`http://127.0.0.1:${port}`);
      socket.send(JSON.stringify({ id: "todos-before", type: "query.subscribe", query: "todos" }));
      assert.deepEqual((await readSocketMessage(socket)).data, []);

      socket.send(JSON.stringify({ id: "add-todo", type: "mutation.run", mutation: "addTodo", args: ["Container composed"] }));
      assert.equal((await readSocketMessage(socket)).type, "mutation.result");
      const rowsAfter = await readSocketMessage(socket);
      assert.equal(rowsAfter.error, null);
      assert.equal(rowsAfter.data[0].text, "Container composed");
      assert.equal(rowsAfter.data[0].done, false);
      assert.equal(typeof rowsAfter.data[0].ownerId, "string");
      assert.equal(rowsAfter.data[0].dueAt, "2026-07-03T12:00:00.000Z");
    } finally {
      socket?.close();
      await stopChild(child);
    }
  });
});

test("sporades deploy writes a server bundle with endpoint context and structured responses", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
    await writeFile(path.join(projectDir, ".env.sporades.server"), "WEBHOOK_SECRET=container-secret\n");
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 202,
      headers: { "x-sporades-endpoint": ctx.env.WEBHOOK_SECRET },
      body: {
        method: ctx.request.method,
        path: ctx.request.path,
        header: ctx.request.headers["x-source"],
        query: ctx.request.query.source,
        body: ctx.request.body,
        authProvider: ctx.auth.provider,
      },
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-first");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/echo?source=test-suite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-source": "integration",
        },
        body: JSON.stringify({ hello: "container" }),
      });
      assert.equal(endpointResponse.status, 202);
      assert.match(endpointResponse.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(endpointResponse.headers.get("x-sporades-endpoint"), "container-secret");
      assert.deepEqual(await endpointResponse.json(), {
        method: "POST",
        path: "/integrations/echo",
        header: "integration",
        query: "test-suite",
        body: { hello: "container" },
        authProvider: "anonymous",
      });
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy endpoint request bodies are size-limited and unexpected errors are generic", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "hardened-endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "hardened-endpoint-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.http = { maxBodyBytes: 64 };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "hardened-endpoint-island",

  endpoints: {
    echo: endpoint({ method: "POST", path: "/integrations/echo" }, (ctx) => ({
      status: 200,
      body: { body: ctx.request.body },
    })),
    explode: endpoint({ method: "POST", path: "/integrations/explode" }, () => {
      const error = new Error("SQLITE_CONSTRAINT at /tmp/secret/server/index.ts:42");
      error.stack = "Error: SQLITE_CONSTRAINT\\n    at secret (/tmp/secret/server/index.ts:42:7)";
      throw error;
    }),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-hardened-endpoint");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });
    assert.equal(deployResult.code, 0, deployResult.stderr);

    const port = await getAvailablePort();
    const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
    const logPath = path.join(projectDir, ".sporades", "logs", "events.jsonl");
    const child = spawn(process.execPath, [serverBundlePath], {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: String(port),
        SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, child);
      for (const contentType of ["application/json", "text/plain"]) {
        const tooLarge = await fetch(`http://127.0.0.1:${port}/integrations/echo`, {
          method: "POST",
          headers: { "content-type": contentType },
          body: contentType === "application/json"
            ? JSON.stringify({ filler: "x".repeat(128) })
            : "x".repeat(128),
        });
        assert.equal(tooLarge.status, 413);
        assert.deepEqual(await tooLarge.json(), {
          ok: false,
          data: null,
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body is too large.",
            hint: "Send a request body at or below 64 bytes, or raise http.maxBodyBytes in sporades.json.",
          },
        });
      }

      const exploded = await fetch(`http://127.0.0.1:${port}/integrations/explode`, { method: "POST" });
      assert.equal(exploded.status, 500);
      const clientBody = await exploded.text();
      assert.deepEqual(JSON.parse(clientBody), {
        ok: false,
        data: null,
        error: {
          message: "Endpoint handler failed.",
          hint: "Check the endpoint handler and retry the request.",
        },
      });
      assert.equal(clientBody.includes("/tmp/secret"), false);
      assert.equal(clientBody.includes("SQLITE_CONSTRAINT"), false);

      const logs = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const failureLog = logs.find((entry) => entry.event === "http.request.failed" && entry.request?.path === "/integrations/explode");
      assert(failureLog, JSON.stringify(logs));
      assert.equal(failureLog.level, "error");
      assert.equal(failureLog.request.path, "/integrations/explode");
      assert.equal(failureLog.data.message, "SQLITE_CONSTRAINT at /tmp/secret/server/index.ts:42");
      assert.equal(failureLog.data.stack, "[REDACTED]");
    } finally {
      await stopChild(child);
    }
  });
});

test("sporades deploy endpoints resolve linked Google auth from the Sporades session token", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "endpoint-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "endpoint-island"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "endpoint-island",

  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: ctx.auth,
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const setResult = await runCli(
      ["auth", "set", "google", "--client-id", "client-id", "--client-secret", "client-secret", "--json"],
      { cwd: projectDir },
    );
    assert.equal(setResult.code, 0, setResult.stderr);
    const docker = await installFakeDocker(dir, "container-google-auth");

    await withFakeGoogleServer(async (google) => {
      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr);

      const port = await getAvailablePort();
      const serverBundlePath = path.join(projectDir, ".sporades", "build", "server.mjs");
      const child = spawn(process.execPath, [serverBundlePath], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
          SPORADES_GOOGLE_TOKEN_URL: google.tokenUrl,
          SPORADES_GOOGLE_JWKS_URL: google.jwksUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const anonymousAuth = await readSocketMessage(socket);
        const userId = anonymousAuth.data.auth.userId;

        socket.send(JSON.stringify({ id: "signin", type: "auth.signIn", provider: "google", returnTo: `http://127.0.0.1:${port}/integrations/auth` }));
        const signIn = await readSocketMessage(socket);
        const signInUrl = new URL(signIn.data.url);
        google.setNonce(signInUrl.searchParams.get("nonce"));
        const callbackResponse = await fetch(
          `http://127.0.0.1:${port}/__sporades/auth/google/callback?code=container-code&state=${signInUrl.searchParams.get("state")}`,
          { redirect: "manual" },
        );
        assert.equal(callbackResponse.status, 302, await callbackResponse.text());

        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
        const linkedAuth = await readSocketMessage(socket);
        assert.deepEqual(linkedAuth.data.auth, {
          userId,
          displayName: "Mira",
          email: "mira@example.com",
          picture: "https://example.com/mira.png",
          isAuthenticated: true,
          isGuest: false,
          provider: "google",
        });

        const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/auth`, {
          headers: { "x-sporades-session-token": anonymousAuth.data.sessionToken },
        });
        const endpointBody = await endpointResponse.json();
        assert.equal(endpointResponse.status, 200, JSON.stringify(endpointBody));
        assert.deepEqual(endpointBody, linkedAuth.data.auth);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});

test("sporades deploy Bundle completes Microsoft OIDC and exposes normal ctx.auth without a client SDK", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "microsoft-endpoint", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);
    const projectDir = await realpath(path.join(dir, "microsoft-endpoint"));
    await writeFile(
      path.join(projectDir, "server", "index.ts"),
      `import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "microsoft-endpoint",
  endpoints: {
    authState: endpoint({ method: "GET", path: "/integrations/auth" }, (ctx) => ({
      status: 200,
      body: ctx.auth,
    })),
  },
});
`,
    );
    await installFakeReact(projectDir);
    const configured = await runCli(
      ["auth", "set", "microsoft", "--client-id", "microsoft-client-id", "--client-secret", "microsoft-secret", "--tenant", "common", "--json"],
      { cwd: projectDir },
    );
    assert.equal(configured.code, 0, configured.stderr);
    const docker = await installFakeDocker(dir, "container-microsoft-auth");

    await withFakeMicrosoftServer(async (microsoft) => {
      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });
      assert.equal(deployResult.code, 0, deployResult.stderr);
      const clientBundle = await readFile(path.join(projectDir, ".sporades", "build", "client.js"), "utf8");
      assert.doesNotMatch(clientBundle, /@azure\/msal|microsoft-authentication-library|client_secret|microsoft-secret/i);

      const port = await getAvailablePort();
      const child = spawn(process.execPath, [path.join(projectDir, ".sporades", "build", "server.mjs")], {
        cwd: projectDir,
        env: {
          ...process.env,
          PORT: String(port),
          SPORADES_DATABASE_PATH: path.join(projectDir, ".sporades", "data.db"),
          SPORADES_MICROSOFT_DISCOVERY_URL: microsoft.discoveryUrl,
          SPORADES_OAUTH_TEST_ENDPOINTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let socket;
      try {
        await waitForHttp(`http://127.0.0.1:${port}/`, child);
        socket = await openSocket(`http://127.0.0.1:${port}`);
        socket.send(JSON.stringify({ id: "auth-before", type: "auth.get" }));
        const before = await readSocketMessage(socket);
        const userId = before.data.auth.userId;

        socket.send(JSON.stringify({
          id: "signin",
          type: "auth.signIn",
          provider: "microsoft",
          returnTo: `http://127.0.0.1:${port}/integrations/auth`,
        }));
        const signIn = await readSocketMessage(socket);
        assert.equal(signIn.type, "auth.redirect");
        const providerResponse = await fetch(signIn.data.url, { redirect: "manual" });
        const callbackResponse = await fetch(providerResponse.headers.get("location"), { redirect: "manual" });
        assert.equal(callbackResponse.status, 302, await callbackResponse.text());

        socket.send(JSON.stringify({ id: "auth-after", type: "auth.get" }));
        const linked = await readSocketMessage(socket);
        assert.deepEqual(linked.data.auth, {
          userId,
          displayName: "Container Microsoft",
          email: null,
          picture: null,
          isAuthenticated: true,
          isGuest: false,
          provider: "microsoft",
        });

        const endpointResponse = await fetch(`http://127.0.0.1:${port}/integrations/auth`, {
          headers: { "x-sporades-session-token": before.data.sessionToken },
        });
        assert.equal(endpointResponse.status, 200);
        assert.deepEqual(await endpointResponse.json(), linked.data.auth);
      } finally {
        socket?.close();
        await stopChild(child);
      }
    });
  });
});

test("sporades deploy skips the server env mount when the env file is absent", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await rm(path.join(projectDir, ".env.sporades.server"));
    const docker = await installFakeDocker(dir, "container-no-env");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    const runCall = firstDockerRunCall(await docker.calls());
    assert.equal(runCall.args.includes("--env-file"), false);
    assert.equal(
      runCall.args.includes(`${path.join(projectDir, ".env.sporades.server")}:/app/.env.sporades.server:ro`),
      false,
    );
  });
});

test("sporades deploy generates owned Compose for a declared database Capsule service", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-service-compose", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /# Sporades-owned runtime state/);
      assert.match(compose, /name: sporades-todo-island-services/);
      assert.match(compose, /sporades-todo-island-database:/);
      assert.match(compose, /image: ghcr\.io\/tursodatabase\/libsql-server:v0\.24\.32/);
      assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/sqld:rw"/);
      assert.match(compose, /sporades-todo-island-services:/);
      assert.match(compose, /com\.sporades\.managed: "true"/);
      assert.match(compose, /com\.sporades\.capsule-service\.kind: "database"/);

      const calls = await docker.calls();
      const composeUpCall = calls.find((call) => call.args[0] === "compose");
      const runCall = firstDockerRunCall(calls);
      assert.deepEqual(composeUpCall.args, [
        "compose",
        "-f",
        path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"),
        "up",
        "--detach",
      ]);
      assert(runCall.args.includes("--network"), runCall.args.join(" "));
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(calls.indexOf(composeUpCall) < calls.indexOf(runCall));
    });
  });
});

test("sporades deploy starts declared services before replacing the local Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-replacement", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.equal(output.data.containerId, "container-replacement");
      assert.deepEqual(output.data.services, {
        database: {
          status: "ready",
          engine: "libsql",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-database",
          statePath: path.join(".sporades", "services", "database"),
        },
      });
      assert.doesNotMatch(deployResult.stdout, /sporades-todo-island-database:8080/);

      const calls = await docker.calls();
      const composeUpIndex = calls.findIndex((call) => call.args[0] === "compose" && call.args.includes("up"));
      const stopIndex = calls.findIndex((call) => call.args[0] === "stop");
      const runIndex = calls.findIndex((call) => call.args[0] === "run");
      assert(composeUpIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(stopIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(runIndex >= 0, calls.map((call) => call.args).join("\n"));
      assert(composeUpIndex < stopIndex);
      assert(stopIndex < runIndex);
    });
  });
});

test("sporades deploy connects the Capsule container to declared services on the Compose network", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-service-network", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=libsql"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_URL=http://sporades-todo-island-database:8080"), runCall.args.join(" "));

      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.sporades\\/services\\/database\:\\/var\\/lib\\/sqld:rw"`));
    });
  });
});

test("sporades deploy wires Postgres Capsule database services through Compose", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "postgres",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakePostgresService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-postgres-service", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.equal(output.data.services.database.engine, "postgres");

      const credentials = await readCapsuleServiceCredentials(projectDir);
      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /image: postgres:16-alpine/);
      assert.match(compose, /POSTGRES_USER: "sporades"/);
      assert.match(compose, /POSTGRES_DB: "sporades"/);
      assert(compose.includes(`POSTGRES_PASSWORD: ${JSON.stringify(credentials.databasePassword)}`), compose);
      assert.doesNotMatch(compose, /POSTGRES_HOST_AUTH_METHOD/);
      assert.doesNotMatch(compose, /ports:/);
      assert.doesNotMatch(compose, /127\.0\.0\.1::5432/);
      assert.match(compose, /healthcheck:/);
      assert.match(compose, /pg_isready/);
      assert.match(compose, /todo-island\/\.sporades\/services\/database\:\/var\/lib\/postgresql\/data:rw"/);
      assert.match(compose, /com\.sporades\.capsule-service\.engine: "postgres"/);

      const runCall = firstDockerRunCall(await docker.calls());
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=postgres"), runCall.args.join(" "));
      assert(
        runCall.args.includes(
          `SPORADES_SERVICE_DATABASE_URL=postgres://sporades:${encodeURIComponent(credentials.databasePassword)}@sporades-todo-island-database:5432/sporades`,
        ),
        runCall.args.join(" "),
      );
    });
  });
});

test("sporades deploy wires database and MinIO storage Capsule services through Compose", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
      storage: {
        kind: "storage",
        engine: "minio",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakeCapsuleService(async ({ port }) => {
      const docker = await installFakeDocker(dir, "container-with-storage-service", {
        composePortOutput: `127.0.0.1:${port}`,
      });

      const deployResult = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: docker.env,
      });

      assert.equal(deployResult.code, 0, deployResult.stderr);
      const output = JSON.parse(deployResult.stdout);
      assert.deepEqual(output.data.services, {
        database: {
          status: "ready",
          engine: "libsql",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-database",
          statePath: path.join(".sporades", "services", "database"),
        },
        storage: {
          status: "ready",
          engine: "minio",
          network: "sporades-todo-island-services",
          containerName: "sporades-todo-island-storage",
          statePath: path.join(".sporades", "services", "storage"),
        },
      });
      const credentials = await readCapsuleServiceCredentials(projectDir);
      assert.equal(deployResult.stdout.includes(credentials.storageSecretKey), false, deployResult.stdout);
      assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

      const compose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");
      assert.match(compose, /sporades-todo-island-database:/);
      assert.match(compose, /sporades-todo-island-storage:/);
      assert.match(compose, /command: "server \/data --console-address \\":9001\\""/);
      assert(compose.includes(`MINIO_ROOT_PASSWORD: ${JSON.stringify(credentials.storageSecretKey)}`), compose);
      assert.match(compose, /com\.sporades\.capsule-service\.kind: "storage"/);
      assert.match(compose, new RegExp(`${projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.sporades\\/services\\/storage\:\\/data:rw"`));

      const calls = await docker.calls();
      const runCall = firstDockerRunCall(calls);
      assert.equal(runCall.args[runCall.args.indexOf("--network") + 1], "sporades-todo-island-services");
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_ENGINE=libsql"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_DATABASE_URL=http://sporades-todo-island-database:8080"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ENGINE=minio"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ENDPOINT=http://sporades-todo-island-storage:9000"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_ACCESS_KEY=sporades"), runCall.args.join(" "));
      assert(runCall.args.includes(`SPORADES_SERVICE_STORAGE_SECRET_KEY=${credentials.storageSecretKey}`), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_BUCKET=sporades-files"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_REGION=us-east-1"), runCall.args.join(" "));
      assert(runCall.args.includes("SPORADES_SERVICE_STORAGE_NAMESPACE=todo-island"), runCall.args.join(" "));
      assert.equal(
        calls.some((call) => call.args[0] === "compose" && call.args.includes("port")),
        false,
        "container sessions must not rely on published service ports",
      );

      const serverBundle = await readFile(path.join(projectDir, ".sporades", "build", "server.mjs"), "utf8");
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENGINE"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ENDPOINT"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_ACCESS_KEY"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_SECRET_KEY"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_BUCKET"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_REGION"/);
      assert.match(serverBundle, /"SPORADES_SERVICE_STORAGE_NAMESPACE"/);
    });
  });
});

test("sporades deploy reports Capsule service startup failures without leaking secrets", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-never-started", { composeUpStatus: 42 });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const output = JSON.parse(deployResult.stdout);
    assert.deepEqual(output, {
      ok: false,
      data: null,
      error: {
        message: "Failed to start Capsule services.",
        hint: "Check Docker is running and supports `docker compose`, then retry the command.",
        diagnostics: {
          services: {
            database: {
              status: "failed",
              engine: "libsql",
              network: "sporades-todo-island-services",
              containerName: "sporades-todo-island-database",
              statePath: path.join(".sporades", "services", "database"),
            },
          },
        },
      },
    });
    assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});

test("sporades deploy fails before replacement when a declared service is unhealthy", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-never-started", {
      composePsOutput: JSON.stringify({ State: "running", Health: "unhealthy" }),
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    const output = JSON.parse(deployResult.stdout);
    assert.equal(output.error.message, "Capsule database service did not become ready.");
    assert.equal(output.error.diagnostics.service, "database");
    assert.equal(output.error.diagnostics.engine, "libsql");
    assert.deepEqual(output.error.diagnostics.status, { state: "running", health: "unhealthy" });
    assert.deepEqual(output.error.diagnostics.services, {
      database: {
        status: "failed",
        engine: "libsql",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-database",
        statePath: path.join(".sporades", "services", "database"),
      },
    });
    assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});

test("sporades deploy fails before replacement when a declared service never reports healthy", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
        password: "super-secret-token",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-never-started", {
      composePsOutput: JSON.stringify({ State: "running", Health: "" }),
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: {
        ...docker.env,
        SPORADES_SERVICE_READINESS_TIMEOUT_MS: "20",
      },
    });

    assert.equal(deployResult.code, 1);
    const output = JSON.parse(deployResult.stdout);
    assert.equal(output.error.message, "Capsule database service did not become ready.");
    assert.equal(output.error.diagnostics.service, "database");
    assert.equal(output.error.diagnostics.engine, "libsql");
    assert.deepEqual(output.error.diagnostics.status, { state: "running", health: null });
    assert.equal(output.error.diagnostics.probe, null);
    assert.deepEqual(output.error.diagnostics.services, {
      database: {
        status: "failed",
        engine: "libsql",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-database",
        statePath: path.join(".sporades", "services", "database"),
      },
    });
    assert.doesNotMatch(deployResult.stdout, /super-secret-token/);

    const calls = await docker.calls();
    assert.equal(calls.some((call) => call.args[0] === "stop"), false);
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
  });
});

test("sporades deploy reports structured errors for unsupported Capsule service declarations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      cache: {
        kind: "redis",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported Capsule service: cache",
        hint: "Use supported Capsule service declarations: `services.database` or `services.storage`.",
      },
    });
  });
});

test("sporades deploy reports structured errors for unsupported storage service declarations", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      storage: {
        kind: "storage",
        engine: "s3",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const deployResult = await runCli(["deploy", "--json"], { cwd: projectDir });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "Unsupported storage Capsule service engine: s3",
        hint: "Use `services.storage.engine` of `minio`.",
      },
    });
  });
});

test("sporades deploy keeps Capsule service Compose names stable for a project", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "service-lab", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "service-lab"));
    await installFakeReact(projectDir);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.name = "Team Notes!";
    config.services = {
      database: {
        kind: "database",
        engine: "libsql",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await withFakeCapsuleService(async ({ port }) => {
      const firstDocker = await installFakeDocker(path.join(dir, "first"), "container-first", {
        composePortOutput: `127.0.0.1:${port}`,
      });
      const firstDeploy = await runCli(["deploy", "--json"], {
        cwd: projectDir,
        env: firstDocker.env,
      });
      assert.equal(firstDeploy.code, 0, firstDeploy.stderr);
      const firstCompose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");

      const secondDocker = await installFakeDocker(path.join(dir, "second"), "container-second", {
        composePortOutput: `127.0.0.1:${port}`,
      });
      const secondDeploy = await runCli(["deploy", "--force", "--json"], {
        cwd: projectDir,
        env: secondDocker.env,
      });
      assert.equal(secondDeploy.code, 0, secondDeploy.stderr);
      const secondCompose = await readFile(path.join(projectDir, ".sporades", "compose", "capsule-services.compose.yml"), "utf8");

      assert.equal(secondCompose, firstCompose);
      assert.match(firstCompose, /name: sporades-team-notes-services/);
      assert.match(firstCompose, /sporades-team-notes-database:/);
      assert.match(firstCompose, /service-lab\/\.sporades\/services\/database\:\/var\/lib\/sqld:rw"/);
    });
  });
});

test("sporades deploy status reports declared Capsule services and generated state as JSON", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: { kind: "database", engine: "libsql" },
      storage: { kind: "storage", engine: "minio" },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await mkdir(path.join(projectDir, ".sporades", "services", "database"), { recursive: true });
    await mkdir(path.join(projectDir, ".sporades", "services", "storage"), { recursive: true });
    const docker = await installFakeDocker(dir, "container-status", {
      composePsOutput: JSON.stringify({ State: "running", Health: "healthy" }),
    });

    const status = await runCli(["deploy", "status", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), {
      ok: true,
      data: {
        services: {
          database: {
            declared: true,
            engine: "libsql",
            status: "running",
            health: "healthy",
            network: {
              name: "sporades-todo-island-services",
              exists: true,
            },
            volume: {
              type: "bind",
              path: path.join(".sporades", "services", "database"),
              exists: true,
            },
            containerName: "sporades-todo-island-database",
            composeFile: path.join(".sporades", "compose", "capsule-services.compose.yml"),
            diagnostics: [],
          },
          storage: {
            declared: true,
            engine: "minio",
            status: "running",
            health: "healthy",
            network: {
              name: "sporades-todo-island-services",
              exists: true,
            },
            volume: {
              type: "bind",
              path: path.join(".sporades", "services", "storage"),
              exists: true,
            },
            containerName: "sporades-todo-island-storage",
            composeFile: path.join(".sporades", "compose", "capsule-services.compose.yml"),
            diagnostics: [],
          },
        },
      },
      error: null,
    });
  });
});

test("sporades dev stop stops Capsule services without deleting persisted service data", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = { database: { kind: "database", engine: "libsql" } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const stateDir = path.join(projectDir, ".sporades", "services", "database");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "kept.txt"), "still here\n");
    const docker = await installFakeDocker(dir);

    const stop = await runCli(["dev", "stop", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(await readFile(path.join(stateDir, "kept.txt"), "utf8"), "still here\n");
    assert.deepEqual(JSON.parse(stop.stdout).data.services.database.status, "stopped");
    const calls = await docker.calls();
    const downCall = calls.find((call) => call.args[0] === "compose" && call.args.includes("down"));
    assert.deepEqual(downCall.args.slice(3), ["down", "--remove-orphans"]);
  });
});

test("sporades deploy reset removes generated Capsule service state and orphans without third-party images", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.services = {
      database: { kind: "database", engine: "libsql" },
      storage: { kind: "storage", engine: "minio" },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const stateDir = path.join(projectDir, ".sporades", "services", "database");
    const storageStateDir = path.join(projectDir, ".sporades", "services", "storage");
    await mkdir(stateDir, { recursive: true });
    await mkdir(storageStateDir, { recursive: true });
    await writeFile(path.join(stateDir, "removed.txt"), "gone\n");
    await writeFile(path.join(storageStateDir, "removed.txt"), "gone\n");
    const docker = await installFakeDocker(dir, "container-reset", {
      sporadesImages: "sporades-owned-image\n",
    });

    const reset = await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(reset.code, 0, reset.stderr);
    await assert.rejects(readFile(path.join(stateDir, "removed.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(storageStateDir, "removed.txt"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(reset.stdout).data.services, {
      database: {
        status: "reset",
        engine: "libsql",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-database",
        statePath: path.join(".sporades", "services", "database"),
        removedImages: ["sporades-owned-image"],
      },
      storage: {
        status: "reset",
        engine: "minio",
        network: "sporades-todo-island-services",
        containerName: "sporades-todo-island-storage",
        statePath: path.join(".sporades", "services", "storage"),
        removedImages: ["sporades-owned-image"],
      },
    });
    const calls = await docker.calls();
    const downCall = calls.find((call) => call.args[0] === "compose" && call.args.includes("down"));
    assert.deepEqual(downCall.args.slice(3), ["down", "--remove-orphans", "--volumes"]);
    assert(calls.some((call) => call.args[0] === "rmi" && call.args.includes("sporades-owned-image")));
    assert.equal(calls.some((call) => call.args[0] === "rmi" && call.args.includes("third-party-libsql")), false);
  });
});

test("sporades deploy stop stops the bound local Container session without deleting the binding", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-bound", containerName: "sporades-todo-island" };
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir);

    const stop = await runCli(["deploy", "stop", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(stop.code, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {
      ok: true,
      data: {
        container: { status: "stopped", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["stop", "container-bound"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")), binding);
  });
});

test("sporades deploy restart starts the bound stopped local Container session", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-bound", containerName: "sporades-todo-island" };
    await writeFile(path.join(projectDir, ".sporades", "binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir);

    const restart = await runCli(["deploy", "restart", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(restart.code, 0, restart.stderr);
    assert.deepEqual(JSON.parse(restart.stdout), {
      ok: true,
      data: {
        container: { status: "running", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["start", "container-bound"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8")), binding);
  });
});

test("sporades deploy remove force-removes the bound local Container session and deletes the binding", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-bound", containerName: "sporades-todo-island" };
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir);

    const remove = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout), {
      ok: true,
      data: {
        container: { status: "removed", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["rm", "-f", "container-bound"]]);
    await assert.rejects(readFile(bindingPath, "utf8"), { code: "ENOENT" });
  });
});

test("sporades deploy remove clears a stale binding when the bound container is already gone", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await mkdir(path.join(projectDir, ".sporades"), { recursive: true });
    const binding = { containerId: "container-deleted", containerName: "sporades-todo-island" };
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    const docker = await installFakeDocker(dir, "container-new", {
      missingContainerActions: ["rm"],
    });

    const remove = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });

    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout), {
      ok: true,
      data: {
        container: { status: "removed", ...binding },
        services: {},
      },
      error: null,
    });
    assert.deepEqual((await docker.calls()).map((call) => call.args), [["rm", "-f", "container-deleted"]]);
    await assert.rejects(readFile(bindingPath, "utf8"), { code: "ENOENT" });
  });
});

test("Container remove and reset release durable public-tree consumers", async () => {
  await withTempDir(async (dir) => {
    const created = await runCli(["create", "consumer-lifecycle-island", "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
    assert.equal(created.code, 0, created.stderr);
    const projectDir = await realpath(path.join(dir, "consumer-lifecycle-island"));
    await installFakeReact(projectDir);
    const consumerPath = path.join(projectDir, ".sporades", "build", ".public-trees", ".consumers", "container.json");
    const bindingPath = path.join(projectDir, ".sporades", "binding.json");
    const docker = await installFakeDocker(dir, "consumer-container");
    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await stat(consumerPath);
    assert.equal((await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await assert.rejects(stat(consumerPath), (error) => error.code === "ENOENT");
    await assert.rejects(stat(bindingPath), (error) => error.code === "ENOENT");

    assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await stat(consumerPath);
    assert.equal((await runCli(["deploy", "reset", "--json"], { cwd: projectDir, env: docker.env })).code, 0);
    await assert.rejects(stat(consumerPath), (error) => error.code === "ENOENT");
    await assert.rejects(stat(bindingPath), (error) => error.code === "ENOENT");
  });
});

test("stale and tokenless remove callers cannot delete a successor consumer, Container, or binding", async (t) => {
  for (const mode of ["stale", "tokenless"]) {
    await t.test(mode, async () => {
      await withTempDir(async (dir) => {
        const created = await runCli(["create", `consumer-${mode}-island`, "--template", "todo", "--no-install", "--no-git", "--json"], { cwd: dir });
        assert.equal(created.code, 0, created.stderr);
        const projectDir = await realpath(path.join(dir, `consumer-${mode}-island`));
        await installFakeReact(projectDir);
        const initialDocker = await installFakeDocker(path.join(dir, "initial"), `container-${mode}`);
        assert.equal((await runCli(["deploy", "--json"], { cwd: projectDir, env: initialDocker.env })).code, 0);
        const bindingPath = path.join(projectDir, ".sporades", "binding.json");
        const consumerPath = path.join(projectDir, ".sporades", "build", ".public-trees", ".consumers", "container.json");
        const binding = JSON.parse(await readFile(bindingPath, "utf8"));
        const successor = { ...JSON.parse(await readFile(consumerPath, "utf8")), token: "f".repeat(32), identity: "successor-container" };
        await writeFile(consumerPath, `${JSON.stringify(successor)}\n`);
        if (mode === "tokenless") {
          delete binding.clientRelease.consumerToken;
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
        }
        const beforeBinding = await readFile(bindingPath, "utf8");
        const beforeConsumer = await readFile(consumerPath, "utf8");
        const docker = await installFakeDocker(path.join(dir, "remove"), `container-${mode}`);
        const removed = await runCli(["deploy", "remove", "--json"], { cwd: projectDir, env: docker.env });
        assert.equal(removed.code, 1);
        assert.equal((await docker.calls()).some((call) => call.args[0] === "rm"), false);
        assert.equal(await readFile(bindingPath, "utf8"), beforeBinding);
        assert.equal(await readFile(consumerPath, "utf8"), beforeConsumer);
      });
    });
  }
});

test("sporades deploy replaces the existing container binding before starting a new one", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir);
    const docker = await installFakeDocker(dir, "container-replacement");

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-replacement");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["image", "inspect", "rename", "stop", "run", "inspect", "rm"]);
    assert.equal(calls[2].args[1], "container-old");
    assert.match(calls[2].args[2], /^sporades-todo-island-rollback-/);
    assert.equal(calls[3].args[1], calls[2].args[2]);
    assert.equal(calls[6].args[1], calls[2].args[2]);
    assert.equal(firstDockerRunCall(calls).args[0], "run");

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.containerId, "container-replacement");
    assert.equal(binding.containerName, "sporades-todo-island");
    assert.equal(binding.clientRelease.htmlEntry, "index.html");
  });
});

test("sporades deploy --force replaces a stale binding after Docker reports no such object", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-deleted");
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingInspectIds: ["container-deleted"],
      missingInspectSubject: "object",
    });

    const deployResult = await runCli(["deploy", "--force", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-replacement");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["image", "inspect", "run", "inspect"]);

    const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
    assert.equal(binding.containerId, "container-replacement");
    assert.equal(binding.containerName, "sporades-todo-island");
    assert.equal(binding.clientRelease.htmlEntry, "index.html");
  });
});

test("sporades deploy builds the bundled Base image when pull is unavailable", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    const docker = await installFakeDocker(dir, "container-built-base-image", {
      imageInspectStatus: 1,
      pullStatus: 1,
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 0, deployResult.stderr);
    assert.equal(JSON.parse(deployResult.stdout).data.containerId, "container-built-base-image");

    const calls = await docker.calls();
    assert.deepEqual(calls.map((call) => call.args[0]), ["image", "pull", "build", "run", "inspect"]);
    assert.deepEqual(calls[0].args, ["image", "inspect", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"]);
    assert.deepEqual(calls[1].args, ["pull", "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine"]);
    assert.deepEqual(calls[2].args.slice(0, 5), [
      "build",
      "-f",
      path.join(repoRoot, "Dockerfile.base"),
      "-t",
      "ghcr.io/sporades/sporades-base:0.1.0-node22-alpine",
    ]);
    assert.equal(calls[2].args[5], repoRoot);
  });
});

test("sporades deploy fails on stale container bindings without --force", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-deleted");
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingInspectIds: ["container-deleted"],
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "The existing Container binding is stale.",
        hint: "Retry with `sporades deploy --force`; through npm, use `npm run deploy -- --force`.",
      },
    });

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["image", "inspect"],
    );
  });
});

test("sporades deploy recognizes Docker no-such-object output as a stale container binding", async () => {
  await withTempDir(async (dir) => {
    const createResult = await runCli(["create", "todo-island", "--template", "todo", "--no-install", "--no-git", "--json"], {
      cwd: dir,
    });
    assert.equal(createResult.code, 0, createResult.stderr);

    const projectDir = await realpath(path.join(dir, "todo-island"));
    await installFakeReact(projectDir);
    await deployOwnedContainer(projectDir, dir, "container-deleted");
    const docker = await installFakeDocker(dir, "container-replacement", {
      missingInspectIds: ["container-deleted"],
      missingInspectSubject: "object",
    });

    const deployResult = await runCli(["deploy", "--json"], {
      cwd: projectDir,
      env: docker.env,
    });

    assert.equal(deployResult.code, 1);
    assert.deepEqual(JSON.parse(deployResult.stdout), {
      ok: false,
      data: null,
      error: {
        message: "The existing Container binding is stale.",
        hint: "Retry with `sporades deploy --force`; through npm, use `npm run deploy -- --force`.",
      },
    });

    const calls = await docker.calls();
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["image", "inspect"],
    );
  });
});

async function openSocket(baseUrl, sessionToken = null) {
  const connectionToken = await readPageConnectionToken(baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = new WebSocket(url);
    installSessionTokenEnvelope(socket, sessionToken);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function readPageConnectionToken(baseUrl) {
  const response = await fetch(new URL("/", baseUrl));
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, "Expected served page to include a Sporades connection token.");
  return match[1];
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

function readSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message."));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }
    function onMessage(event) {
      cleanup();
      resolve(JSON.parse(event.data));
    }
    function onError(event) {
      cleanup();
      reject(event.error ?? new Error("WebSocket failed."));
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function waitForSocketMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_WEBSOCKET_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    }
    function onError() {
      cleanup();
      reject(new Error("WebSocket error"));
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}
