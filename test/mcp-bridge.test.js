import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, String as Text, table } from "../dist/server.js";
import { prepareHttpSecurity } from "../dist/http-runtime.js";
import { isUsableMcpKey, validateMcpConfig, validateMcpSealedServerEnv } from "../dist/mcp-config.js";
import { MCP_OPERATOR_ROUTES, routeMcp } from "../dist/mcp-runtime.js";
import { resolveTelemetryRoute } from "../dist/runtime-telemetry.js";
import { openDevDatabase, routeEndpoint } from "../dist/server-runtime-source.js";
import { readProjectConfig } from "../dist/cli/project-config.js";
import { writeFile } from "node:fs/promises";

const KEY = "k".repeat(40);

function definition() {
  return capsule({
    name: "mcp-bridge",
    schema: { notes: table({ body: Text() }) },
    endpoints: {
      echo: endpoint({ method: "POST", path: "/echo", mcp: { description: "Echo the body and query" } }, (ctx) => ({
        status: 201,
        body: { body: ctx.request.body, flag: ctx.request.query.flag ?? null, sawAuthorization: ctx.request.headers.authorization ?? null, isGuest: ctx.auth.isGuest },
      })),
      ping: endpoint({ method: "GET", path: "/ping", mcp: true }, () => ({ status: 200, body: { pong: true } })),
      hidden: endpoint({ method: "GET", path: "/hidden" }, () => ({ status: 200, body: { secret: true } })),
    },
  });
}

async function start(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-mcp-"));
  const serverEnv = "env" in options ? options.env : { MCP_API_KEY: KEY };
  const config = { name: "mcp-bridge", __sporadesSession: "container", ...("mcp" in options ? (options.mcp === undefined ? {} : { mcp: options.mcp }) : { mcp: { enabled: true, keyEnv: "MCP_API_KEY" } }) };
  const database = await openDevDatabase(path.join(directory, "data.db"), "", serverEnv, config, definition());
  await database.init?.();
  const server = createServer(async (request, response) => {
    if (prepareHttpSecurity(database, request, response)) return;
    if (await routeMcp(database, request, response)) return;
    if (await routeEndpoint(database, request, response)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    database,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function rpc(baseUrl, method, params, key = KEY) {
  const response = await fetch(`${baseUrl}/__sporades/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() };
}

test("mcp config is opt-in, closed, and names a non-reserved Server env key", () => {
  assert.equal(validateMcpConfig(undefined), undefined);
  assert.deepEqual(validateMcpConfig({ enabled: false }), { enabled: false });
  assert.deepEqual(validateMcpConfig({ enabled: true, keyEnv: "MCP_API_KEY" }), { enabled: true, keyEnv: "MCP_API_KEY" });
  for (const invalid of [null, [], { enabled: "yes" }, { enabled: true }, { enabled: true, keyEnv: "mcp_key" }, { enabled: true, keyEnv: "SPORADES_MCP" }, { enabled: true, keyEnv: "MCP_API_KEY", extra: 1 }]) {
    assert.throws(() => validateMcpConfig(invalid), { code: "INVALID_MCP_CONFIG" });
  }
});

test("an enabled bridge requires Sealed Server env and a sendable bearer key", () => {
  assert.throws(() => validateMcpSealedServerEnv({ enabled: true, keyEnv: "MCP_API_KEY" }, false), { code: "INVALID_MCP_CONFIG", message: /Sealed Server env/ });
  assert.deepEqual(validateMcpSealedServerEnv({ enabled: true, keyEnv: "MCP_API_KEY" }, true), { enabled: true, keyEnv: "MCP_API_KEY" });
  assert.deepEqual(validateMcpSealedServerEnv({ enabled: false }, false), { enabled: false });
  assert.equal(validateMcpSealedServerEnv(undefined, false), undefined);
  assert.equal(isUsableMcpKey(KEY), true);
  for (const key of [undefined, "short", `${"a".repeat(20)} ${"b".repeat(20)}`, `${"a".repeat(40)}\t`, `${"é".repeat(40)}`]) {
    assert.equal(isUsableMcpKey(key), false, JSON.stringify(key));
  }
});

test("sporades.json accepts and validates the mcp stanza", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sporades-mcp-config-"));
  try {
    await writeFile(path.join(directory, "sporades.json"), JSON.stringify({ name: "x", mcp: { enabled: true, keyEnv: "MCP_API_KEY" } }));
    assert.deepEqual((await readProjectConfig(directory)).mcp, { enabled: true, keyEnv: "MCP_API_KEY" });
    await writeFile(path.join(directory, "sporades.json"), JSON.stringify({ name: "x", mcp: { enabled: true, keyEnv: "SPORADES_X" } }));
    await assert.rejects(readProjectConfig(directory), { code: "INVALID_MCP_CONFIG" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("endpoint mcp declarations are closed and limited to bridgeable JSON endpoints", () => {
  const declare = (name, options) => capsule({ name: "x", endpoints: { [name]: endpoint({ method: "POST", path: "/x", ...options }, () => null) } });
  assert.doesNotThrow(() => declare("ok", { mcp: true }));
  assert.doesNotThrow(() => declare("ok", { mcp: { description: "fine" } }));
  for (const [name, options] of [
    ["bad", { mcp: false }],
    ["bad", { mcp: { description: "" } }],
    ["bad", { mcp: { title: "x" } }],
    ["sporades_logs", { mcp: true }],
    ["has.dot", { mcp: true }],
    ["file", { mcp: true, response: { fileAttachment: true } }],
  ]) {
    assert.throws(() => declare(name, options), { code: "INVALID_ENDPOINT_MCP_DECLARATION" }, JSON.stringify([name, options]));
  }
});

test("bridge routes answer 404 when MCP is disabled or its key is unusable", async () => {
  for (const options of [{ mcp: undefined }, { mcp: { enabled: false } }, { env: {} }, { env: { MCP_API_KEY: "short" } }, { env: { MCP_API_KEY: `${"a".repeat(20)} ${"b".repeat(20)}` } }]) {
    const runtime = await start(options);
    try {
      assert.equal((await rpc(runtime.baseUrl, "ping")).status, 404, JSON.stringify(options));
      assert.equal((await fetch(`${runtime.baseUrl}/__sporades/ops/logs`, { headers: { authorization: `Bearer ${KEY}` } })).status, 404);
    } finally {
      await runtime.close();
    }
  }
});

test("every bridge route requires the Sealed Server env key", async () => {
  const runtime = await start();
  try {
    for (const key of [null, "wrong".repeat(10)]) {
      const call = await rpc(runtime.baseUrl, "tools/list", undefined, key);
      assert.equal(call.status, 401);
      assert.doesNotMatch(call.body, /tools/);
      for (const route of MCP_OPERATOR_ROUTES) {
        const response = await fetch(`${runtime.baseUrl}${route.path}`, {
          method: route.method,
          headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : { "content-type": "application/json" },
          body: route.method === "POST" ? JSON.stringify({ sql: "select 1" }) : undefined,
        });
        assert.equal(response.status, 401, route.path);
        assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="sporades-mcp"');
      }
    }
    const direct = await fetch(`${runtime.baseUrl}/__sporades/ops/db/list`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).ok, true);
  } finally {
    await runtime.close();
  }
});

test("initialize, ping and tools/list follow the stateless MCP transport", async () => {
  const runtime = await start();
  try {
    const init = await rpc(runtime.baseUrl, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    const unknownVersion = await rpc(runtime.baseUrl, "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(unknownVersion.body.result.protocolVersion, "2025-11-25");

    const notification = await fetch(`${runtime.baseUrl}/__sporades/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notification.status, 202);
    assert.equal((await fetch(`${runtime.baseUrl}/__sporades/mcp`, { headers: { authorization: `Bearer ${KEY}` } })).status, 405);

    assert.deepEqual((await rpc(runtime.baseUrl, "ping")).body.result, {});
    assert.equal((await rpc(runtime.baseUrl, "resources/list")).body.error.code, -32601);

    const names = (await rpc(runtime.baseUrl, "tools/list")).body.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [...MCP_OPERATOR_ROUTES.map((route) => route.tool), "echo", "ping"]);
    assert.ok(!names.includes("hidden"), "undeclared endpoints are never listed");
  } finally {
    await runtime.close();
  }
});

test("operator tools translate to their key-guarded HTTP routes", async () => {
  const runtime = await start();
  try {
    const list = await rpc(runtime.baseUrl, "tools/call", { name: "sporades_db_list", arguments: {} });
    assert.equal(list.body.result.isError, false);
    assert.equal(list.body.result.structuredContent.status, 200);
    assert.ok(list.body.result.structuredContent.body.data.tables.some((entry) => JSON.stringify(entry).includes("notes")));
    assert.deepEqual(JSON.parse(list.body.result.content[0].text), list.body.result.structuredContent);

    const query = await rpc(runtime.baseUrl, "tools/call", { name: "sporades_db_query", arguments: { sql: "select 1 as one" } });
    assert.equal(query.body.result.structuredContent.status, 200);
    assert.match(JSON.stringify(query.body.result.structuredContent.body), /"one":1/);

    const write = await rpc(runtime.baseUrl, "tools/call", { name: "sporades_db_query", arguments: { sql: "delete from notes" } });
    assert.notEqual(write.body.result.structuredContent.body.ok, true, "the query route stays read-only");

    const missingSql = await rpc(runtime.baseUrl, "tools/call", { name: "sporades_db_query", arguments: {} });
    assert.equal(missingSql.body.error.code, -32602);
  } finally {
    await runtime.close();
  }
});

test("endpoint tools forward query and body without the bridge key", async () => {
  const runtime = await start();
  try {
    const echo = await rpc(runtime.baseUrl, "tools/call", { name: "echo", arguments: { query: { flag: "on" }, body: { hello: "world" } } });
    assert.deepEqual(echo.body.result.structuredContent, {
      status: 201,
      body: { body: { hello: "world" }, flag: "on", sawAuthorization: null, isGuest: true },
    });
    assert.equal(echo.body.result.isError, false);

    const ping = await rpc(runtime.baseUrl, "tools/call", { name: "ping" });
    assert.deepEqual(ping.body.result.structuredContent, { status: 200, body: { pong: true } });

    for (const name of ["hidden", "nope"]) {
      assert.equal((await rpc(runtime.baseUrl, "tools/call", { name, arguments: {} })).body.error.code, -32602);
    }
    assert.equal((await rpc(runtime.baseUrl, "tools/call", { name: "echo", arguments: { query: { n: 1 } } })).body.error.code, -32602);
    for (const [name, args] of [["echo", { boddy: {} }], ["ping", { body: {} }], ["sporades_db_list", { sql: "select 1" }], ["sporades_db_query", { sql: "select 1", extra: true }]]) {
      const rejected = await rpc(runtime.baseUrl, "tools/call", { name, arguments: args });
      assert.equal(rejected.body.error?.code, -32602, `${name} ${JSON.stringify(args)}`);
    }
  } finally {
    await runtime.close();
  }
});

test("bridge routes have bounded telemetry labels", () => {
  for (const [method, url] of [["POST", "/__sporades/mcp"], ["GET", "/__sporades/ops/logs"], ["POST", "/__sporades/ops/db/query"]]) {
    assert.equal(resolveTelemetryRoute({ method, url }, []), url);
  }
});

test("the generated server Bundle serves the bridge for operator and endpoint tools", { timeout: 30000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { bundleServerCapsuleModule } = await import("../dist/bundle-pipeline.js");
  const { createServerBundleModuleSource } = await import("../dist/templates/server-bundle-module-graph.js");
  const root = await mkdtemp(path.join(process.cwd(), ".agent-tmp-mcp-bundle-"));
  let child;
  try {
    const serverSource = `import { capsule, endpoint } from 'sporades/server';
export default capsule({ name: 'mcp-bundle', endpoints: {
  hello: endpoint({ method: 'POST', path: '/hello', mcp: { description: 'Greet' } }, ctx => ({ status: 200, body: { hello: ctx.request.body?.name ?? null, sawAuthorization: ctx.request.headers.authorization ?? null } })),
} });`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, "server/index.ts") });
    const source = await createServerBundleModuleSource({
      config: { name: "mcp-bundle", mcp: { enabled: true, keyEnv: "MCP_API_KEY" } },
      serverEnv: { MCP_API_KEY: KEY },
      serverSource,
      serverModuleSource,
      epilogue: "process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');",
    });
    await writeFile(path.join(root, "server.mjs"), source);
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [path.join(root, "server.mjs")], { cwd: root, env: { ...process.env, PORT: "0", SPORADES_SECURITY_SESSION: "container", SPORADES_CONFIG_DIR: path.join(root, "config") } });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let port;
    const deadline = Date.now() + 10000;
    while (!port && Date.now() < deadline) {
      port = stdout.split("\n").map((line) => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      assert.equal(child.exitCode, null, stdout + stderr);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(port, stdout + stderr);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await rpc(base, "tools/list", undefined, null)).status, 401);
    const names = (await rpc(base, "tools/list")).body.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("hello") && names.includes("sporades_logs"));
    const hello = await rpc(base, "tools/call", { name: "hello", arguments: { body: { name: "agent" } } });
    assert.deepEqual(hello.body.result.structuredContent, { status: 200, body: { hello: "agent", sawAuthorization: null } });
    const logs = await rpc(base, "tools/call", { name: "sporades_logs", arguments: {} });
    assert.equal(logs.body.result.structuredContent.status, 200);
    assert.equal(logs.body.result.structuredContent.body.ok, true);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});
