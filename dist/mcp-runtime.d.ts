import type { IncomingMessage, ServerResponse } from "node:http";
import { type McpConfig } from "./mcp-config.js";
type LooseRecord = Record<string, any>;
export declare const MCP_ROUTE = "/__sporades/mcp";
export declare const MCP_OPERATOR_ROUTE_PREFIX = "/__sporades/ops/";
export declare const MCP_PROTOCOL_VERSIONS: readonly ["2025-11-25", "2025-06-18", "2025-03-26"];
type OperatorRoute = {
    tool: string;
    method: "GET" | "POST";
    path: string;
    description: string;
    input?: LooseRecord;
};
/** The whole operator surface: each tool is exactly one runtime HTTP route. */
export declare const MCP_OPERATOR_ROUTES: readonly OperatorRoute[];
export type McpRuntime = Readonly<{
    enabled: boolean;
    keyDigest: Buffer | null;
    keyEnv: string | null;
}>;
/** Resolve the bridge key once at startup; only its digest is retained. */
export declare function resolveMcpRuntime(config: McpConfig | undefined, serverEnv: Record<string, unknown>): McpRuntime;
/** Route `/__sporades/mcp` and `/__sporades/ops/*`. Returns false for every other path. */
export declare function routeMcp(database: LooseRecord, request: IncomingMessage, response: ServerResponse): Promise<boolean>;
export {};
//# sourceMappingURL=mcp-runtime.d.ts.map