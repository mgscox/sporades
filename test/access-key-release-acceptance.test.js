import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { createAccessKeySecret } from "../dist/access-keys-runtime.js";
import { createClientRuntimeSource } from "../dist/templates/client-runtime-template.js";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const enabled = process.env.SPORADES_ACCESS_KEY_ACCEPTANCE === "1";
const timeoutMs = 30_000;

const CAPSULE_SOURCE = `
import { String, capsule, endpoint, job, requireAuth, table } from "sporades/server";

export default capsule({
  name: "access-key-release-acceptance",
  accessKeys: { scopes: ["requests:read", "requests:write", "files:read", "jobs:enqueue"] },
  teams: { appRoles: ["reader"] },
  files: {
    accessKeys: { read: { scopes: ["files:read"] } },
    acl: { read: ({ file, ctx }) => ctx.acl.teams.isMember(file.path.split("/")[2]) },
  },
  schema: {
    records: table({ ownerId: String(), teamId: String(), body: String() }).acl({
      read: ({ row, ctx }) => row.ownerId === ctx.auth.userId && ctx.acl.teams.isMember(row.teamId),
    }),
    jobRuns: table({ ownerId: String(), credentialKind: String(), credentialId: String(), credentialName: String(), records: String() }).acl({
      read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
    }),
  },
  middleware: [(ctx) => Object.assign(ctx, { admittedCredential: ctx.credential })],
  jobs: {
    capture: job(async (ctx, payload) => {
      await ctx.db.records.all();
      await ctx.db.jobRuns.insert({
        ownerId: ctx.auth.userId,
        credentialKind: ctx.credential.kind,
        credentialId: ctx.credential.kind === "access-key" ? ctx.credential.id : "",
        credentialName: ctx.credential.kind === "access-key" ? ctx.credential.name : "",
        records: "authority-evaluated",
      });
      return { payload };
    }),
  },
  endpoints: {
    setup: endpoint({ method: "POST", path: "/acceptance/setup" }, requireAuth({ credentials: ["session"] }, async (ctx) => {
      const { teams } = await ctx.teams.list();
      const team = teams[0];
      await ctx.db.records.insert({ ownerId: ctx.auth.userId, teamId: team.id, body: "owner and Team authority" });
      return { body: { teamId: team.id, credential: ctx.credential } };
    })),
    session: endpoint({ method: "GET", path: "/acceptance/session" }, requireAuth({ credentials: ["session"] }, (ctx) => ({
      body: { userId: ctx.auth.userId, credential: ctx.credential },
    }))),
    mixed: endpoint({ method: "GET", path: "/acceptance/mixed" }, requireAuth((ctx) => ({
      body: { userId: ctx.auth.userId, credential: ctx.credential },
    }))),
    read: endpoint({ method: "GET", path: "/acceptance/read" }, requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, async (ctx) => ({
      body: {
        userId: ctx.auth.userId,
        provider: ctx.auth.provider,
        credential: ctx.credential,
        middlewareCredential: ctx.admittedCredential,
        records: await ctx.db.records.all(),
        jobRuns: await ctx.db.jobRuns.all(),
      },
    }))),
    write: endpoint({ method: "POST", path: "/acceptance/write" }, requireAuth({ credentials: ["access-key"], scopes: ["requests:write"] }, () => ({ body: { ok: true } }))),
    enqueue: endpoint({ method: "POST", path: "/acceptance/jobs" }, requireAuth({ credentials: ["access-key"], scopes: ["jobs:enqueue"] }, async (ctx) => ({
      body: await ctx.jobs.enqueue("capture", { source: "acceptance" }, { availableAt: "2999-01-01T00:00:00.000Z" }),
    }))),
    unwrapped: endpoint({ method: "GET", path: "/acceptance/unwrapped" }, (ctx) => {
      const authorization = ctx.request.headers.authorization;
      return { body: {
        provider: ctx.auth.provider,
        authorizationPresent: typeof authorization === "string",
        bearerLooking: authorization?.startsWith("Bearer ") === true,
      } };
    }),
  },
});
`;

const CAPSULE_WITHOUT_FILE_ACCESS_SOURCE = CAPSULE_SOURCE.replace(
  '    accessKeys: { read: { scopes: ["files:read"] } },\n',
  "",
);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runCli(args, cwd, options = {}) {
  try {
    const result = await run(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeout ?? 240_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

function lastJsonLine(output) {
  return JSON.parse(output.trim().split("\n").at(-1));
}

async function readConnectionToken(baseUrl) {
  const deadline = Date.now() + timeoutMs;
  let response;
  let lastError;
  while (Date.now() < deadline) {
    try {
      response = await fetch(baseUrl);
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!response) throw lastError ?? new Error("Acceptance runtime did not become reachable.");
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(html);
  assert.ok(match, "served page must carry its WebSocket connection token");
  return match[1];
}

async function openSocket(baseUrl, sessionToken = null) {
  const connectionToken = await readConnectionToken(baseUrl);
  const url = new URL("/__sporades/ws", baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("connectionToken", connectionToken);
  const socket = new WebSocket(url, { origin: baseUrl });
  if (sessionToken) {
    const originalSend = socket.send.bind(socket);
    socket.send = (raw) => {
      const message = JSON.parse(String(raw));
      return originalSend(JSON.stringify({ ...message, sessionToken }));
    };
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening acceptance WebSocket.")), timeoutMs);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (event) => { clearTimeout(timer); reject(event.error ?? new Error("WebSocket failed.")); }, { once: true });
  });
  return socket;
}

function sendAndWait(socket, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${payload.type}.`)), timeoutMs);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== payload.id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify(payload));
  });
}

async function installFakeReact(projectDir) {
  for (const [name, files, exports] of [
    ["react", {
      "index.js": "export function useEffect() {}\nexport function useState(value) { return [value, () => {}]; }\n",
      "jsx-runtime.js": "export const Fragment = Symbol.for('react.fragment');\nexport function jsx(type, props) { return { type, props }; }\nexport const jsxs = jsx;\n",
    }, { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" }],
    ["react-dom", { "client.js": "export function createRoot() { return { render() {} }; }\n" }, { "./client": "./client.js" }],
  ]) {
    const packageDir = path.join(projectDir, "node_modules", name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports }));
    await Promise.all(Object.entries(files).map(([file, source]) => writeFile(path.join(packageDir, file), source)));
  }
}

async function startDev(projectDir) {
  const child = (await import("node:child_process")).spawn(process.execPath, [cliPath, "dev", "--json"], {
    cwd: projectDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let started;
  try {
    started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Dev did not start.\n${stderr}`)), 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      const poll = () => {
        const line = stdout.split("\n").find((candidate) => candidate.trim());
        if (line) {
          clearTimeout(timer);
          try { resolve(JSON.parse(line)); }
          catch (error) { reject(error); }
          return;
        }
        if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`Dev exited ${child.exitCode}.\n${stdout}\n${stderr}`)); return; }
        setTimeout(poll, 25);
      };
      poll();
    });
    assert.equal(started.ok, true, JSON.stringify(started));
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    throw error;
  }
  return {
    baseUrl: started.data.url,
    output: () => `${stdout}\n${stderr}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function installPublicClient(baseUrl, sessionToken) {
  const connectionToken = await readConnectionToken(baseUrl);
  const storage = new Map([["sporades.sessionToken", sessionToken]]);
  const pageListeners = new Map();
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage, WebSocket: globalThis.WebSocket };
  const restoreGlobals = () => {
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous.localStorage;
    if (previous.WebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = previous.WebSocket;
  };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = {
    __SPORADES_CONNECTION_TOKEN: connectionToken,
    location: { href: `${baseUrl}/`, assign() {}, reload() {} },
    addEventListener(type, listener) { pageListeners.set(type, listener); },
  };
  globalThis.WebSocket = class AcceptanceWebSocket extends WebSocket {
    constructor(url) { super(url, { origin: baseUrl }); }
  };
  const source = `${createClientRuntimeSource()}\n// acceptance-${Date.now()}-${Math.random()}`;
  let client;
  try { client = await import(`data:text/javascript,${encodeURIComponent(source)}`); }
  catch (error) { restoreGlobals(); throw error; }
  return {
    accessKeys: client.accessKeys,
    close() {
      try { pageListeners.get("pagehide")?.(); }
      finally { restoreGlobals(); }
    },
  };
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), options);
  const body = await response.json();
  return { response, body };
}

async function waitForResponseStatus(baseUrl, pathname, options, expectedStatus) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(pathname, baseUrl), options);
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${pathname} to return ${expectedStatus}; last status was ${lastStatus ?? "unreachable"}.`);
}

async function waitForContainerJob(projectDir, jobId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await runCli(["deploy", "jobs"], projectDir);
    if (last.code === 0) {
      const job = lastJsonLine(last.stdout).data.jobs.find((entry) => entry.id === jobId);
      if (job?.status === "succeeded") return { command: last, job };
      if (job?.status === "failed") throw new Error(`Acceptance Job failed: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for acceptance Job ${jobId}.\n${last?.stdout ?? ""}\n${last?.stderr ?? ""}`);
}

async function proveHostedActionContract(projectDir, ownerUserId, keyId) {
  const bin = path.join(projectDir, ".sporades", "acceptance-host-bin");
  const config = path.join(projectDir, ".sporades", "acceptance-host-config");
  const helperOutput = path.join(projectDir, ".sporades", "acceptance-host-helper-output.json");
  const dockerOutput = path.join(projectDir, ".sporades", "acceptance-host-docker-output.json");
  await mkdir(bin, { recursive: true });
  await mkdir(config, { recursive: true });
  const binding = JSON.parse(await readFile(path.join(projectDir, ".sporades", "binding.json"), "utf8"));
  const dockerExecutable = (await run("which", ["docker"])).stdout.trim();
  const dockerWrapper = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "inspect") args[args.length - 1] = ${JSON.stringify(binding.containerId)};
if (args[0] === "exec") args[1] = ${JSON.stringify(binding.containerId)};
const result = spawnSync(${JSON.stringify(dockerExecutable)}, args, { encoding: "utf8" });
writeFileSync(${JSON.stringify(dockerOutput)}, JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`;
  await writeFile(path.join(bin, "docker"), dockerWrapper);
  await chmod(path.join(bin, "docker"), 0o755);
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh
read input
output=$(printf '%s\\n' "$input" | ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(repoRoot, "bin", "sporades-host-helper.js"))})
printf '%s\\n' "$output" > ${JSON.stringify(helperOutput)}
printf '%s\\n' "$output"
`);
  await chmod(path.join(bin, "ssh"), 0o755);
  await writeFile(path.join(config, "hosts.json"), JSON.stringify({
    profiles: { acceptance: { server: "local-contract", domain: "example.test", scheme: "https", remoteRoot: "/srv/sporades" } },
  }));
  const result = await runCli([
    "access-keys", "inspect", keyId, "--session", "hosted", "--host", "acceptance", "--subname", "release-acceptance", "--json",
  ], projectDir, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPORADES_CONFIG_DIR: config } });
  assert.equal(result.code, 0, `${result.stderr || result.stdout}\nHost helper: ${await readFile(helperOutput, "utf8").catch(() => "<no output>")}\nDocker: ${await readFile(dockerOutput, "utf8").catch(() => "<no output>")}`);
  const envelope = lastJsonLine(result.stdout);
  assert.equal(envelope.data.accessKey.id, keyId);
  assert.equal(envelope.data.accessKey.ownerUserId, ownerUserId);
  return result;
}

function updateSqlite(databasePath, sql, ...values) {
  const database = new DatabaseSync(databasePath);
  try { return database.prepare(sql).run(...values); }
  finally { database.close(); }
}

async function createOfflinePasswordResetCode(projectDir, email) {
  const { createEmailPasswordResetLink, openDevDatabase, resolveAnonymousSession } =
    await import("../dist/server-runtime-source.js");
  const database = await openDevDatabase(path.join(projectDir, ".sporades", "data", "data.db"), "", {}, {
    name: "access-key-release-acceptance",
    auth: { providers: { email: { enabled: true } } },
  }, { name: "access-key-release-acceptance", accessKeys: { scopes: ["requests:read", "requests:write", "files:read", "jobs:enqueue"] } }, {
    runtimeActionOnly: true,
  });
  try {
    const result = await createEmailPasswordResetLink(database, await resolveAnonymousSession(database, null), email);
    assert.equal(result.ok, true, result.error?.message);
    return new URL(result.link).searchParams.get("code");
  } finally { await database.close(); }
}

function responseCapture(result) {
  return {
    status: result.response.status,
    headers: Object.fromEntries(result.response.headers.entries()),
    body: result.body,
  };
}

function assertOpaqueDenied(result, status, code, challenge = null) {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("www-authenticate"), challenge);
  assert.doesNotMatch(JSON.stringify(result.body), /requests:|files:|jobs:|access-key-release/i);
}

async function filesContaining(root, needle) {
  const found = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && (await stat(target)).size <= 25 * 1024 * 1024) {
        const contents = await readFile(target);
        if (contents.includes(Buffer.from(needle))) found.push(path.relative(root, target));
      }
    }
  }
  await visit(root);
  return found;
}

test("a linked Session carries one scoped canary through real Dev and fresh Container runtimes", {
  skip: enabled ? false : "Set SPORADES_ACCESS_KEY_ACCEPTANCE=1 to run the Docker release acceptance.",
  timeout: 360_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sporades-access-key-release-"));
  const projectName = "access-key-release-acceptance";
  const projectDir = path.join(root, projectName);
  let dev;
  let client;
  const captured = [];
  const httpCapture = [];
  const cliCapture = [];
  const disclosedSecrets = [];
  const fetchAcceptance = async (...args) => {
    const result = await fetchJson(...args);
    httpCapture.push(responseCapture(result));
    return result;
  };
  try {
    const created = await runCli(["create", projectName, "--template", "blank", "--no-install", "--no-git", "--json"], root);
    assert.equal(created.code, 0, created.stderr);
    const configPath = path.join(projectDir, "sporades.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.dev.port = 0;
    config.auth = { providers: { email: { enabled: true } } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(path.join(projectDir, "server", "index.ts"), CAPSULE_SOURCE);
    await installFakeReact(projectDir);

    dev = await startDev(projectDir);
    const signupSocket = await openSocket(dev.baseUrl);
    const signup = await sendAndWait(signupSocket, {
      id: "acceptance-signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "release-acceptance@example.com", password: "correct horse battery staple", name: "Release Owner" },
    });
    assert.equal(signup.error, null, JSON.stringify(signup));
    signupSocket.close();
    const sessionToken = signup.data.sessionToken;
    const sessionHeaders = { "x-sporades-session-token": sessionToken };

    const setup = await fetchAcceptance(dev.baseUrl, "/acceptance/setup", { method: "POST", headers: sessionHeaders });
    assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
    assert.deepEqual(setup.body.credential, { kind: "session" });
    const session = await fetchAcceptance(dev.baseUrl, "/acceptance/session", { headers: sessionHeaders });
    assert.equal(session.response.status, 200);
    assert.deepEqual(session.body.credential, { kind: "session" });

    const fileSocket = await openSocket(dev.baseUrl, sessionToken);
    const upload = await sendAndWait(fileSocket, {
      id: "acceptance-upload",
      type: "file.uploadUrl",
      file: { name: "acceptance.txt", path: `/teams/${setup.body.teamId}/acceptance.txt`, type: "text/plain", size: 16 },
    });
    assert.equal(upload.error, null, JSON.stringify(upload));
    assert.equal((await fetch(new URL(upload.data.uploadUrl, dev.baseUrl), { method: "PUT", body: "acceptance bytes" })).status, 200);
    fileSocket.close();

    client = await installPublicClient(dev.baseUrl, sessionToken);
    const issued = await client.accessKeys.issue({
      name: "release canary",
      grants: ["requests:read", "files:read", "jobs:enqueue"],
    });
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    const canary = issued.data.token;
    disclosedSecrets.push(canary);
    captured.push({ disclosure: issued });
    const bearer = { authorization: `Bearer ${canary}` };
    const admitted = await fetchAcceptance(dev.baseUrl, "/acceptance/read", { headers: bearer });
    assert.equal(admitted.response.status, 200, JSON.stringify(admitted.body));
    assert.equal(admitted.response.headers.get("cache-control"), "private, no-store");
    assert.equal(admitted.body.userId, signup.data.auth.userId);
    assert.equal(admitted.body.provider, "access-key");
    assert.deepEqual(admitted.body.credential, { kind: "access-key", id: issued.data.accessKey.id, name: "release canary" });
    assert.deepEqual(admitted.body.middlewareCredential, admitted.body.credential);
    assert.deepEqual(admitted.body.records.map((row) => row.body), ["owner and Team authority"]);
    captured.push({ admitted: admitted.body });

    const mixed = await fetchAcceptance(dev.baseUrl, "/acceptance/mixed", { headers: bearer });
    assert.equal(mixed.response.status, 200);
    assert.deepEqual(mixed.body.credential, admitted.body.credential);
    const wrongKind = await fetchAcceptance(dev.baseUrl, "/acceptance/read", { headers: sessionHeaders });
    assertOpaqueDenied(wrongKind, 403, "FORBIDDEN");
    const missingScope = await fetchAcceptance(dev.baseUrl, "/acceptance/write", { method: "POST", headers: bearer });
    assertOpaqueDenied(missingScope, 403, "FORBIDDEN");
    const missing = await fetchAcceptance(dev.baseUrl, "/acceptance/read");
    assertOpaqueDenied(missing, 401, "UNAUTHENTICATED", 'Bearer realm="sporades"');
    const malformed = await fetchAcceptance(dev.baseUrl, "/acceptance/read", { headers: { authorization: "Bearer malformed" } });
    assertOpaqueDenied(malformed, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const dual = await fetchAcceptance(dev.baseUrl, "/acceptance/read", { headers: { ...bearer, ...sessionHeaders } });
    assertOpaqueDenied(dual, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const unwrapped = await fetchAcceptance(dev.baseUrl, "/acceptance/unwrapped", { headers: bearer });
    assert.deepEqual(unwrapped.body, { provider: "anonymous", authorizationPresent: true, bearerLooking: true });

    const fileUrl = `/__sporades/files/private/${upload.data.file.id}?v=${encodeURIComponent(upload.data.file.version)}`;
    const privateFile = await fetch(new URL(fileUrl, dev.baseUrl), { headers: bearer });
    assert.equal(privateFile.status, 200);
    assert.equal(await privateFile.text(), "acceptance bytes");
    await writeFile(path.join(projectDir, "server", "index.ts"), CAPSULE_WITHOUT_FILE_ACCESS_SOURCE);
    const fileDeniedResponse = await waitForResponseStatus(dev.baseUrl, fileUrl, { headers: bearer }, 404);
    const fileDeniedBody = await fileDeniedResponse.text();
    assert.equal(fileDeniedResponse.headers.get("www-authenticate"), null);
    httpCapture.push({ status: fileDeniedResponse.status, headers: Object.fromEntries(fileDeniedResponse.headers.entries()), body: fileDeniedBody });
    const legacyFile = await fetch(new URL(fileUrl, dev.baseUrl), { headers: { ...bearer, ...sessionHeaders } });
    assert.equal(legacyFile.status, 200, "without File opt-in, Authorization remains uninterpreted beside a valid Session");
    assert.equal(await legacyFile.text(), "acceptance bytes");
    await writeFile(path.join(projectDir, "server", "index.ts"), CAPSULE_SOURCE);
    const restoredFile = await waitForResponseStatus(dev.baseUrl, fileUrl, { headers: bearer }, 200);
    assert.equal(await restoredFile.text(), "acceptance bytes");
    httpCapture.push({ status: restoredFile.status, headers: Object.fromEntries(restoredFile.headers.entries()), body: "<private-file-bytes>" });

    const enqueued = await fetchAcceptance(dev.baseUrl, "/acceptance/jobs", { method: "POST", headers: bearer });
    assert.equal(enqueued.response.status, 200, JSON.stringify(enqueued.body));
    assert.deepEqual(enqueued.body.enqueuedBy, {
      mode: "user",
      userId: signup.data.auth.userId,
      credential: admitted.body.credential,
    });
    captured.push({ enqueued: enqueued.body });

    const devPort = Number(new URL(dev.baseUrl).port);
    client.close();
    client = null;
    await dev.stop();
    const devOutput = dev.output();
    dev = null;

    updateSqlite(
      path.join(projectDir, ".sporades", "data.db"),
      "UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?",
      "2000-01-01T00:00:00.000Z",
      enqueued.body.id,
    );

    const containerData = path.join(projectDir, ".sporades", "data");
    await mkdir(containerData, { recursive: true });
    await cp(path.join(projectDir, ".sporades", "data.db"), path.join(containerData, "data.db"));
    await cp(path.join(projectDir, ".sporades", "files"), path.join(containerData, "files"), { recursive: true });

    const containerPort = await reservePort();
    const deployed = await runCli(["deploy", "--port", String(containerPort), "--json"], projectDir, { timeout: 300_000 });
    assert.equal(deployed.code, 0, deployed.stderr || deployed.stdout);
    cliCapture.push(deployed);
    const deployment = lastJsonLine(deployed.stdout);
    const containerUrl = deployment.data.url;
    client = await installPublicClient(containerUrl, sessionToken);
    const containerSession = await fetchAcceptance(containerUrl, "/acceptance/session", { headers: sessionHeaders });
    assert.equal(containerSession.response.status, 200);
    assert.deepEqual(containerSession.body.credential, { kind: "session" });

    const completedJob = await waitForContainerJob(projectDir, enqueued.body.id);
    cliCapture.push(completedJob.command);
    assert.deepEqual(completedJob.job.enqueuedBy, enqueued.body.enqueuedBy);
    const jobEvidence = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: bearer });
    assert.equal(jobEvidence.response.status, 200, JSON.stringify(jobEvidence.body));
    assert.deepEqual(jobEvidence.body.jobRuns.map(({ ownerId, credentialKind, credentialId, credentialName, records }) => ({ ownerId, credentialKind, credentialId, credentialName, records })), [{
      ownerId: signup.data.auth.userId,
      credentialKind: "access-key",
      credentialId: issued.data.accessKey.id,
      credentialName: "release canary",
      records: "authority-evaluated",
    }]);

    const hostedContract = await proveHostedActionContract(projectDir, signup.data.auth.userId, issued.data.accessKey.id);
    cliCapture.push(hostedContract);
    const listed = await client.accessKeys.list();
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.accessKeys.some((key) => key.id === issued.data.accessKey.id), true);
    const rotated = await client.accessKeys.rotate(issued.data.accessKey.id, { lifecycleRevision: issued.data.accessKey.lifecycleRevision });
    assert.equal(rotated.error, null, JSON.stringify(rotated.error));
    disclosedSecrets.push(rotated.data.token);
    captured.push({ rotationDisclosure: rotated });
    const old = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: bearer });
    assertOpaqueDenied(old, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const rotatedBearer = { authorization: `Bearer ${rotated.data.token}` };
    assert.equal((await fetchAcceptance(containerUrl, "/acceptance/read", { headers: rotatedBearer })).response.status, 200);
    assert.equal((await fetch(new URL(fileUrl, containerUrl), { headers: rotatedBearer })).status, 200);

    const jobs = await runCli(["deploy", "jobs"], projectDir);
    assert.equal(jobs.code, 0, jobs.stderr || jobs.stdout);
    cliCapture.push(jobs);
    const inspectedJobs = lastJsonLine(jobs.stdout).data.jobs;
    const inspected = inspectedJobs.find((entry) => entry.id === enqueued.body.id);
    assert.equal(inspected.status, "succeeded");
    assert.deepEqual(inspected.enqueuedBy, enqueued.body.enqueuedBy);
    assert.equal(JSON.stringify(inspected).includes(canary), false);

    const expiring = await client.accessKeys.issue({
      name: "expiring acceptance",
      grants: ["requests:read"],
      expiresAt: new Date(Date.now() + 250).toISOString(),
    });
    assert.equal(expiring.error, null, JSON.stringify(expiring.error));
    disclosedSecrets.push(expiring.data.token);
    captured.push({ expiringDisclosure: expiring });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const expired = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${expiring.data.token}` } });
    assertOpaqueDenied(expired, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');

    const unknownToken = createAccessKeySecret().token;
    disclosedSecrets.push(unknownToken);
    const initiallyUnknown = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${unknownToken}` } });
    assertOpaqueDenied(initiallyUnknown, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    let unknown = initiallyUnknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      unknown = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${unknownToken}` } });
    }
    assertOpaqueDenied(unknown, 429, "RATE_LIMITED");

    const revoked = await client.accessKeys.revoke(issued.data.accessKey.id);
    assert.equal(revoked.error, null, JSON.stringify(revoked.error));
    const deniedRevoked = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: rotatedBearer });
    assertOpaqueDenied(deniedRevoked, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');

    const ownerIneligible = await client.accessKeys.issue({ name: "owner eligibility acceptance", grants: ["requests:read"] });
    assert.equal(ownerIneligible.error, null, JSON.stringify(ownerIneligible.error));
    disclosedSecrets.push(ownerIneligible.data.token);
    captured.push({ ownerIneligibleDisclosure: ownerIneligible });
    client.close();
    client = null;

    const stoppedForOwner = await runCli(["deploy", "stop", "--json"], projectDir);
    assert.equal(stoppedForOwner.code, 0, stoppedForOwner.stderr || stoppedForOwner.stdout);
    cliCapture.push(stoppedForOwner);
    const containerDatabasePath = path.join(projectDir, ".sporades", "data", "data.db");
    updateSqlite(containerDatabasePath, "UPDATE sporades_auth_users SET isAuthenticated = 0 WHERE id = ?", signup.data.auth.userId);
    const restartedIneligible = await runCli(["deploy", "restart", "--json"], projectDir, { timeout: 120_000 });
    assert.equal(restartedIneligible.code, 0, restartedIneligible.stderr || restartedIneligible.stdout);
    cliCapture.push(restartedIneligible);
    const ineligibleResponse = await waitForResponseStatus(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${ownerIneligible.data.token}` } }, 401);
    const ineligibleDenied = { response: ineligibleResponse, body: await ineligibleResponse.json() };
    httpCapture.push(responseCapture(ineligibleDenied));
    assertOpaqueDenied(ineligibleDenied, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');

    const stoppedForRestore = await runCli(["deploy", "stop", "--json"], projectDir);
    assert.equal(stoppedForRestore.code, 0, stoppedForRestore.stderr || stoppedForRestore.stdout);
    cliCapture.push(stoppedForRestore);
    updateSqlite(containerDatabasePath, "UPDATE sporades_auth_users SET isAuthenticated = 1 WHERE id = ?", signup.data.auth.userId);
    const restartedEligible = await runCli(["deploy", "restart", "--json"], projectDir, { timeout: 120_000 });
    assert.equal(restartedEligible.code, 0, restartedEligible.stderr || restartedEligible.stdout);
    cliCapture.push(restartedEligible);
    const eligibleResponse = await waitForResponseStatus(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${ownerIneligible.data.token}` } }, 200);
    const eligibleResult = { response: eligibleResponse, body: await eligibleResponse.json() };
    httpCapture.push(responseCapture(eligibleResult));

    client = await installPublicClient(containerUrl, sessionToken);
    const resetTarget = await client.accessKeys.issue({ name: "password reset acceptance", grants: ["requests:read"] });
    assert.equal(resetTarget.error, null, JSON.stringify(resetTarget.error));
    disclosedSecrets.push(resetTarget.data.token);
    captured.push({ resetDisclosure: resetTarget });
    client.close();
    client = null;

    const stoppedForReset = await runCli(["deploy", "stop", "--json"], projectDir);
    assert.equal(stoppedForReset.code, 0, stoppedForReset.stderr || stoppedForReset.stdout);
    cliCapture.push(stoppedForReset);
    const resetCode = await createOfflinePasswordResetCode(projectDir, "release-acceptance@example.com");
    const restartedForReset = await runCli(["deploy", "restart", "--json"], projectDir, { timeout: 120_000 });
    assert.equal(restartedForReset.code, 0, restartedForReset.stderr || restartedForReset.stdout);
    cliCapture.push(restartedForReset);
    const resetSocket = await openSocket(containerUrl);
    const confirmedReset = await sendAndWait(resetSocket, {
      id: "acceptance-password-reset",
      type: "auth.confirmPasswordReset",
      code: resetCode,
      newPassword: "replacement horse battery staple",
    });
    assert.equal(confirmedReset.error, null, JSON.stringify(confirmedReset));
    const resetDenied = await fetchAcceptance(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${resetTarget.data.token}` } });
    assertOpaqueDenied(resetDenied, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const signedInAgain = await sendAndWait(resetSocket, {
      id: "acceptance-signin-after-reset",
      type: "auth.signIn",
      provider: "email",
      credentials: { email: "release-acceptance@example.com", password: "replacement horse battery staple" },
    });
    assert.equal(signedInAgain.error, null, JSON.stringify(signedInAgain));
    resetSocket.close();
    client = await installPublicClient(containerUrl, signedInAgain.data.sessionToken);
    const recovered = await client.accessKeys.list();
    assert.equal(recovered.error, null, JSON.stringify(recovered.error));
    assert.equal(recovered.data.accessKeys.find((key) => key.id === resetTarget.data.accessKey.id).revocationCause, "password-reset");
    client.close();
    client = null;

    const logs = await runCli(["logs", "--port", String(containerPort), "--json"], projectDir);
    assert.equal(logs.code, 0, logs.stderr || logs.stdout);
    cliCapture.push(logs);

    const removed = await runCli(["deploy", "remove", "--json"], projectDir);
    assert.equal(removed.code, 0, removed.stderr || removed.stdout);
    cliCapture.push(removed);

    const redactedDisclosureCapture = JSON.stringify(captured.map((entry) => ({
      ...entry,
      disclosure: entry.disclosure ? { ...entry.disclosure, data: { ...entry.disclosure.data, token: "<one-time>" } } : undefined,
      rotationDisclosure: entry.rotationDisclosure ? { ...entry.rotationDisclosure, data: { ...entry.rotationDisclosure.data, token: "<one-time>" } } : undefined,
      expiringDisclosure: entry.expiringDisclosure ? { ...entry.expiringDisclosure, data: { ...entry.expiringDisclosure.data, token: "<one-time>" } } : undefined,
      ownerIneligibleDisclosure: entry.ownerIneligibleDisclosure ? { ...entry.ownerIneligibleDisclosure, data: { ...entry.ownerIneligibleDisclosure.data, token: "<one-time>" } } : undefined,
      resetDisclosure: entry.resetDisclosure ? { ...entry.resetDisclosure, data: { ...entry.resetDisclosure.data, token: "<one-time>" } } : undefined,
    })));
    const nonDisclosureSurfaces = JSON.stringify({
      http: httpCapture,
      cli: cliCapture,
      devOutput,
      disclosedResultsAfterRedaction: JSON.parse(redactedDisclosureCapture),
    });
    const retainedBySecret = {};
    for (const secret of disclosedSecrets) {
      const retained = await filesContaining(projectDir, secret);
      retainedBySecret[secret === canary ? "canary" : `secret-${Object.keys(retainedBySecret).length + 1}`] = retained;
      assert.deepEqual(retained, [], `a bearer secret persisted in ${retained.join(", ")}`);
      assert.equal(nonDisclosureSurfaces.includes(secret), false, "a bearer secret escaped into a captured non-disclosure surface");
    }
    t.diagnostic(JSON.stringify({
      devPort,
      containerPort: Number(new URL(containerUrl).port),
      userId: signup.data.auth.userId,
      keyId: issued.data.accessKey.id,
      jobId: enqueued.body.id,
      hostedActionContract: "cli-to-host-helper-to-container-exec-to-generated-bundle",
      scannedBearerCount: disclosedSecrets.length,
      retainedBearerFiles: Object.values(retainedBySecret).flat().length,
    }));
  } finally {
    client?.close();
    await dev?.stop();
    await runCli(["deploy", "remove", "--json"], projectDir).catch(() => null);
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
