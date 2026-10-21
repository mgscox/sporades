import { commandError } from "./runtime-errors.js";
export const AI_DEFAULT_KEY_ENV = "AI_API_KEY";
export const AI_API_KINDS = Object.freeze(["chat-completions", "responses"]);
const AI_CONFIG_KEYS = new Set(["enabled", "api", "baseUrl", "model", "keyEnv"]);
const AI_MODEL_MAX_LENGTH = 256;
const AI_BASE_URL_MAX_LENGTH = 2048;
function invalidAiConfig(message, hint) {
    throw commandError(message, hint, "INVALID_AI_CONFIG");
}
/**
 * Own enumerable data properties of a plain object, read without invoking getters. Returns null for
 * anything else so callers decide how to fail.
 */
export function captureAiRecord(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return null;
    const entries = new Map();
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.has(key))
            return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
            return null;
        entries.set(key, descriptor.value);
    }
    return entries;
}
export function isAiApiKind(value) {
    return typeof value === "string" && AI_API_KINDS.includes(value);
}
export function isAiModelName(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= AI_MODEL_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
function isAiServerEnvReference(value) {
    return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
}
function isNonPublicHostname(hostname) {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal")
        return true;
    if (host.startsWith("[") && host.endsWith("]")) {
        const address = host.slice(1, -1);
        return address === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(address);
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    // A single-label name (a Compose service such as `ollama` or `vllm`) cannot be a public DNS name.
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}
/**
 * Normalizes an OpenAI-compatible base URL, or returns null. HTTPS is accepted for any host; plain
 * HTTP only for loopback, private-address, `host.docker.internal` and single-label hosts, so a
 * bearer key never crosses the public Internet unencrypted. Credentials, query and fragment are
 * refused, and a trailing slash is removed so `/chat/completions` and `/responses` append cleanly.
 */
export function normalizeAiBaseUrl(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > AI_BASE_URL_MAX_LENGTH || /[\s\0]/.test(value))
        return null;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return null;
    if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#"))
        return null;
    if (!url.hostname)
        return null;
    if (url.protocol === "http:" && !isNonPublicHostname(url.hostname))
        return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
/** Validates the optional `ai` project declaration. Returns undefined when it is omitted. */
export function validateAiConfig(value) {
    if (value === undefined)
        return undefined;
    const data = captureAiRecord(value, AI_CONFIG_KEYS);
    if (!data) {
        invalidAiConfig("Invalid AI configuration.", "Set `ai` to an object with only enabled, api, baseUrl, model, and keyEnv, or omit it.");
    }
    const enabled = data.get("enabled");
    if (enabled !== undefined && typeof enabled !== "boolean") {
        invalidAiConfig("Invalid AI enablement.", "Set `ai.enabled` to a boolean, or omit it to enable the declaration.");
    }
    const api = data.get("api") ?? "chat-completions";
    if (!isAiApiKind(api)) {
        invalidAiConfig("Invalid AI API.", "Set `ai.api` to `chat-completions` or `responses`.");
    }
    const keyEnv = data.get("keyEnv") ?? AI_DEFAULT_KEY_ENV;
    if (!isAiServerEnvReference(keyEnv)) {
        invalidAiConfig("Invalid AI Server env reference.", "Set `ai.keyEnv` to an uppercase Server env key name without the reserved `SPORADES_` prefix.");
    }
    const active = enabled !== false;
    const rawBaseUrl = data.get("baseUrl");
    const baseUrl = rawBaseUrl === undefined ? null : normalizeAiBaseUrl(rawBaseUrl);
    if ((rawBaseUrl !== undefined || active) && baseUrl === null) {
        invalidAiConfig("Invalid AI base URL.", "Set `ai.baseUrl` to an HTTPS URL such as `https://api.openai.com/v1`; plain HTTP is accepted only for loopback, private-network, host.docker.internal, or single-label hosts. Do not include credentials, a query, or a fragment.");
    }
    const rawModel = data.get("model");
    if ((rawModel !== undefined || active) && !isAiModelName(rawModel)) {
        invalidAiConfig("Invalid AI model.", `Set \`ai.model\` to a model name of 1-${AI_MODEL_MAX_LENGTH} printable characters without spaces.`);
    }
    // Absent fields stay absent, so validating the normalized value again yields the same value.
    return Object.freeze({
        enabled: active,
        api,
        keyEnv,
        ...(baseUrl === null ? {} : { baseUrl }),
        ...(rawModel === undefined ? {} : { model: rawModel }),
    });
}
//# sourceMappingURL=ai-config.js.map