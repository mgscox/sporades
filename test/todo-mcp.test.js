import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { capsule, endpoint, mutation, requireAuth } from "../dist/server.js";
import { openDevDatabase, routeEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { prepareHttpSecurity } from "../dist/http-runtime.js";
import { routeMcp } from "../dist/mcp-runtime.js";

const root = path.resolve(import.meta.dirname, "..");
const operatorKey = "operator-test-key-".repeat(3);
const protocol = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": protocol,
  "io.modelcontextprotocol/clientInfo": { name: "pilot-tests", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function start(t, { bridge = false, directory, toolSource = x => x } = {}) {
  const ownDirectory = !directory;
  directory ??= await mkdtemp(path.join(tmpdir(), "sporades-todo-mcp-"));
  const outfile = path.join(directory, `pilot-${randomUUID()}.mjs`);
  await build({ entryPoints: [path.join(root, "examples/todo-mcp/server/index.ts")], outfile, platform: "node", format: "esm", bundle: true,
    plugins: [{ name: "installed-runtime", setup(build) { build.onResolve({ filter: /^sporades\/server$/ }, () => ({ path: path.join(root, "dist/server.js"), external: true })); build.onLoad({ filter: /todo-mcp\/server\/tools\.ts$/ }, async args => ({ contents: toolSource(await readFile(args.path, "utf8")), loader: "ts", resolveDir: path.dirname(args.path) })); } }],
  });
  const pilot = (await import(pathToFileURL(outfile).href)).default;
  const definition = capsule({ ...pilot,
    accessKeys: { scopes: [...pilot.accessKeys.scopes, "unrelated:read"] },
    mutations: { ...pilot.mutations,
      issueKey: mutation(requireAuth({ credentials: ["session"], linked: true }, (ctx, input) => ctx.accessKeys.issue(input))),
      rotateKey: mutation((ctx, id, revision) => ctx.accessKeys.rotate(id, { lifecycleRevision: revision })),
      revokeKey: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
    },
    endpoints: { ...pilot.endpoints, legacy: endpoint({ method: "GET", path: "/legacy", mcp: true }, ctx => ({ body: { guest: ctx.auth.isGuest, credential: ctx.credential } })) },
  });
  const config = { name: pilot.name, auth: { providers: { email: { enabled: true } } }, ...(bridge ? { mcp: { enabled: true, keyEnv: "OPERATOR_KEY" } } : {}) };
  const database = await openDevDatabase(path.join(directory, "data.db"), "", bridge ? { OPERATOR_KEY: operatorKey } : {}, config, definition);
  await database.init?.();
  const server = createServer(async (req, res) => {
    if (prepareHttpSecurity(database, req, res)) return;
    if (await routeMcp(database, req, res)) return;
    if (await routeEndpoint(database, req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const human = async (id) => {
    const auth = { userId: id, displayName: id, email: `${id}@example.test`, picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
    const token = `session-${id}`;
    if (!await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_auth_users] WHERE [id] = ?")).get(id)) {
      await database.adapter.insertAuthUser({ id, createdAt: new Date().toISOString(), ...auth, isAuthenticated: 1, isGuest: 0 });
      await database.adapter.insertAuthSession({ token, userId: id, provider: "email", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    return { auth, token, mutate: (name, ...args) => runMutation(database, auth, name, args, { sessionToken: token }), query: name => runQuery(database, auth, name, [], { sessionToken: token }) };
  };
  const rpc = async (key, method, params = {}, overrides = {}) => {
    const message = { jsonrpc: "2.0", id: 1, method, params: { _meta: meta, ...params } };
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocol, "mcp-method": method, ...(params.name ? { "mcp-name": params.name } : {}), ...overrides.headers,
    }, body: overrides.rawBody ?? JSON.stringify(overrides.message ?? message) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await database.close(); if (ownDirectory) await rm(directory, { recursive: true, force: true }); };
  t.after(close);
  return { origin, database, human, rpc, close, directory };
}

async function issue(actor, name, grants, expiresAt) {
  const issued = await actor.mutate("issueKey", { name, grants, ...(expiresAt ? { expiresAt } : {}) });
  assert.equal(issued.error, null, JSON.stringify(issued));
  return issued.data;
}
const toolNames = response => response.body.result.tools.map(tool => tool.name);
const add = (fixture, key, text, requestId = randomUUID()) => fixture.rpc(key, "tools/call", { name: "add_todo", arguments: { text, requestId } });

test("Todo pilot works with the real 2026 MCP client and filters discovery and calls", async t => {
  const f = await start(t);
  const owner = await f.human("reader");
  const read = await issue(owner, "reader", ["todos:read"]);
  const write = await issue(owner, "writer", ["todos:add"]);
  const both = await issue(owner, "both", ["todos:*"]);
  const neither = await issue(owner, "neither", ["unrelated:read"]);
  assert.deepEqual(toolNames(await f.rpc(read.token, "tools/list")), ["list_my_todos"]);
  assert.deepEqual(toolNames(await f.rpc(write.token, "tools/list")), ["add_todo"]);
  assert.deepEqual(toolNames(await f.rpc(neither.token, "tools/list")), []);
  const denied = await add(f, read.token, "denied");
  const unknown = await f.rpc(read.token, "tools/call", { name: "unknown", arguments: {} });
  assert.deepEqual(denied.body, unknown.body);
  assert.equal((await owner.query("todos")).data.length, 0);
  const client = new Client({ name: "sporades-acceptance", version: "1" }, { versionNegotiation: { mode: { pin: protocol } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${both.token}` } } }));
  t.after(() => client.close());
  assert.equal(client.getProtocolEra(), "modern");
  const catalogue = await client.listTools();
  assert.deepEqual(catalogue.tools.map(tool => tool.name), ["add_todo", "list_my_todos"]);
  const requestId = randomUUID();
  const created = await client.callTool({ name: "add_todo", arguments: { text: "  Via real client 🏝️  ", requestId } });
  assert.equal(created.isError, false);
  assert.equal(created.structuredContent.text, "Via real client 🏝️");
  const listed = await client.callTool({ name: "list_my_todos" });
  assert.deepEqual(listed.structuredContent, { todos: [created.structuredContent], hasMore: false });
  assert.equal((await owner.query("todos")).data[0].id, created.structuredContent.id);
  assert.equal((await f.rpc(both.token, "tools/list")).headers.get("cache-control"), "private, no-store");
  const logs = JSON.stringify(await f.database.log.tail(100));
  for (const secret of [both.token, read.token, "Via real client"]) assert.equal(logs.includes(secret), false);
  assert.match(logs, /MCP tool completed/);
});

test("Todo add receipts survive concurrent calls, lost responses and restart; owners stay isolated", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-todo-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let f = await start(t, { directory });
  const alice = await f.human("alice");
  const bob = await f.human("bob");
  const key = await issue(alice, "alice", ["todos:*"]);
  const bobKey = await issue(bob, "bob", ["todos:*"]);
  const requestId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => add(f, key.token, "  one todo  ", requestId)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, false);
    assert.deepEqual(response.body.result.structuredContent, responses[0].body.result.structuredContent);
  }
  assert.equal((await alice.query("todos")).data.length, 1);
  assert.deepEqual((await bob.query("todos")).data, []);
  const conflict = await add(f, key.token, "different", requestId);
  assert.equal(conflict.body.result.isError, true);
  assert.equal(conflict.body.result.content[0].text, "REQUEST_ID_CONFLICT");
  assert.equal((await alice.query("todos")).data.length, 1);
  const otherOwner = await add(f, bobKey.token, "Bob's independent receipt", requestId);
  assert.equal(otherOwner.body.result.isError, false);
  assert.notEqual(otherOwner.body.result.structuredContent.id, responses[0].body.result.structuredContent.id);
  await f.close(); // Treat the first response as lost, then restart against the same durable database.
  f = await start(t, { directory });
  assert.deepEqual((await add(f, key.token, "one todo", requestId)).body.result.structuredContent, responses[0].body.result.structuredContent);
  const aliceAgain = await f.human("alice");
  assert.equal((await aliceAgain.query("todos")).data.length, 1);
  const receipts = await f.database.adapter.prepare("SELECT COUNT(*) AS total FROM [todoAddReceipts]").get();
  assert.equal(Number(receipts.total), 2);
});

test("MCP validation rejects batches, notifications, owner injection, bad metadata and invalid text before writes", async t => {
  const f = await start(t);
  const owner = await f.human("validation");
  const key = await issue(owner, "writer", ["todos:*"]);
  const params = { name: "add_todo", arguments: { text: "must not write", requestId: randomUUID() } };
  const valid = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, ...params } };
  for (const [overrides, code] of [
    [{ message: [valid] }, -32600],
    [{ message: { ...valid, id: undefined } }, -32600],
    [{ message: { ...valid, id: null } }, -32600],
    [{ message: { ...valid, params: { ...params, _meta: {} } } }, -32600],
    [{ headers: { "mcp-name": "list_my_todos" } }, -32020],
    [{ headers: { "mcp-method": "tools/list" } }, -32020],
    [{ headers: { "mcp-protocol-version": "2025-11-25" } }, -32020],
    [{ message: { ...valid, params: { ...valid.params, arguments: { ...params.arguments, ownerId: "somebody-else" } } } }, -32602],
    [{ message: { ...valid, params: { ...valid.params, arguments: { text: "todo", requestId: "invalid" } } } }, -32602],
  ]) {
    const response = await f.rpc(key.token, "tools/call", params, overrides).catch(error => { error.message += ` (validation code ${code})`; throw error; });
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.equal(response.body.error.code, code);
  }
  const unsupported = { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" };
  const version = await f.rpc(key.token, "tools/list", { _meta: unsupported }, { headers: { "mcp-protocol-version": "2099-01-01" } });
  assert.equal(version.body.error.code, -32022);
  assert.deepEqual(version.body.error.data.supported, [protocol]);
  const encodedName = `=?base64?${Buffer.from("add_todo").toString("base64")}?=`;
  const accepted = await f.rpc(key.token, "tools/call", params, { headers: { "mcp-name": encodedName } });
  assert.equal(accepted.body.result.isError, false);
  const afterValid = (await owner.query("todos")).data.length;
  for (const text of ["   ", "😀".repeat(501)]) assert.equal((await add(f, key.token, text)).body.result.isError, true);
  assert.equal((await owner.query("todos")).data.length, afterValid);
  assert.equal((await add(f, key.token, "😀".repeat(500))).body.result.isError, false);
  const malformed = await f.rpc(key.token, "tools/call", params, { rawBody: "{" });
  assert.equal(malformed.status, 400);
  assert.equal("jsonrpc" in malformed.body, false, "runtime JSON rejects preserve their ordinary HTTP envelope");
  const oversized = await f.rpc(key.token, "tools/call", { name: "add_todo", arguments: { text: "a".repeat(2 * 1024 * 1024), requestId: randomUUID() } }, { headers: { connection: "close" } }).catch(error => {
    assert.equal(error.cause?.code, "ECONNRESET");
    return null; // Runtime may close the unread oversized body before fetch receives its 413.
  });
  if (oversized) assert.equal(oversized.status, 413);
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(`${f.origin}/mcp`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal((await fetch(`${f.origin}/mcp`, { method, headers: { origin: "https://hostile.invalid" } })).status, 403);
  }
  assert.equal((await f.rpc(key.token, "tools/list", {}, { headers: { origin: f.database.app.publicOrigin } })).status, 200);
  const hostile = await f.rpc(key.token, "tools/call", params, { headers: { origin: "https://hostile.invalid" } });
  assert.equal(hostile.status, 403);
  const sessionOnly = await fetch(`${f.origin}/mcp`, { method: "POST", headers: { "x-sporades-session-token": owner.token } });
  assert.equal(sessionOnly.status, 403);
  const dual = await f.rpc(key.token, "tools/list", {}, { headers: { "x-sporades-session-token": owner.token } });
  assert.equal(dual.status, 401);
});

test("keys rotate, expire and revoke at the next admission; Service Users have independent lists and can be disabled", async t => {
  const f = await start(t);
  const owner = await f.human("lifecycle");
  const key = await issue(owner, "writer", ["todos:*"]);
  const rotated = await owner.mutate("rotateKey", key.accessKey.id, key.accessKey.lifecycleRevision);
  assert.equal(rotated.error, null);
  assert.equal((await f.rpc(key.token, "tools/list")).status, 401);
  assert.equal((await f.rpc(rotated.data.token, "tools/list")).status, 200);
  assert.equal((await owner.mutate("revokeKey", key.accessKey.id)).error, null);
  assert.equal((await f.rpc(rotated.data.token, "tools/list")).status, 401);
  const expiring = await issue(owner, "expiring", ["todos:read"], new Date(Date.now() + 60_000).toISOString());
  await f.database.adapter.prepare("UPDATE [sporades_auth_access_keys] SET [expiresAt] = ? WHERE [id] = ?").run("2000-01-01T00:00:00.000Z", expiring.accessKey.id);
  assert.equal((await f.rpc(expiring.token, "tools/list")).status, 401);
  const created = await owner.mutate("createAgent", { displayName: "Capture agent", accessKey: { name: "capture", grants: ["todos:*"] } });
  assert.equal(created.error, null, JSON.stringify(created));
  assert.deepEqual((await f.rpc(created.data.token, "tools/call", { name: "list_my_todos", arguments: {} })).body.result.structuredContent.todos, []);
  assert.equal((await add(f, created.data.token, "Agent's todo")).body.result.isError, false);
  assert.deepEqual((await owner.query("todos")).data, []);
  const other = await f.human("other-manager");
  assert.ok((await other.mutate("disableAgent", created.data.serviceUser.id)).error);
  assert.equal((await f.rpc(created.data.token, "tools/list")).status, 200);
  assert.equal((await owner.mutate("disableAgent", created.data.serviceUser.id)).error, null);
  assert.equal((await f.rpc(created.data.token, "tools/list")).status, 401);
});

test("operator and app routes reject each other's keys and retain legacy bridge behavior", async t => {
  const f = await start(t, { bridge: true });
  const owner = await f.human("bridge");
  const key = await issue(owner, "reader", ["todos:read"]);
  assert.equal((await f.rpc(operatorKey, "tools/list")).status, 401);
  const operator = async (token, method, params) => {
    const response = await fetch(`${f.origin}/__sporades/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await operator(key.token, "tools/list")).status, 401);
  const listed = await operator(operatorKey, "tools/list");
  assert.equal(listed.status, 200);
  const names = listed.body.result.tools.map(tool => tool.name);
  assert.ok(names.includes("legacy"));
  assert.equal(names.includes("appMcp"), false);
  assert.equal(names.includes("add_todo"), false);
  const legacy = await operator(operatorKey, "tools/call", { name: "legacy", arguments: {} });
  assert.equal(legacy.body.result.isError, false);
  assert.equal(JSON.stringify(legacy).includes('"kind":"access-key"'), false);
  assert.equal((await f.rpc(key.token, "tools/list")).status, 200);
});

test("an unexpected failure after reserving an add receipt rolls back the receipt and todo", async t => {
  const f = await start(t);
  const owner = await f.human("rollback");
  const key = await issue(owner, "writer", ["todos:*"]);
  await f.database.adapter.exec("CREATE TRIGGER fail_receipt_update BEFORE UPDATE ON [todoAddReceipts] BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const requestId = randomUUID();
  assert.equal((await add(f, key.token, "Retry after rollback", requestId)).status, 500);
  assert.deepEqual((await owner.query("todos")).data, []);
  const receipts = await f.database.adapter.prepare("SELECT COUNT(*) AS total FROM [todoAddReceipts]").get();
  assert.equal(Number(receipts.total), 0);
  await f.database.adapter.exec("DROP TRIGGER fail_receipt_update");
  assert.equal((await add(f, key.token, "Retry after rollback", requestId)).body.result.isError, false);
  assert.equal((await owner.query("todos")).data.length, 1);
});

test("a committed MCP add refreshes the owner's live browser query", async t => {
  const f = await start(t);
  const owner = await f.human("live-browser");
  const key = await issue(owner, "capture", ["todos:add"]);
  const { createWebSocketHub } = await import("../dist/server-runtime-source.js");
  const hub = createWebSocketHub(() => f.database);
  const server = createServer();
  server.on("upgrade", (request, socket) => { void hub.accept(request, socket); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}&sessionToken=${owner.token}`);
  t.after(async () => { hub.disconnectAll(); await new Promise(resolve => server.close(resolve)); });
  const messages = [];
  const pending = new Map();
  socket.addEventListener("message", event => {
    const value = JSON.parse(event.data); messages.push(value); pending.get(value.id)?.(value); pending.delete(value.id);
  });
  const send = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket timeout: ${message.id}`)), 3000);
    pending.set(message.id, value => { clearTimeout(timer); resolve(value); }); socket.send(JSON.stringify(message));
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  assert.equal((await send({ id: "todos", type: "query.subscribe", query: "todos", sessionToken: owner.token })).error, null);
  assert.equal((await add(f, key.token, "Visible in the browser")).body.result.isError, false);
  const until = Date.now() + 2000;
  while (!messages.some(message => message.type === "query.result" && message.data?.some(todo => todo.text === "Visible in the browser")) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(messages.some(message => message.type === "query.result" && message.data?.some(todo => todo.text === "Visible in the browser")), "MCP write should refresh the open Todo query");
});

test("list bounds are deterministic and browser adds use the same Unicode normalization", async t => {
  const f = await start(t);
  const owner = await f.human("bounds");
  const key = await issue(owner, "reader", ["todos:read"]);
  for (let i = 0; i < 51; i++) assert.equal((await owner.mutate("addTodo", `  Todo ${i}  `)).error, null);
  assert.ok((await owner.mutate("addTodo", "😀".repeat(501))).error);
  const listed = await f.rpc(key.token, "tools/call", { name: "list_my_todos", arguments: {} });
  const browser = (await owner.query("todos")).data;
  assert.equal(listed.body.result.structuredContent.todos.length, 50);
  assert.equal(listed.body.result.structuredContent.hasMore, true);
  assert.deepEqual(listed.body.result.structuredContent.todos.map(todo => todo.id), browser.slice(0, 50).map(todo => todo.id));
  assert.ok(browser.every(todo => todo.text === todo.text.trim()));
});

test("Capsule-only redeploy adds a tool and changes an existing schema on the same runtime and lockfile", async t => {
  const runtimeBefore = await readFile(path.join(root, "dist/server-runtime-source.js"));
  const lockBefore = await readFile(path.join(root, "package-lock.json"));
  const pilotLockBefore = await readFile(path.join(root, "examples/todo-mcp/package-lock.json"));
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-capsule-redeploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await start(t, { directory });
  const owner = await f.human("redeploy");
  const key = await issue(owner, "read", ["todos:read"]);
  assert.deepEqual(toolNames(await f.rpc(key.token, "tools/list")), ["list_my_todos"]);
  await f.close();
  const updated = await start(t, { directory, toolSource: source => source
    .replace('export const tools = [', `export const tools = [
      { name: "count_my_todos", description: "Count the latest todos", requiredScopes: ["todos:read"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", required: ["count"], additionalProperties: false, properties: { count: { type: "integer" } } },
        handler: async (ctx: EndpointContext) => ({ count: (await listMyTodos(ctx)).todos.length }) },`)
    .replace('inputSchema: { type: "object", properties: {}, additionalProperties: false },\n    outputSchema:', 'inputSchema: { type: "object", properties: { reason: { type: "string", const: "summary" } }, required: ["reason"], additionalProperties: false },\n    outputSchema:') });
  const client = new Client({ name: "redeploy-client", version: "1" }, { versionNegotiation: { mode: { pin: protocol } } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${updated.origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key.token}` } } }));
  const catalogue = await client.listTools();
  assert.deepEqual(catalogue.tools.map(tool => tool.name), ["count_my_todos", "list_my_todos"]);
  assert.deepEqual(catalogue.tools.find(tool => tool.name === "list_my_todos").inputSchema.required, ["reason"]);
  assert.deepEqual((await client.callTool({ name: "count_my_todos" })).structuredContent, { count: 0 });
  assert.deepEqual((await client.callTool({ name: "list_my_todos", arguments: { reason: "summary" } })).structuredContent, { todos: [], hasMore: false });
  assert.equal((await updated.rpc(key.token, "tools/call", { name: "list_my_todos", arguments: {} })).body.error.code, -32602);
  assert.deepEqual(await readFile(path.join(root, "dist/server-runtime-source.js")), runtimeBefore);
  assert.deepEqual(await readFile(path.join(root, "package-lock.json")), lockBefore);
  assert.deepEqual(await readFile(path.join(root, "examples/todo-mcp/package-lock.json")), pilotLockBefore);
});

test("latest 50 selection uses creation time before ID and resolves a boundary timestamp tie", async t => {
  const f = await start(t);
  const owner = await f.human("known-order");
  const key = await issue(owner, "reader", ["todos:read"]);
  // Older rows deliberately have larger IDs; the newest timestamp has more than 50 tied rows.
  const insert = f.database.adapter.prepare("INSERT INTO [todos] ([id], [createdAt], [updatedAt], [text], [done], [ownerId]) VALUES (?, ?, ?, ?, 0, ?)");
  for (let i = 0; i < 60; i++) {
    const time = i < 55 ? "2026-11-02T00:00:00.000Z" : "2026-11-01T00:00:00.000Z";
    await insert.run(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, time, time, `known-${i}`, owner.auth.userId);
  }
  const response = await f.rpc(key.token, "tools/call", { name: "list_my_todos" });
  assert.equal(response.body.result.structuredContent.hasMore, true);
  assert.deepEqual(response.body.result.structuredContent.todos.map(todo => todo.text), Array.from({ length: 50 }, (_, i) => `known-${54 - i}`));
});

test("the Capsule refuses duplicate names, undeclared tool scopes and invalid schemas at startup", async t => {
  for (const transform of [
    source => source.replace('name: "add_todo"', 'name: "list_my_todos"'),
    source => source.replace('requiredScopes: ["todos:read"]', 'requiredScopes: ["not:declared"]'),
    source => source.replace('inputSchema: { type: "object", properties: {}', 'inputSchema: { type: "invalid-schema-type", properties: {}'),
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), "sporades-invalid-tools-"));
    try { await assert.rejects(start(t, { directory, toolSource: transform }), /Invalid MCP tool registration|schema is invalid/); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("the real client surfaces runtime JSON/body-limit failures and can safely retry the add", async t => {
  const f = await start(t);
  const owner = await f.human("client-errors");
  const key = await issue(owner, "capture", ["todos:*"]);
  let malformed = false;
  const client = new Client({ name: "runtime-error-client", version: "1" }, { versionNegotiation: { mode: { pin: protocol } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key.token}`, connection: "close" } },
    fetch: (url, init) => fetch(url, malformed ? { ...init, body: "{" } : init),
  }));
  t.after(() => client.close());
  malformed = true;
  await assert.rejects(client.callTool({ name: "list_my_todos" }), error => error.status === 400);
  malformed = false;
  const requestId = randomUUID();
  await assert.rejects(client.callTool({ name: "add_todo", arguments: { text: "a".repeat(2 * 1024 * 1024), requestId } }));
  assert.deepEqual((await owner.query("todos")).data, []);
  const created = await client.callTool({ name: "add_todo", arguments: { text: "Recovered after transport failure", requestId } });
  const retry = await client.callTool({ name: "add_todo", arguments: { text: "Recovered after transport failure", requestId } });
  assert.deepEqual(retry.structuredContent, created.structuredContent);
  assert.equal((await owner.query("todos")).data.length, 1);
});
