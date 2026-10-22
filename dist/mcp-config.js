// Declaration-time validation for the Capsule MCP bridge (ADR-0059). It has no runtime imports so
// both the `sporades.json` reader and the public `capsule()` helper can share it.
/** Shortest bearer key the runtime accepts; shorter configured values leave the bridge closed. */
export const MCP_MIN_KEY_LENGTH = 32;
export const MCP_OPERATOR_TOOL_PREFIX = "sporades_";
export function validateMcpConfig(mcp) {
    if (mcp === undefined)
        return undefined;
    if (!isPlainRecord(mcp) || typeof mcp.enabled !== "boolean") {
        fail("INVALID_MCP_CONFIG", "Invalid MCP configuration.", "Set `mcp` to { \"enabled\": true, \"keyEnv\": \"MCP_API_KEY\" } or { \"enabled\": false }.");
    }
    if (mcp.enabled === false) {
        if (Object.keys(mcp).some((key) => key !== "enabled" && key !== "keyEnv")) {
            fail("INVALID_MCP_CONFIG", "Unsupported MCP configuration.", "Configure only `mcp.enabled` and `mcp.keyEnv`.");
        }
        return Object.freeze({ enabled: false });
    }
    if (Object.keys(mcp).some((key) => key !== "enabled" && key !== "keyEnv")) {
        fail("INVALID_MCP_CONFIG", "Unsupported MCP configuration.", "Configure only `mcp.enabled` and `mcp.keyEnv`.");
    }
    const keyEnv = mcp.keyEnv;
    if (typeof keyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(keyEnv) || keyEnv.startsWith("SPORADES_")) {
        fail("INVALID_MCP_CONFIG", "Invalid MCP key Server env reference.", "Set `mcp.keyEnv` to an uppercase Sealed Server env name outside the reserved SPORADES_ prefix, such as MCP_API_KEY.");
    }
    return Object.freeze({ enabled: true, keyEnv });
}
/** The operator key must come from Sealed Server env, never a plaintext file serialized into a Bundle. */
export function validateMcpSealedServerEnv(mcp, hasSealedEnvelope) {
    const normalized = validateMcpConfig(mcp);
    if (normalized?.enabled && !hasSealedEnvelope) {
        fail("INVALID_MCP_CONFIG", "An enabled MCP bridge requires Sealed Server env.", "Run `sporades env init`, then set the key with `sporades env set <keyEnv> --stdin` before building or starting the Capsule.");
    }
    return normalized;
}
/** A usable key is long enough and sendable as one RFC 6750 bearer token (visible ASCII, no spaces). */
export function isUsableMcpKey(value) {
    return typeof value === "string" && value.length >= MCP_MIN_KEY_LENGTH && /^[\x21-\x7E]+$/.test(value);
}
/** Validate every endpoint's `mcp` exposure flag. Endpoints without one are never bridged. */
export function validateEndpointMcpDeclarations(endpoints) {
    if (!isPlainRecord(endpoints))
        return;
    for (const [name, definition] of Object.entries(endpoints)) {
        const options = definition?.options;
        const mcp = options?.mcp;
        if (mcp === undefined)
            continue;
        const invalidShape = mcp !== true && !(isPlainRecord(mcp)
            && Object.keys(mcp).every((key) => key === "description")
            && (mcp.description === undefined || (typeof mcp.description === "string" && mcp.description.length > 0 && mcp.description.length <= 1024)));
        if (invalidShape) {
            fail("INVALID_ENDPOINT_MCP_DECLARATION", "Invalid endpoint MCP declaration.", "Declare mcp: true or mcp: { description } with a description of at most 1024 characters.");
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.startsWith(MCP_OPERATOR_TOOL_PREFIX)) {
            fail("INVALID_ENDPOINT_MCP_DECLARATION", "Invalid MCP tool name.", `Name MCP-exposed endpoints with 1-64 letters, digits, '_' or '-', not starting with ${MCP_OPERATOR_TOOL_PREFIX}.`);
        }
        if (options?.body?.multipart !== undefined || options?.response !== undefined) {
            fail("INVALID_ENDPOINT_MCP_DECLARATION", "MCP cannot bridge this endpoint.", "Expose only JSON endpoints; multipart ingress and File attachment responses are not bridged.");
        }
    }
}
function isPlainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function fail(code, message, hint) {
    const error = new Error(message);
    error.code = code;
    error.hint = hint;
    throw error;
}
//# sourceMappingURL=mcp-config.js.map