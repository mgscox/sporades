import { waitForHttp } from "./http-readiness.js";
import { preservedDeployFilePath } from "../../dist/deploy-files.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import NodeWebSocket from "ws";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withFakeS3CompatibleService } from "./fake-s3-compatible-service.js";
import { withFakeLibsqlService } from "./libsql-http-service.js";
import { installProjectVueToolchain } from "./project-vue-toolchain.js";
import { installProjectSvelteToolchain } from "./project-svelte-toolchain.js";
import { installProjectSolidToolchain } from "./project-solid-toolchain.js";
import { installProjectLitToolchain } from "./project-lit-toolchain.js";
import { installProjectInfernoToolchain } from "./project-inferno-toolchain.js";
import { CLIENT_CAPABILITIES } from "../../dist/client-capabilities.js";
import { installPrerenderWarnings, assertPrerenderWarnings } from "./prerender-warnings.js";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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


async function deployOwnedContainer(projectDir, dir, containerId = "container-old") {
  const docker = await installFakeDocker(path.join(dir, "owned-container"), containerId);
  const result = await runCli(["deploy", "--json"], { cwd: projectDir, env: docker.env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
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
  // This executable uses require even when TMPDIR is inside this ESM repository.
  await writeFile(path.join(fakeBinDir, "package.json"), '{"type":"commonjs"}\n');
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
if (call.args[0] === "run" && call.args.some((arg) => arg.endsWith(":/file:rw"))) {
  const target = call.args.find((arg) => arg.endsWith(":/file:rw")).slice(0, -":/file:rw".length);
  const info = require("node:fs").statSync(target);
  process.stdout.write(JSON.stringify({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode & 0o777 }));
  process.exit(0);
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
if (call.args[0] === "compose" && call.args.includes("config")) {
  let resolved;
  if (process.env.SPORADES_COMPOSE_TEST_BINARY) {
    const result = require("node:child_process").spawnSync(process.env.SPORADES_COMPOSE_TEST_BINARY, call.args.slice(1), { encoding: "utf8", env: process.env });
    if (result.status !== 0) { process.stderr.write(result.stderr || "Compose config failed"); process.exit(result.status || 1); }
    resolved = JSON.parse(result.stdout);
  } else {
    const model = JSON.parse(readFileSync(call.args[call.args.indexOf("-f") + 1], "utf8"));
    resolved = JSON.parse(JSON.stringify(model).replace(/\\$\\{(SPORADES_SVC_[A-Za-z0-9_]+):\\?\\}/g, (_match, key) => process.env[key] || ""));
  }
  if (process.env.FAKE_DOCKER_COMPOSE_TAMPER) Object.values(resolved.services).find(s => s.labels?.["com.sporades.capsule-service.kind"] === "container").user = "0";
  process.stdout.write(JSON.stringify(resolved));
  process.exit(0);
}
if (call.args[0] === "compose" && call.args.includes("up")) {
  process.exit(Number(process.env.FAKE_DOCKER_COMPOSE_UP_STATUS ?? "0"));
}
if (call.args[0] === "compose" && call.args.includes("ps")) {
  if (process.env.FAKE_DOCKER_COMPOSE_PS_HOOK) require(process.env.FAKE_DOCKER_COMPOSE_PS_HOOK);
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
      FAKE_DOCKER_COMPOSE_PS_HOOK: options.composePsHook ?? "",
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


async function declareClamavFileIngress(projectDir) {
  await writeFile(path.join(projectDir, "server", "index.ts"), `import { capsule, endpoint } from "sporades/server";
const multipart = { maxFiles: 1, maxFileBytes: 1024, maxTotalFileBytes: 1024, maxFieldCount: 1, maxFieldBytes: 1024, maxTotalFieldBytes: 1024, allowedPathPrefixes: ["/attachments"], requestKeyHeader: "idempotency-key", partKeyHeader: "content-id", requireStablePartKeys: false, inspection: { policyRevision: "container-readiness-v1", requiredInspectors: ["clamav"] } };
export default capsule({ name: "container-readiness", endpoints: { upload: endpoint({ method: "POST", path: "/upload", body: { multipart } }, () => ({ status: 204 })) } });
`);
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


async function openSocket(baseUrl, sessionToken = null, origin = null) {
  const connectionToken = await readPageConnectionToken(baseUrl);
  return new Promise((resolve, reject) => {
    const url = new URL("/__sporades/ws", baseUrl);
    url.searchParams.set("connectionToken", connectionToken);
    const socket = origin ? new NodeWebSocket(url, { origin }) : new WebSocket(url);
    installSessionTokenEnvelope(socket, sessionToken);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}


async function readPageConnectionToken(baseUrl) {
  const response = await fetch(new URL("/", baseUrl), { headers: { "sec-fetch-dest": "document" } });
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
export {
repoRoot,
cliPath,
TEST_WEBSOCKET_TIMEOUT_MS,
BASE_IMAGE_RUNTIME_USER,
TEST_PUBLIC_KEY,
withTempDir,
relativeFiles,
readOptional,
deployOwnedContainer,
runCli,
installFakeDocker,
readProjectAuditEvents,
expectedLocalContainerRuntimeUser,
firstDockerRunCall,
capsuleServiceCredentialsPath,
readCapsuleServiceCredentials,
seedCapsuleServiceCredentials,
dockerRunEnv,
assertVolume,
updateSporadesConfig,
declareClamavFileIngress,
sshString,
openSshPublicKeyLine,
writeHttpHostBridge,
nodeOptionsWithImport,
installFakeReact,
installFakePreact,
installVue,
writePackage,
withFakeGoogleServer,
withFakeMicrosoftServer,
withFakeCapsuleService,
withFakePostgresService,
postgresMessage,
int32,
getAvailablePort,
waitForJsonStdoutLine,
stopChild,
installEnvProbeQuery,
assertUnknownEnvQuery,
openSocket,
readPageConnectionToken,
installSessionTokenEnvelope,
readSocketMessage,
waitForSocketMessage
};
