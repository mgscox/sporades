export type McpConfig = Readonly<{
    enabled: false;
} | {
    enabled: true;
    keyEnv: string;
}>;
export type EndpointMcpDeclaration = true | Readonly<{
    description?: string;
}>;
/** Shortest bearer key the runtime accepts; shorter configured values leave the bridge closed. */
export declare const MCP_MIN_KEY_LENGTH = 32;
export declare const MCP_OPERATOR_TOOL_PREFIX = "sporades_";
export declare function validateMcpConfig(mcp: unknown): McpConfig | undefined;
/** Validate every endpoint's `mcp` exposure flag. Endpoints without one are never bridged. */
export declare function validateEndpointMcpDeclarations(endpoints: unknown): void;
//# sourceMappingURL=mcp-config.d.ts.map