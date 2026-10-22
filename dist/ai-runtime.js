import { randomUUID } from "node:crypto";
import { isServerEnvReference } from "./mail-config-validation.js";
import { isPlainObject } from "./ai-provider.js";
import { AI_PROTOCOL_ADAPTERS } from "./ai-openai-adapters.js";
export const AI_DEFAULT_TIMEOUT_MS = 2000;
export const AI_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_KEY_ENV = "AI_API_KEY";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MESSAGES = 64;
const MAX_CONTENT_CHARS = 32_768;
const MAX_TOTAL_CHARS = 131_072;
const MAX_TOKENS = 32_768;
const MAX_SCHEMA_BYTES = 65_536;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);
function invalidAiConfig(hint) {
    throw Object.assign(new Error("Invalid AI configuration."), { code: "INVALID_AI_CONFIG", hint });
}
function plainEntries(value, allowed, hint) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalidAiConfig(hint);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalidAiConfig(hint);
    const entries = new Map();
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
            invalidAiConfig(hint);
        entries.set(key, descriptor.value);
    }
    return entries;
}
const validModel = (value) => typeof value === "string" && value.length <= 256 && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
const validKey = (value) => typeof value === "string" && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
const validApi = (value) => typeof value === "string" && Object.hasOwn(AI_PROTOCOL_ADAPTERS, value);
/** HTTPS anywhere; plain HTTP only for a model on this machine or its Docker host. */
function normalizeBaseUrl(value) {
    let url;
    try {
        if (typeof value !== "string" || value.length > 2048)
            throw new Error();
        url = new URL(value);
    }
    catch {
        return invalidAiConfig("Set `ai.baseUrl` to an absolute OpenAI-compatible API base URL such as `https://api.example.com/v1`.");
    }
    const localHttp = url.protocol === "http:" && (LOCAL_HTTP_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost"));
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
        invalidAiConfig("Use HTTPS for `ai.baseUrl` (plain HTTP is accepted only for localhost and host.docker.internal), without credentials, query, or fragment.");
    }
    return url.href.replace(/\/+$/, "");
}
/** Configuration names the key's Server env entry only; the key value never appears in sporades.json. */
export function validateAiConfig(value) {
    if (value === undefined)
        return undefined;
    const hint = "Configure `ai` as { enabled?, api?, baseUrl, model, keyEnv? }.";
    const data = plainEntries(value, ["enabled", "api", "baseUrl", "model", "keyEnv"], hint);
    const enabled = data.get("enabled") ?? true;
    if (typeof enabled !== "boolean")
        invalidAiConfig("Set `ai.enabled` to true or false.");
    const api = data.get("api") ?? "chat-completions";
    if (!validApi(api))
        invalidAiConfig("Set `ai.api` to \"chat-completions\" or \"responses\".");
    const keyEnv = data.get("keyEnv") ?? DEFAULT_KEY_ENV;
    if (!isServerEnvReference(keyEnv))
        invalidAiConfig("Set `ai.keyEnv` to an uppercase Server env key without the reserved `SPORADES_` prefix.");
    // A disabled stanza may stay incomplete, but anything present is still checked.
    const baseUrl = data.has("baseUrl") || enabled ? normalizeBaseUrl(data.get("baseUrl")) : null;
    const model = data.get("model");
    if ((data.has("model") || enabled) && !validModel(model)) {
        invalidAiConfig("Set `ai.model` to the provider's model name (printable ASCII, at most 256 characters).");
    }
    if (enabled)
        return Object.freeze({ enabled: true, api, baseUrl: baseUrl, model, keyEnv });
    return Object.freeze({ enabled: false, api, keyEnv, ...(baseUrl !== null ? { baseUrl } : {}), ...(model !== undefined ? { model } : {}) });
}
/** Per-call provider values. They take precedence over sporades.json `ai` and its Server env key. */
function parseProviderOverride(value) {
    if (value === undefined)
        return {};
    if (!isPlainObject(value) || Object.keys(value).some(key => !["api", "baseUrl", "model", "apiKey"].includes(key)))
        return null;
    const { api, baseUrl, model, apiKey } = value;
    if ((api !== undefined && !validApi(api)) || (model !== undefined && !validModel(model)) || (apiKey !== undefined && !validKey(apiKey)))
        return null;
    let normalizedBaseUrl;
    try {
        normalizedBaseUrl = baseUrl === undefined ? undefined : normalizeBaseUrl(baseUrl);
    }
    catch {
        return null;
    }
    return { api, baseUrl: normalizedBaseUrl, model, apiKey };
}
function parseChatInput(input) {
    if (!isPlainObject(input) || Object.keys(input).some(key => !["messages", "system", "maxTokens", "timeoutMs", "temperature", "jsonSchema", "provider"].includes(key)))
        return null;
    const { messages, system, maxTokens, timeoutMs = AI_DEFAULT_TIMEOUT_MS, temperature, jsonSchema } = input;
    const provider = parseProviderOverride(input.provider);
    if (!provider)
        return null;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES)
        return null;
    if (system !== undefined && (typeof system !== "string" || system.length > MAX_CONTENT_CHARS))
        return null;
    let total = typeof system === "string" ? system.length : 0;
    const normalized = [];
    for (const message of messages) {
        if (!isPlainObject(message) || Object.keys(message).some(key => key !== "role" && key !== "content"))
            return null;
        if (!["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > MAX_CONTENT_CHARS)
            return null;
        total += message.content.length;
        normalized.push(Object.freeze({ role: message.role, content: message.content }));
    }
    if (total > MAX_TOTAL_CHARS)
        return null;
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS))
        return null;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AI_MAX_TIMEOUT_MS)
        return null;
    if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2))
        return null;
    let schema = null;
    if (jsonSchema !== undefined) {
        if (!isPlainObject(jsonSchema) || Object.keys(jsonSchema).some(key => !["name", "schema", "strict"].includes(key)))
            return null;
        if (typeof jsonSchema.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(jsonSchema.name))
            return null;
        if (jsonSchema.strict !== undefined && typeof jsonSchema.strict !== "boolean")
            return null;
        let serialized;
        try {
            serialized = JSON.stringify(jsonSchema.schema);
        }
        catch {
            return null;
        }
        if (!isPlainObject(jsonSchema.schema) || Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES)
            return null;
        schema = Object.freeze({ name: jsonSchema.name, schema: JSON.parse(serialized), strict: jsonSchema.strict ?? true });
    }
    return {
        request: Object.freeze({ system: system ?? null, messages: Object.freeze(normalized), maxTokens: maxTokens ?? null, temperature: temperature ?? null, jsonSchema: schema }),
        timeoutMs,
        provider,
    };
}
async function readBounded(response) {
    const reader = response.body?.getReader();
    if (!reader)
        return "";
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => { });
            throw Object.assign(new Error("oversize"), { aiOversize: true });
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
const MESSAGES = {
    AI_UNCONFIGURED: "AI is not configured for this Capsule.",
    AI_INVALID_REQUEST: "Invalid AI request.",
    AI_TIMEOUT: "The AI provider did not respond in time.",
    AI_ABORTED: "The AI call was cancelled.",
    AI_UPSTREAM_ERROR: "The AI provider request failed.",
    AI_INVALID_RESPONSE: "The AI provider returned an unusable response.",
};
/**
 * One AI client per Capsule runtime over a provider adapter selected by `ai.api`. Calls never throw,
 * never retry, and never log prompt or response content: each emits one metering event only.
 */
export function createAiRuntime(config, serverEnv = {}, options = {}) {
    const declared = validateAiConfig(config) ?? null;
    const rawKey = declared ? serverEnv[declared.keyEnv] : undefined;
    const projectKey = typeof rawKey === "string" && validKey(rawKey.trim()) ? rawKey.trim() : null;
    // The project default is dormant while disabled or while the named key is absent, so existing Dev
    // sessions start unchanged. Per-call overrides may still fall back to whatever `ai` declares.
    const enabled = !!declared?.enabled && projectKey !== null;
    const stopped = new AbortController();
    async function chat(input, callOptions = {}) {
        const startedAt = performance.now();
        let status = null;
        let usage = { prompt: null, completion: null, total: null };
        let responseModel = null;
        let model = declared?.model ?? null;
        let api = declared?.api ?? null;
        const settle = (outcome, data) => {
            try {
                void Promise.resolve((callOptions.log ?? options.log)?.({
                    category: "ai", event: "ai.call", level: outcome === "ok" ? "info" : "warn",
                    message: outcome === "ok" ? "AI call completed." : "AI call failed.",
                    data: { api, model: responseModel ?? model, outcome, latencyMs: Math.round(performance.now() - startedAt), status, usage },
                    request: null, release: null, correlation: { ai: `ai_${randomUUID()}` },
                })).catch(() => { });
            }
            catch { }
            if (outcome === "ok")
                return Object.freeze({ ok: true, data: Object.freeze(data) });
            return Object.freeze({ ok: false, error: Object.freeze({ code: outcome, message: MESSAGES[outcome], ...(status !== null ? { status } : {}) }) });
        };
        let parsedInput;
        // Hostile getters or proxies must not turn a fail-open call into a rejection.
        try {
            parsedInput = parseChatInput(input);
        }
        catch {
            parsedInput = null;
        }
        if (!parsedInput)
            return settle("AI_INVALID_REQUEST");
        const { request, timeoutMs, provider } = parsedInput;
        // `enabled: false` switches off the project default only: a call with no override stays dormant.
        if (declared && !declared.enabled && !Object.values(provider).some(value => value !== undefined))
            return settle("AI_UNCONFIGURED");
        api = provider.api ?? api ?? "chat-completions";
        model = provider.model ?? model;
        const baseUrl = provider.baseUrl ?? declared?.baseUrl;
        // The project key only ever goes to the project base URL; another origin needs its own key.
        const key = provider.apiKey ?? (baseUrl === declared?.baseUrl ? projectKey : null);
        if (!baseUrl || !model || !key)
            return settle("AI_UNCONFIGURED");
        const adapter = AI_PROTOCOL_ADAPTERS[api];
        if (callOptions.signal?.aborted || stopped.signal.aborted)
            return settle("AI_ABORTED");
        const timeout = AbortSignal.timeout(timeoutMs);
        const signals = [timeout, stopped.signal, ...(callOptions.signal ? [callOptions.signal] : [])];
        const failure = () => timeout.aborted ? "AI_TIMEOUT" : signals.some(signal => signal.aborted) ? "AI_ABORTED" : "AI_UPSTREAM_ERROR";
        let text;
        try {
            // redirect: "error" keeps the key and prompt on the configured origin only.
            const response = await fetch(`${baseUrl}${adapter.path}`, {
                method: "POST", redirect: "error", signal: AbortSignal.any(signals),
                headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify(adapter.encode(request, model)),
            });
            status = response.status;
            if (!response.ok) {
                // Provider error bodies may echo the prompt; discard them unread.
                await response.body?.cancel().catch(() => { });
                return settle(failure());
            }
            text = await readBounded(response);
        }
        catch (error) {
            return settle(error?.aiOversize ? "AI_INVALID_RESPONSE" : failure());
        }
        let reply;
        try {
            reply = adapter.decode(JSON.parse(text));
        }
        catch {
            return settle("AI_INVALID_RESPONSE");
        }
        if (!reply)
            return settle("AI_INVALID_RESPONSE");
        usage = { ...reply.usage };
        responseModel = reply.model;
        const data = {
            text: reply.text,
            model: reply.model ?? model,
            finishReason: reply.finishReason,
            usage: Object.freeze({ promptTokens: reply.usage.prompt, completionTokens: reply.usage.completion, totalTokens: reply.usage.total }),
        };
        if (request.jsonSchema) {
            try {
                data.json = JSON.parse(reply.text);
            }
            catch {
                return settle("AI_INVALID_RESPONSE");
            }
        }
        return settle("ok", data);
    }
    return Object.freeze({
        enabled,
        chat,
        /** Aborts in-flight calls at runtime shutdown; later calls settle as AI_ABORTED. */
        close() { stopped.abort(); },
    });
}
//# sourceMappingURL=ai-runtime.js.map