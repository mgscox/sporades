import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
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
  },
  middleware: [(ctx) => Object.assign(ctx, { admittedCredential: ctx.credential })],
  jobs: {
    capture: job(async (ctx, payload) => ({
      payload,
      auth: ctx.auth,
      credential: ctx.credential,
      records: (await ctx.db.records.all()).length,
    })),
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
      },
    }))),
    write: endpoint({ method: "POST", path: "/acceptance/write" }, requireAuth({ credentials: ["access-key"], scopes: ["requests:write"] }, () => ({ body: { ok: true } }))),
    enqueue: endpoint({ method: "POST", path: "/acceptance/jobs" }, requireAuth({ credentials: ["access-key"], scopes: ["jobs:enqueue"] }, async (ctx) => ({
      body: await ctx.jobs.enqueue("capture", { source: "acceptance" }, { availableAt: "2999-01-01T00:00:00.000Z" }),
    }))),
    unwrapped: endpoint({ method: "GET", path: "/acceptance/unwrapped" }, (ctx) => ({
      body: { provider: ctx.auth.provider, authorization: ctx.request.headers.authorization },
    })),
  },
});
`;

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
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Dev did not start.\n${stderr}`)), 60_000);
    const poll = () => {
      const line = stdout.split("\n").find((candidate) => candidate.trim());
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); return; }
      if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`Dev exited ${child.exitCode}.\n${stdout}\n${stderr}`)); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.equal(started.ok, true, JSON.stringify(started));
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
  const client = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return {
    accessKeys: client.accessKeys,
    close() {
      pageListeners.get("pagehide")?.();
      globalThis.window = previous.window;
      globalThis.localStorage = previous.localStorage;
      globalThis.WebSocket = previous.WebSocket;
    },
  };
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), options);
  const body = await response.json();
  return { response, body };
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
  let containerStarted = false;
  const captured = [];
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

    const setup = await fetchJson(dev.baseUrl, "/acceptance/setup", { method: "POST", headers: sessionHeaders });
    assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
    assert.deepEqual(setup.body.credential, { kind: "session" });
    const session = await fetchJson(dev.baseUrl, "/acceptance/session", { headers: sessionHeaders });
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
    captured.push({ disclosure: issued });
    const bearer = { authorization: `Bearer ${canary}` };
    const admitted = await fetchJson(dev.baseUrl, "/acceptance/read", { headers: bearer });
    assert.equal(admitted.response.status, 200, JSON.stringify(admitted.body));
    assert.equal(admitted.response.headers.get("cache-control"), "private, no-store");
    assert.equal(admitted.body.userId, signup.data.auth.userId);
    assert.equal(admitted.body.provider, "access-key");
    assert.deepEqual(admitted.body.credential, { kind: "access-key", id: issued.data.accessKey.id, name: "release canary" });
    assert.deepEqual(admitted.body.middlewareCredential, admitted.body.credential);
    assert.deepEqual(admitted.body.records.map((row) => row.body), ["owner and Team authority"]);
    captured.push({ admitted: admitted.body });

    const mixed = await fetchJson(dev.baseUrl, "/acceptance/mixed", { headers: bearer });
    assert.equal(mixed.response.status, 200);
    assert.deepEqual(mixed.body.credential, admitted.body.credential);
    const wrongKind = await fetchJson(dev.baseUrl, "/acceptance/read", { headers: sessionHeaders });
    assertOpaqueDenied(wrongKind, 403, "FORBIDDEN");
    const missingScope = await fetchJson(dev.baseUrl, "/acceptance/write", { method: "POST", headers: bearer });
    assertOpaqueDenied(missingScope, 403, "FORBIDDEN");
    const missing = await fetchJson(dev.baseUrl, "/acceptance/read");
    assertOpaqueDenied(missing, 401, "UNAUTHENTICATED", 'Bearer realm="sporades"');
    const malformed = await fetchJson(dev.baseUrl, "/acceptance/read", { headers: { authorization: "Bearer malformed" } });
    assertOpaqueDenied(malformed, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const dual = await fetchJson(dev.baseUrl, "/acceptance/read", { headers: { ...bearer, ...sessionHeaders } });
    assertOpaqueDenied(dual, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const unwrapped = await fetchJson(dev.baseUrl, "/acceptance/unwrapped", { headers: bearer });
    assert.equal(unwrapped.body.authorization, `Bearer ${canary}`);
    assert.equal(unwrapped.body.provider, "anonymous");

    const fileUrl = `/__sporades/files/private/${upload.data.file.id}?v=${encodeURIComponent(upload.data.file.version)}`;
    const privateFile = await fetch(new URL(fileUrl, dev.baseUrl), { headers: bearer });
    assert.equal(privateFile.status, 200);
    assert.equal(await privateFile.text(), "acceptance bytes");
    const enqueued = await fetchJson(dev.baseUrl, "/acceptance/jobs", { method: "POST", headers: bearer });
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

    const containerData = path.join(projectDir, ".sporades", "data");
    await mkdir(containerData, { recursive: true });
    await cp(path.join(projectDir, ".sporades", "data.db"), path.join(containerData, "data.db"));
    await cp(path.join(projectDir, ".sporades", "files"), path.join(containerData, "files"), { recursive: true });

    const containerPort = await reservePort();
    const deployed = await runCli(["deploy", "--port", String(containerPort), "--json"], projectDir, { timeout: 300_000 });
    assert.equal(deployed.code, 0, deployed.stderr || deployed.stdout);
    containerStarted = true;
    const deployment = lastJsonLine(deployed.stdout);
    const containerUrl = deployment.data.url;
    client = await installPublicClient(containerUrl, sessionToken);
    const listed = await client.accessKeys.list();
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(listed.data.accessKeys.some((key) => key.id === issued.data.accessKey.id), true);
    const rotated = await client.accessKeys.rotate(issued.data.accessKey.id, { lifecycleRevision: issued.data.accessKey.lifecycleRevision });
    assert.equal(rotated.error, null, JSON.stringify(rotated.error));
    captured.push({ rotationDisclosure: rotated });
    const old = await fetchJson(containerUrl, "/acceptance/read", { headers: bearer });
    assertOpaqueDenied(old, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    const rotatedBearer = { authorization: `Bearer ${rotated.data.token}` };
    assert.equal((await fetchJson(containerUrl, "/acceptance/read", { headers: rotatedBearer })).response.status, 200);
    assert.equal((await fetch(new URL(fileUrl, containerUrl), { headers: rotatedBearer })).status, 200);

    const jobs = await runCli(["deploy", "jobs"], projectDir);
    assert.equal(jobs.code, 0, jobs.stderr || jobs.stdout);
    const inspectedJobs = lastJsonLine(jobs.stdout).data.jobs;
    const inspected = inspectedJobs.find((entry) => entry.id === enqueued.body.id);
    assert.deepEqual(inspected.enqueuedBy, enqueued.body.enqueuedBy);
    assert.equal(JSON.stringify(inspected).includes(canary), false);

    const expiring = await client.accessKeys.issue({
      name: "expiring acceptance",
      grants: ["requests:read"],
      expiresAt: new Date(Date.now() + 250).toISOString(),
    });
    assert.equal(expiring.error, null, JSON.stringify(expiring.error));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const expired = await fetchJson(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${expiring.data.token}` } });
    assertOpaqueDenied(expired, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');

    const unknownToken = createAccessKeySecret().token;
    let unknown;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      unknown = await fetchJson(containerUrl, "/acceptance/read", { headers: { authorization: `Bearer ${unknownToken}` } });
    }
    assertOpaqueDenied(unknown, 429, "AUTH_RATE_LIMITED");

    const revoked = await client.accessKeys.revoke(issued.data.accessKey.id);
    assert.equal(revoked.error, null, JSON.stringify(revoked.error));
    const deniedRevoked = await fetchJson(containerUrl, "/acceptance/read", { headers: rotatedBearer });
    assertOpaqueDenied(deniedRevoked, 401, "UNAUTHENTICATED", 'Bearer realm="sporades", error="invalid_token"');
    client.close();
    client = null;

    const logs = await runCli(["logs", "--port", String(containerPort), "--json"], projectDir);
    assert.equal(logs.code, 0, logs.stderr || logs.stdout);
    assert.equal(logs.stdout.includes(canary) || logs.stderr.includes(canary), false);

    const removed = await runCli(["deploy", "remove", "--json"], projectDir);
    assert.equal(removed.code, 0, removed.stderr || removed.stdout);
    containerStarted = false;

    const retained = await filesContaining(projectDir, canary);
    assert.deepEqual(retained, [], `canary persisted in ${retained.join(", ")}`);
    const nonDisclosureCapture = JSON.stringify(captured.map((entry) => ({
      ...entry,
      disclosure: entry.disclosure ? { ...entry.disclosure, data: { ...entry.disclosure.data, token: "<one-time>" } } : undefined,
      rotationDisclosure: entry.rotationDisclosure ? { ...entry.rotationDisclosure, data: { ...entry.rotationDisclosure.data, token: "<one-time>" } } : undefined,
    })));
    assert.equal(nonDisclosureCapture.includes(canary), false);
    assert.equal(devOutput.includes(canary), false);
    assert.equal(deployed.stdout.includes(canary) || deployed.stderr.includes(canary) || jobs.stdout.includes(canary) || jobs.stderr.includes(canary), false);
    t.diagnostic(JSON.stringify({
      devPort,
      containerPort: Number(new URL(containerUrl).port),
      userId: signup.data.auth.userId,
      keyId: issued.data.accessKey.id,
      jobId: enqueued.body.id,
      canaryRetainedFiles: retained.length,
    }));
  } finally {
    client?.close();
    await dev?.stop();
    if (containerStarted) await runCli(["deploy", "remove", "--json"], projectDir).catch(() => null);
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
