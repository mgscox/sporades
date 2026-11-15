import Ajv2020 from "ajv/dist/2020.js";
import config from "../sporades.json";
import type { EndpointContext, SessionlessEndpointContext } from "sporades/server";
import { TodoInputError } from "./todos.js";
import { scopes, tools } from "./tools.js";

const version = "2026-07-28";
const ajv = new Ajv2020({ strict: true, allErrors: false });
const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const registry = new Map<string, typeof tools[number] & { validateInput: ReturnType<typeof ajv.compile>; validateOutput: ReturnType<typeof ajv.compile> }>();
for (const tool of tools) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || registry.has(tool.name)
    || tool.requiredScopes.length === 0 || new Set(tool.requiredScopes).size !== tool.requiredScopes.length
    || tool.requiredScopes.some(scope => !scopes.includes(scope as typeof scopes[number]))) throw new Error("Invalid MCP tool registration");
  registry.set(tool.name, { ...tool, validateInput: ajv.compile(tool.inputSchema), validateOutput: ajv.compile(tool.outputSchema) });
}
const catalogue = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
const serverMeta = { "io.modelcontextprotocol/serverInfo": { name: "sporades-todo-pilot", version: "1.0.0" } };

function headerName(value: string | undefined): string | undefined {
  if (!value?.startsWith("=?base64?")) return value;
  if (!/^=\?base64\?[A-Za-z0-9+/]*={0,2}\?=$/.test(value)) return undefined;
  const encoded = value.slice(9, -2);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}

export function originAllowed(ctx: Pick<EndpointContext, "app" | "request">) {
  const origin = ctx.request.headers.origin;
  const allowed: readonly string[] = config.security.cors.allowedOrigins;
  return origin === undefined || origin === ctx.app.publicOrigin || allowed.includes(origin);
}

export function methodNotAllowed(ctx: SessionlessEndpointContext) {
  return { status: originAllowed(ctx) ? 405 : 403, headers: { allow: "POST", "cache-control": "private, no-store" }, body: { error: "Unavailable transport" } };
}

export async function mcp(ctx: EndpointContext) {
  const request: any = ctx.request.body;
  const headers = ctx.request.headers;
  const reply = (status: number, body: any) => ({ status, headers: { "cache-control": "private, no-store", pragma: "no-cache" }, body });
  const validId = object(request) && (typeof request.id === "string" || Number.isSafeInteger(request.id));
  const error = (status: number, code: number, message: string, data?: any) => reply(status, {
    jsonrpc: "2.0", ...(validId ? { id: request.id } : {}), error: { code, message, ...(data ? { data } : {}) },
  });
  if (!originAllowed(ctx)) return error(403, -32600, "Origin refused");
  if (!object(request) || request.jsonrpc !== "2.0" || !validId || typeof request.method !== "string"
    || !object(request.params) || "result" in request || "error" in request) return error(400, -32600, "Invalid request");
  const params = request.params;
  const meta = params._meta;
  if (!object(meta) || typeof meta["io.modelcontextprotocol/protocolVersion"] !== "string"
    || !object(meta["io.modelcontextprotocol/clientInfo"])
    || typeof meta["io.modelcontextprotocol/clientInfo"].name !== "string"
    || typeof meta["io.modelcontextprotocol/clientInfo"].version !== "string"
    || !object(meta["io.modelcontextprotocol/clientCapabilities"])) return error(400, -32600, "Invalid request metadata");
  if (headers["mcp-protocol-version"] !== meta["io.modelcontextprotocol/protocolVersion"]
    || headers["mcp-method"] !== request.method
    || (request.method === "tools/call" && (typeof params.name !== "string" || headerName(headers["mcp-name"]) !== params.name))) return error(400, -32020, "Header mismatch");
  if (meta["io.modelcontextprotocol/protocolVersion"] !== version) return error(400, -32022, "Unsupported protocol version", { supported: [version], requested: meta["io.modelcontextprotocol/protocolVersion"] });
  if (!headers["content-type"]?.toLowerCase().startsWith("application/json")) return error(415, -32600, "JSON required");
  const accept = headers.accept?.split(",").map(value => value.trim().split(";")[0].toLowerCase()) ?? [];
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return error(406, -32600, "JSON and event-stream Accept required");
  const success = (result: any) => reply(200, { jsonrpc: "2.0", id: request.id, result: { resultType: "complete", _meta: serverMeta, ...result } });
  if (request.method === "server/discover") return success({ supportedVersions: [version], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private" });
  if (request.method === "tools/list") {
    if (Object.keys(params).some(key => key !== "_meta")) return error(400, -32602, "Invalid parameters");
    return success({ tools: catalogue.filter(tool => ctx.hasAccessKeyScopes(tool.requiredScopes)).map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })), ttlMs: 0, cacheScope: "private" });
  }
  if (request.method !== "tools/call") return error(404, -32601, "Method not found (supported protocol: 2026-07-28)");
  const tool = registry.get(params.name);
  if (!tool || !ctx.hasAccessKeyScopes(tool.requiredScopes)) return error(400, -32602, "Tool unavailable");
  const args = params.arguments === undefined ? {} : params.arguments;
  if (Object.keys(params).some(key => !["_meta", "name", "arguments"].includes(key)) || !tool.validateInput(args)) return error(400, -32602, "Invalid tool arguments");
  try {
    const result = await tool.handler(ctx, args);
    if (!tool.validateOutput(result)) throw new Error("Invalid tool output");
    ctx.log.info("MCP tool completed", { tool: tool.name, outcome: "completed" });
    return success({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (failure) {
    if (!(failure instanceof TodoInputError)) throw failure; // Unexpected failures must roll back the endpoint transaction.
    ctx.log.info("MCP tool refused", { tool: tool.name, outcome: "refused" });
    return success({ content: [{ type: "text", text: failure.code }], isError: true });
  }
}
