// The Capsule MCP bridge (ADR-0059). `/__sporades/mcp` speaks MCP's stateless Streamable HTTP
// transport and turns each `tools/call` into one loopback HTTP request against this runtime's own
// listener, returning that response's status and body unchanged. Operator tools target the
// key-guarded `/__sporades/ops/*` routes below; Capsule tools target endpoints declared `mcp`.
import { createHash, timingSafeEqual } from "node:crypto";
import { dumpDatabase, listDatabaseTables, runReadOnlyQuery } from "./database-runtime.js";
import { readJsonRequest, requestTarget } from "./http-runtime.js";
import { MCP_MIN_KEY_LENGTH, isUsableMcpKey } from "./mcp-config.js";
export const MCP_ROUTE = "/__sporades/mcp";
export const MCP_OPERATOR_ROUTE_PREFIX = "/__sporades/ops/";
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** The whole operator surface: each tool is exactly one runtime HTTP route. */
export const MCP_OPERATOR_ROUTES = Object.freeze([
    { tool: "sporades_logs", method: "GET", path: "/__sporades/ops/logs", description: "Recent indexed runtime log events." },
    { tool: "sporades_logs_tail", method: "GET", path: "/__sporades/ops/logs/tail", description: "Latest events from the durable JSONL log stream." },
    { tool: "sporades_db_list", method: "GET", path: "/__sporades/ops/db/list", description: "List inspectable database tables." },
    { tool: "sporades_db_dump", method: "GET", path: "/__sporades/ops/db/dump", description: "Dump every inspectable database table." },
    {
        tool: "sporades_db_query",
        method: "POST",
        path: "/__sporades/ops/db/query",
        description: "Run one read-only SQL query against the Capsule database.",
        input: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false },
    },
]);
/** Resolve the bridge key once at startup; only its digest is retained. */
export function resolveMcpRuntime(config, serverEnv) {
    if (!config?.enabled)
        return Object.freeze({ enabled: false, keyDigest: null, keyEnv: null });
    const key = Object.getOwnPropertyDescriptor(serverEnv, config.keyEnv)?.value;
    return Object.freeze({ enabled: true, keyDigest: isUsableMcpKey(key) ? digest(key) : null, keyEnv: config.keyEnv });
}
/** Route `/__sporades/mcp` and `/__sporades/ops/*`. Returns false for every other path. */
export async function routeMcp(database, request, response) {
    const pathname = requestTarget(request).pathname;
    const isBridge = pathname === MCP_ROUTE;
    if (!isBridge && !pathname.startsWith(MCP_OPERATOR_ROUTE_PREFIX))
        return false;
    const runtime = database.mcp;
    if (!runtime?.enabled || !runtime.keyDigest) {
        if (runtime?.enabled)
            reportUnavailableKeyOnce(database, runtime);
        writeText(response, 404, "Not found");
        return true;
    }
    const operatorRoute = isBridge ? null : MCP_OPERATOR_ROUTES.find((route) => route.method === request.method && route.path === pathname);
    if (!isBridge && !operatorRoute) {
        writeText(response, 404, "Not found");
        return true;
    }
    if (!bearerMatches(request.headers.authorization, runtime.keyDigest)) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "www-authenticate": 'Bearer realm="sporades-mcp"' });
        response.end(`${JSON.stringify({ ok: false, data: null, error: { message: "Unauthorized." } })}\n`);
        return true;
    }
    if (operatorRoute)
        await routeOperator(database, request, response, operatorRoute);
    else
        await routeBridge(database, request, response);
    return true;
}
async function routeOperator(database, request, response, route) {
    switch (route.tool) {
        case "sporades_logs":
            return writeJson(response, 200, { ok: true, data: { source: "sqlite", entries: await database.log.recent() }, error: null });
        case "sporades_logs_tail":
            return writeJson(response, 200, { ok: true, data: { source: "jsonl", entries: database.log.tail() }, error: null });
        case "sporades_db_list":
            return writeJson(response, 200, { ok: true, data: { tables: await listDatabaseTables(database) }, error: null });
        case "sporades_db_dump":
            return writeJson(response, 200, { ok: true, data: { tables: await dumpDatabase(database) }, error: null });
        case "sporades_db_query": {
            const body = await readJsonRequest(request, database);
            return writeJson(response, 200, await runReadOnlyQuery(database, body.sql));
        }
    }
}
async function routeBridge(database, request, response) {
    if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
    }
    let message;
    try {
        message = await readJsonRequest(request, database);
    }
    catch (error) {
        if (error?.code === "PAYLOAD_TOO_LARGE")
            throw error;
        return writeJson(response, 400, rpcError(null, -32700, "Parse error"));
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return writeJson(response, 400, rpcError(message?.id ?? null, -32600, "Invalid Request"));
    }
    // Notifications and client responses need no reply on the stateless transport.
    if (message.id === undefined || message.id === null) {
        response.writeHead(202);
        response.end();
        return;
    }
    const { id, method, params } = message;
    switch (method) {
        case "initialize": {
            const requested = params?.protocolVersion;
            const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
            return writeJson(response, 200, rpcResult(id, {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: `sporades:${database.capsuleIdentity ?? "capsule"}`, version: "1" },
            }));
        }
        case "ping":
            return writeJson(response, 200, rpcResult(id, {}));
        case "tools/list":
            return writeJson(response, 200, rpcResult(id, { tools: listTools(database) }));
        case "tools/call":
            return writeJson(response, 200, await callTool(database, request, response, id, params));
        default:
            return writeJson(response, 200, rpcError(id, -32601, "Method not found"));
    }
}
function exposedEndpoints(database) {
    return (database.endpoints ?? []).filter((endpoint) => endpoint?.options?.mcp !== undefined && typeof endpoint.name === "string");
}
function listTools(database) {
    const operatorTools = MCP_OPERATOR_ROUTES.map((route) => ({
        name: route.tool,
        description: route.description,
        inputSchema: route.input ?? { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
    }));
    const endpointTools = exposedEndpoints(database).map((endpoint) => {
        const readOnly = endpoint.method === "GET" || endpoint.method === "HEAD";
        return {
            name: endpoint.name,
            description: endpoint.options.mcp?.description ?? `${endpoint.method} ${endpoint.path}`,
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "object", additionalProperties: { type: "string" } },
                    ...(readOnly ? {} : { body: {} }),
                },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: readOnly },
        };
    });
    return [...operatorTools, ...endpointTools];
}
async function callTool(database, request, response, id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, -32602, "Invalid tool call parameters");
    }
    const operatorRoute = MCP_OPERATOR_ROUTES.find((route) => route.tool === name);
    const endpoint = operatorRoute ? null : exposedEndpoints(database).find((candidate) => candidate.name === name);
    if (!operatorRoute && !endpoint)
        return rpcError(id, -32602, `Unknown tool: ${name}`);
    const allowedArguments = operatorRoute
        ? Object.keys(operatorRoute.input?.properties ?? {})
        : endpoint.method === "GET" || endpoint.method === "HEAD" ? ["query"] : ["query", "body"];
    const unexpected = Object.keys(args).find((key) => !allowedArguments.includes(key));
    if (unexpected !== undefined)
        return rpcError(id, -32602, `Invalid arguments: unexpected ${JSON.stringify(unexpected)}`);
    let method;
    let path;
    let body;
    // Only operator routes receive the bridge key; Capsule endpoints never see it.
    const headers = { accept: "application/json" };
    if (operatorRoute) {
        if (operatorRoute.method === "POST" && typeof args.sql !== "string")
            return rpcError(id, -32602, "Invalid arguments: sql must be a string");
        method = operatorRoute.method;
        path = operatorRoute.path;
        body = operatorRoute.method === "POST" ? { sql: args.sql } : undefined;
        headers.authorization = String(request.headers.authorization);
    }
    else {
        const query = args.query ?? {};
        if (!query || typeof query !== "object" || Array.isArray(query) || Object.values(query).some((value) => typeof value !== "string")) {
            return rpcError(id, -32602, "Invalid arguments: query must map names to strings");
        }
        method = endpoint.method;
        const search = new URLSearchParams(query).toString();
        path = search ? `${endpoint.path}?${search}` : endpoint.path;
        body = method === "GET" || method === "HEAD" ? undefined : args.body;
    }
    if (body !== undefined)
        headers["content-type"] = "application/json";
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    let status;
    let text;
    try {
        const result = await fetch(new URL(path, loopbackOrigin(request)), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "manual",
            signal: abort.signal,
        });
        status = result.status;
        text = await result.text();
    }
    catch {
        return rpcResult(id, { content: [{ type: "text", text: "The bridged request failed." }], isError: true });
    }
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch { /* keep the raw text */ }
    const structured = { status, body: parsed };
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: status >= 400 });
}
/** The address this request was accepted on is always reachable from this process. */
function loopbackOrigin(request) {
    const socket = request.socket;
    let address = socket.localAddress ?? "127.0.0.1";
    if (address.startsWith("::ffff:"))
        address = address.slice("::ffff:".length);
    const host = address.includes(":") ? `[${address}]` : address;
    return `http://${host}:${socket.localPort}`;
}
function bearerMatches(header, expectedDigest) {
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string")
        return false;
    const match = value.match(/^Bearer (\S+)$/i);
    return match !== null && timingSafeEqual(digest(match[1]), expectedDigest);
}
function reportUnavailableKeyOnce(database, runtime) {
    if (database.__mcpKeyUnavailableReported)
        return;
    database.__mcpKeyUnavailableReported = true;
    database.log?.emit?.({
        category: "platform",
        event: "mcp.key.unavailable",
        level: "warn",
        message: `MCP is enabled but Server env ${runtime.keyEnv} is missing, shorter than ${MCP_MIN_KEY_LENGTH} characters, or not a single bearer token`,
        data: { keyEnv: runtime.keyEnv },
    });
}
function digest(value) {
    return createHash("sha256").update(value, "utf8").digest();
}
function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message } };
}
function writeJson(response, status, body) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(`${JSON.stringify(body)}\n`);
}
function writeText(response, status, body) {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
}
//# sourceMappingURL=mcp-runtime.js.map