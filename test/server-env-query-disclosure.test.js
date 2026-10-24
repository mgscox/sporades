import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, mutation, query, requireAuth } from "../dist/server.js";
import { resolveAnonymousSession } from "../dist/auth-runtime.js";
import { bundleServerCapsuleModule } from "../dist/bundle-pipeline.js";
import { createServerBundleModuleSource } from "../dist/templates/server-bundle-module-graph.js";
import { openDevDatabase, routeEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";

// Dummy values only. They exist so a disclosure is detectable, never to model a real secret.
const DUMMY_ENV = { DUMMY_SERVER_SECRET: "synthetic-only" };
const DISCLOSURE = /DUMMY_SERVER_SECRET|synthetic-only/;

function assertUnknownQueryWithoutEnv(result, label) {
  assert.doesNotMatch(JSON.stringify(result), DISCLOSURE, label);
  assert.equal(result.data ?? null, null, label);
  assert.equal(result.rows ?? null, null, label);
  assert.equal(result.error?.message, "Unknown query: ctx.env", label);
}

const probeDefinition = () => capsule({
  name: "env-disclosure",
  queries: {
    // Bounded, non-secret assertion: server handlers keep trusted ctx.env access.
    envProbe: query((ctx) => ({ hasDummySecret: ctx.env.DUMMY_SERVER_SECRET === "synthetic-only" })),
  },
  mutations: {
    issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)),
  },
  endpoints: {
    envProbe: endpoint({ method: "GET", path: "/env-probe" }, requireAuth({ credentials: ["access-key"] }, (ctx) => ({
      body: { hasDummySecret: ctx.env.DUMMY_SERVER_SECRET === "synthetic-only", credential: ctx.credential.kind },
    }))),
  },
});

async function seedLinkedUser(database) {
  const auth = {
    userId: "env-linked-human",
    displayName: "Linked Human",
    email: "linked@example.test",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  await database.adapter.insertAuthUser({
    id: auth.userId,
    createdAt: "2026-10-23T12:00:00.000Z",
    displayName: auth.displayName,
    email: auth.email,
    picture: auth.picture,
    isAuthenticated: 1,
    isGuest: 0,
    provider: auth.provider,
  });
  const token = `env-session-${auth.userId}`;
  await database.adapter.insertAuthSession({
    token,
    userId: auth.userId,
    provider: auth.provider,
    createdAt: "2026-10-23T12:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return { auth, token };
}

async function requestEndpoint(database, pathName, headers = {}) {
  const request = {
    url: pathName,
    method: "GET",
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {},
  };
  const response = {
    status: null,
    body: "",
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body); },
  };
  assert.equal(await routeEndpoint(database, request, response), true);
  return { status: response.status, body: JSON.parse(response.body) };
}

test("direct runtime: no caller obtains server env through the undeclared ctx.env query name", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-env-disclosure-"));
  const definition = probeDefinition();
  const database = await openDevDatabase(path.join(dir, "data.db"), "", { ...DUMMY_ENV }, { name: definition.name }, definition);
  try {
    const anonymous = await resolveAnonymousSession(database, null);
    assertUnknownQueryWithoutEnv(await runQuery(database, anonymous.auth, "ctx.env"), "anonymous");
    assertUnknownQueryWithoutEnv(await runQuery(database, anonymous.auth, "ctx.env", [{}]), "anonymous with args");

    const { auth, token } = await seedLinkedUser(database);
    assertUnknownQueryWithoutEnv(await runQuery(database, auth, "ctx.env", [], { sessionToken: token }), "linked human");

    const issued = await runMutation(database, auth, "issueKey", [{ name: "env-probe" }], { sessionToken: token });
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    // The Access-key owner's identity reaches the same query path no differently.
    assertUnknownQueryWithoutEnv(await runQuery(database, auth, "ctx.env", [], { sessionToken: token }), "access-key owner");

    // Trusted server handlers keep ctx.env.
    const probe = await runQuery(database, anonymous.auth, "envProbe");
    assert.deepEqual(probe.data, { hasDummySecret: true });
    const keyed = await requestEndpoint(database, "/env-probe", { authorization: `Bearer ${issued.data.token}` });
    assert.equal(keyed.status, 200);
    assert.deepEqual(keyed.body, { hasDummySecret: true, credential: "access-key" });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct runtime: an explicitly declared query may use the ctx.env name under the normal contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-env-declared-"));
  const definition = capsule({
    name: "env-declared",
    queries: { "ctx.env": query((ctx) => ({ keyCount: Object.keys(ctx.env).length })) },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", { ...DUMMY_ENV }, { name: definition.name }, definition);
  try {
    const anonymous = await resolveAnonymousSession(database, null);
    const result = await runQuery(database, anonymous.auth, "ctx.env");
    assert.equal(result.error, null);
    assert.deepEqual(result.data, { keyCount: 1 });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const bundleSource = `import { capsule, endpoint, mutation, query, requireAuth } from "sporades/server";
export default capsule({
  name: "env-disclosure-bundle",
  queries: {
    envProbe: query((ctx) => ({ hasDummySecret: ctx.env.DUMMY_SERVER_SECRET === "synthetic-only" })),
  },
  mutations: {
    issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)),
  },
  endpoints: {
    envProbe: endpoint({ method: "GET", path: "/env-probe" }, requireAuth({ credentials: ["access-key"] }, (ctx) => ({
      body: { hasDummySecret: ctx.env.DUMMY_SERVER_SECRET === "synthetic-only" },
    }))),
  },
});`;

function openSocket(base, token, headers) {
  const url = new URL("/__sporades/ws", base);
  url.protocol = "ws:";
  url.searchParams.set("connectionToken", token);
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  const frames = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    frames.push(event.data);
    for (const waiter of [...waiters]) {
      if (waiter.id === message.id) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${message.id}`)), 10_000);
    waiters.push({ id: message.id, resolve: (value) => { clearTimeout(timer); resolve(value); } });
    socket.send(JSON.stringify(message));
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ socket, send, frames }), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

test("generated Bundle: WebSocket subscriptions never return server env for anonymous, linked-human or Access-key callers", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".agent-tmp-env-disclosure-"));
  let child;
  let output = "";
  const sockets = [];
  try {
    const config = { name: "env-disclosure-bundle", auth: { providers: { anonymous: true, email: true } } };
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource: bundleSource, serverSourcePath: path.join(root, "server/index.ts") });
    await writeFile(path.join(root, "server.mjs"), await createServerBundleModuleSource({
      config,
      serverEnv: { ...DUMMY_ENV },
      serverSource: bundleSource,
      serverModuleSource,
      epilogue: "\nprocess.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');",
    }));
    child = spawn(process.execPath, [path.join(root, "server.mjs")], {
      cwd: root,
      env: { ...process.env, PORT: "0", SPORADES_SECURITY_SESSION: "dev", SPORADES_CONFIG_DIR: path.join(root, "config") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let port;
    const deadline = Date.now() + 15_000;
    while (!port && Date.now() < deadline) {
      port = output.split("\n").map((line) => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      assert.equal(child.exitCode, null, output);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(port, output);
    const base = `http://127.0.0.1:${port}`;
    const connectionToken = async () => (await (await fetch(`${base}/__sporades/connection-token`, {
      headers: { "x-sporades-connection-token-request": "1" },
    })).json()).token;

    const browser = await openSocket(base, await connectionToken());
    sockets.push(browser.socket);
    const anonymous = await browser.send({ id: "anonymous-env", type: "query.subscribe", query: "ctx.env" });
    assertUnknownQueryWithoutEnv(anonymous, "anonymous WebSocket");
    const probe = await browser.send({ id: "anonymous-probe", type: "query.subscribe", query: "envProbe" });
    assert.deepEqual(probe.data, { hasDummySecret: true });

    const signup = await browser.send({
      id: "signup",
      type: "auth.signUp",
      provider: "email",
      credentials: { email: "linked@example.test", password: "correct horse battery staple", name: "Linked" },
    });
    assert.equal(signup.error, null, JSON.stringify(signup));
    assert.equal(signup.data.auth.isGuest, false);
    const linked = await browser.send({ id: "linked-env", type: "query.subscribe", query: "ctx.env", sessionToken: signup.data.sessionToken });
    assertUnknownQueryWithoutEnv(linked, "linked-human WebSocket");

    const issued = await browser.send({ id: "issue", type: "mutation.run", mutation: "issueKey", args: [{ name: "env-probe" }], sessionToken: signup.data.sessionToken });
    assert.equal(issued.error, null, JSON.stringify(issued));
    const bearer = { authorization: `Bearer ${issued.data.token}` };
    const keyed = await fetch(`${base}/env-probe`, { headers: bearer });
    assert.equal(keyed.status, 200);
    assert.deepEqual(await keyed.json(), { hasDummySecret: true });

    const automation = await openSocket(base, await connectionToken(), bearer);
    sockets.push(automation.socket);
    const keyedEnv = await automation.send({ id: "access-key-env", type: "query.subscribe", query: "ctx.env" });
    assertUnknownQueryWithoutEnv(keyedEnv, "Access-key WebSocket");

    for (const frame of [...browser.frames, ...automation.frames]) assert.doesNotMatch(frame, DISCLOSURE);
    assert.doesNotMatch(output, DISCLOSURE);
  } finally {
    for (const socket of sockets) socket.close();
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
