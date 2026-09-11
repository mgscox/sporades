import { randomUUID } from "node:crypto";
import { commandError } from "./runtime-errors.js";
// Shared by the writer and config validation so identity fallbacks and schema
// overhead cannot drift. Data is already sanitized by the writer.
export function uncappedLogEnvelope(input) {
    const config = input.config ?? {};
    const capsuleName = String(config.name ?? "unknown");
    return {
        schema: "sporades.log.v1",
        timestamp: input.timestamp ?? new Date().toISOString(),
        category: input.category ?? "platform",
        event: input.event ?? "runtime.event",
        level: input.level ?? "info",
        message: String(input.message ?? ""),
        capsule: {
            name: capsuleName,
            id: String(config.capsule?.id ?? config.id ?? capsuleName),
        },
        release: input.release ?? config.release ?? null,
        request: input.request
            ? {
                id: input.request.id ?? randomUUID(),
                method: input.request.method ?? null,
                path: input.request.path ?? null,
            }
            : null,
        correlation: input.correlation ?? null,
        data: input.data ?? null,
    };
}
export function minimumLogPayloadMaxBytes(config = {}) {
    const envelope = uncappedLogEnvelope({
        config,
        timestamp: "2000-01-01T00:00:00.000Z",
        category: "c".repeat(16),
        level: "l".repeat(16),
        event: "e".repeat(64),
        message: "m".repeat(128),
        data: null,
    });
    // String allowances count JSON-escaped UTF-8 content, excluding quotes.
    // Replace the four-byte null with 256 bytes of sanitized, serialized data.
    return Buffer.byteLength(JSON.stringify({ ...envelope, truncated: false }), "utf8") - 4 + 256;
}
export function logPayloadMaxBytes(config = {}) {
    return config.logs?.payloadMaxBytes ?? config.logging?.payloadMaxBytes ?? 4096;
}
export function validateLogConfig(config = {}) {
    const minimum = minimumLogPayloadMaxBytes(config);
    const fail = (key) => {
        throw commandError("Invalid log payload cap.", `Set \`${key}.payloadMaxBytes\` to an integer of at least ${minimum} bytes for this Capsule in sporades.json.`, "INVALID_LOG_CONFIG");
    };
    for (const key of ["logs", "logging"]) {
        const value = config[key]?.payloadMaxBytes;
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum))
            fail(key);
    }
    // Even the implicit default must carry the configured identity. Never silently
    // raise an operator's cap, or impose an unrelated Capsule naming restriction.
    if (logPayloadMaxBytes(config) < minimum)
        fail("logs");
}
//# sourceMappingURL=log-envelope.js.map