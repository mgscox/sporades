import {
  type AiApiKind, type AiConfig, captureAiRecord, isAiApiKind, isAiModelName, normalizeAiBaseUrl,
} from "./ai-config.js";

/**
 * Runtime-owned `ctx.ai` client for OpenAI-compatible endpoints.
 *
 * The Capsule-facing contract is provider-neutral: `chat(input)` takes neutral messages and resolves
 * a closed result object. It never throws and never retries. OpenAI wire shapes — Chat Completions
 * and Responses — exist only inside the two adapters below. Prompt and response content never
 * reaches a log, an error message, or telemetry; each call emits one `ai.call` metering event with
 * api, model, token counts, latency and outcome.
 */
export type AiErrorCode =
  | "AI_UNCONFIGURED" | "AI_INVALID_REQUEST" | "AI_TIMEOUT" | "AI_ABORTED" | "AI_UPSTREAM_ERROR" | "AI_INVALID_RESPONSE";

type Usage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
type Message = { role: "user" | "assistant"; content: string };
type Request = {
  api: AiApiKind; baseUrl: string; model: string; apiKey: string;
  system: string | null; messages: Message[]; maxTokens: number | null; temperature: number | null;
  jsonSchema: Record<string, unknown> | null; timeoutMs: number; signal: AbortSignal | null;
};
type Emit = ((event: Record<string, unknown>) => unknown) | undefined;

export const AI_DEFAULT_TIMEOUT_MS = 2_000;
export const AI_MAX_TIMEOUT_MS = 30_000;
export const AI_MIN_TIMEOUT_MS = 100;
export const AI_MAX_MESSAGES = 64;
export const AI_MAX_PROMPT_BYTES = 256 * 1024;
export const AI_MAX_SCHEMA_BYTES = 64 * 1024;
export const AI_MAX_RESPONSE_BYTES = 1024 * 1024;
export const AI_MAX_OUTPUT_TOKENS = 131_072;

const INPUT_KEYS = new Set(["messages", "system", "maxTokens", "timeoutMs", "temperature", "jsonSchema", "provider", "signal"]);
const PROVIDER_KEYS = new Set(["api", "baseUrl", "model", "apiKey"]);
const MESSAGE_KEYS = new Set(["role", "content"]);
const SCHEMA_NAME = "response";

const FAILURE_MESSAGES: Record<AiErrorCode, string> = {
  AI_UNCONFIGURED: "AI is not configured.",
  AI_INVALID_REQUEST: "The AI request is invalid.",
  AI_TIMEOUT: "The AI provider did not respond in time.",
  AI_ABORTED: "The AI request was aborted.",
  AI_UPSTREAM_ERROR: "The AI provider request failed.",
  AI_INVALID_RESPONSE: "The AI provider returned an invalid response.",
};

class AiFailure {
  constructor(readonly code: AiErrorCode, readonly status: number | null = null) {}
}

function failure(code: AiErrorCode, status: number | null = null) {
  return Object.freeze({
    ok: false as const,
    code,
    message: FAILURE_MESSAGES[code],
    ...(status === null ? {} : { status }),
  });
}

function utf8Length(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isPlainJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !isPlainJsonValue(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !isPlainJsonValue(descriptor.value, depth + 1)) return false;
  }
  return true;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal === "function" && value instanceof AbortSignal;
}

function readMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AI_MAX_MESSAGES) throw new AiFailure("AI_INVALID_REQUEST");
  const messages: Message[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const data = descriptor && Object.hasOwn(descriptor, "value") ? captureAiRecord(descriptor.value, MESSAGE_KEYS) : null;
    const role = data?.get("role");
    const content = data?.get("content");
    if (!data || (role !== "user" && role !== "assistant") || typeof content !== "string") throw new AiFailure("AI_INVALID_REQUEST");
    messages.push({ role, content });
  }
  return messages;
}

function resolveRequest(config: AiConfig | undefined, serverEnv: Record<string, unknown>, input: unknown, contextSignal: AbortSignal | null): Request {
  const data = captureAiRecord(input, INPUT_KEYS);
  if (!data) throw new AiFailure("AI_INVALID_REQUEST");
  const messages = readMessages(data.get("messages"));
  const system = data.get("system");
  if (system !== undefined && typeof system !== "string") throw new AiFailure("AI_INVALID_REQUEST");
  const promptBytes = messages.reduce((total, message) => total + utf8Length(message.content), typeof system === "string" ? utf8Length(system) : 0);
  if (promptBytes > AI_MAX_PROMPT_BYTES) throw new AiFailure("AI_INVALID_REQUEST");
  const maxTokens = data.get("maxTokens");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > AI_MAX_OUTPUT_TOKENS)) {
    throw new AiFailure("AI_INVALID_REQUEST");
  }
  const timeoutMs = data.get("timeoutMs") ?? AI_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < AI_MIN_TIMEOUT_MS || (timeoutMs as number) > AI_MAX_TIMEOUT_MS) {
    throw new AiFailure("AI_INVALID_REQUEST");
  }
  const temperature = data.get("temperature");
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new AiFailure("AI_INVALID_REQUEST");
  }
  const rawSchema = data.get("jsonSchema");
  let jsonSchema: Record<string, unknown> | undefined;
  if (rawSchema !== undefined) {
    if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema) || !isPlainJsonValue(rawSchema)) throw new AiFailure("AI_INVALID_REQUEST");
    // Send a snapshot, so the bytes measured here are the bytes that leave the process.
    const serialized = JSON.stringify(rawSchema);
    if (utf8Length(serialized) > AI_MAX_SCHEMA_BYTES) throw new AiFailure("AI_INVALID_REQUEST");
    jsonSchema = JSON.parse(serialized);
  }
  const signal = data.get("signal");
  if (signal !== undefined && !isAbortSignal(signal)) throw new AiFailure("AI_INVALID_REQUEST");
  const rawProvider = data.get("provider");
  const provider = rawProvider === undefined ? new Map<string, unknown>() : captureAiRecord(rawProvider, PROVIDER_KEYS);
  if (!provider) throw new AiFailure("AI_INVALID_REQUEST");
  const api = provider.get("api");
  if (api !== undefined && !isAiApiKind(api)) throw new AiFailure("AI_INVALID_REQUEST");
  const overrideBaseUrl = provider.has("baseUrl") ? normalizeAiBaseUrl(provider.get("baseUrl")) : undefined;
  if (overrideBaseUrl === null) throw new AiFailure("AI_INVALID_REQUEST");
  const overrideModel = provider.get("model");
  if (overrideModel !== undefined && !isAiModelName(overrideModel)) throw new AiFailure("AI_INVALID_REQUEST");
  const overrideKey = provider.get("apiKey");
  if (overrideKey !== undefined && (typeof overrideKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(overrideKey))) {
    throw new AiFailure("AI_INVALID_REQUEST");
  }

  // The project declaration is the deployer's opt-in. Per-call overrides refine it; they cannot
  // stand in for it, so an undeclared or disabled project stays dormant whatever the call carries.
  if (!config?.enabled) throw new AiFailure("AI_UNCONFIGURED");
  const projectKey = Object.getOwnPropertyDescriptor(serverEnv, config.keyEnv)?.value;
  const apiKey = overrideKey ?? (typeof projectKey === "string" && projectKey.trim().length > 0 ? projectKey.trim() : null);
  const baseUrl = overrideBaseUrl ?? config.baseUrl;
  const model = (overrideModel as string | undefined) ?? config.model;
  if (!apiKey || !baseUrl || !model) throw new AiFailure("AI_UNCONFIGURED");
  const signals = [signal as AbortSignal | undefined, contextSignal ?? undefined].filter(isAbortSignal);
  return {
    api: (api as AiApiKind | undefined) ?? config.api,
    baseUrl, model, apiKey,
    system: typeof system === "string" ? system : null,
    messages,
    maxTokens: (maxTokens as number | undefined) ?? null,
    temperature: (temperature as number | undefined) ?? null,
    jsonSchema: jsonSchema ?? null,
    timeoutMs: timeoutMs as number,
    signal: signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  };
}

// ---- Wire adapters. OpenAI request and response shapes stay below this line. ----

function chatCompletionsBody(request: Request) {
  return {
    model: request.model,
    messages: [
      ...(request.system === null ? [] : [{ role: "system", content: request.system }]),
      ...request.messages.map(message => ({ role: message.role, content: message.content })),
    ],
    stream: false,
    ...(request.maxTokens === null ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.jsonSchema === null ? {} : {
      response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema: request.jsonSchema, strict: true } },
    }),
  };
}

function responsesBody(request: Request) {
  return {
    model: request.model,
    ...(request.system === null ? {} : { instructions: request.system }),
    input: request.messages.map(message => ({ role: message.role, content: message.content })),
    store: false,
    stream: false,
    ...(request.maxTokens === null ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.jsonSchema === null ? {} : {
      text: { format: { type: "json_schema", name: SCHEMA_NAME, schema: request.jsonSchema, strict: true } },
    }),
  };
}

function tokenCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseChatCompletions(payload: unknown): { text: string; usage: Usage } {
  const choices = record(payload)?.choices;
  const message = Array.isArray(choices) ? record(record(choices[0])?.message) : null;
  if (!message || typeof message.content !== "string") throw new AiFailure("AI_INVALID_RESPONSE");
  const usage = record(record(payload)?.usage);
  return {
    text: message.content,
    usage: {
      inputTokens: tokenCount(usage?.prompt_tokens),
      outputTokens: tokenCount(usage?.completion_tokens),
      totalTokens: tokenCount(usage?.total_tokens),
    },
  };
}

function parseResponses(payload: unknown): { text: string; usage: Usage } {
  const body = record(payload);
  const status = body?.status;
  if (status !== undefined && status !== "completed" && status !== "incomplete") throw new AiFailure("AI_INVALID_RESPONSE");
  if (!Array.isArray(body?.output)) throw new AiFailure("AI_INVALID_RESPONSE");
  const parts: string[] = [];
  for (const item of body.output) {
    const entry = record(item);
    if (entry?.type !== "message" || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) {
      const content = record(part);
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  if (parts.length === 0) throw new AiFailure("AI_INVALID_RESPONSE");
  const usage = record(body.usage);
  return {
    text: parts.join(""),
    usage: {
      inputTokens: tokenCount(usage?.input_tokens),
      outputTokens: tokenCount(usage?.output_tokens),
      totalTokens: tokenCount(usage?.total_tokens),
    },
  };
}

// ---- End of wire adapters. ----

async function readBoundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AI_MAX_RESPONSE_BYTES) {
    // Rejecting without reading still owns the body: release it, or the transport stays open.
    await discardBody(response);
    throw new AiFailure("AI_INVALID_RESPONSE");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    await discardBody(response);
    throw new AiFailure("AI_INVALID_RESPONSE");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > AI_MAX_RESPONSE_BYTES) throw new AiFailure("AI_INVALID_RESPONSE");
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* disposal is best effort */ }
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new AiFailure("AI_INVALID_RESPONSE");
  }
}

async function discardBody(response: Response) {
  try { await response.body?.cancel(); } catch { /* disposal is best effort */ }
}

async function send(request: Request) {
  if (request.signal?.aborted) throw new AiFailure("AI_ABORTED");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([timeout.signal, request.signal]) : timeout.signal;
  const classifyAbort = () => new AiFailure(request.signal?.aborted ? "AI_ABORTED" : "AI_TIMEOUT");
  try {
    const path = request.api === "responses" ? "/responses" : "/chat/completions";
    const body = request.api === "responses" ? responsesBody(request) : chatCompletionsBody(request);
    let response: Response;
    try {
      response = await fetch(`${request.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch {
      if (signal.aborted) throw classifyAbort();
      throw new AiFailure("AI_UPSTREAM_ERROR");
    }
    if (!response.ok) {
      await discardBody(response);
      throw new AiFailure("AI_UPSTREAM_ERROR", response.status);
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (signal.aborted) throw classifyAbort();
      if (error instanceof AiFailure) throw error;
      throw new AiFailure("AI_UPSTREAM_ERROR");
    }
    if (signal.aborted) throw classifyAbort();
    const parsed = request.api === "responses" ? parseResponses(payload) : parseChatCompletions(payload);
    if (request.jsonSchema === null) return { ...parsed, json: undefined };
    let json: unknown;
    try {
      json = JSON.parse(parsed.text);
    } catch {
      throw new AiFailure("AI_INVALID_RESPONSE");
    }
    return { ...parsed, json };
  } finally {
    clearTimeout(timer);
    // Backstop: once the call has a result, nothing may keep reading. Aborting the per-call
    // controller tears down any response body a failure path did not release. After a complete
    // read this is a no-op, because the body has already been fully consumed.
    timeout.abort();
  }
}

function meter(emit: Emit, data: Record<string, unknown>) {
  if (typeof emit !== "function") return;
  try {
    const outcome = data.outcome;
    const emitted = emit({
      category: "ai",
      event: "ai.call",
      level: outcome === "ok" ? "info" : "warn",
      message: outcome === "ok" ? "AI call completed." : "AI call failed.",
      data,
      request: null,
      release: null,
    });
    if (emitted && typeof (emitted as Promise<unknown>).then === "function") (emitted as Promise<unknown>).then(undefined, () => {});
  } catch { /* metering never changes the call result */ }
}

export type AiRuntime = Readonly<{
  enabled: boolean;
  chat(input: unknown, options?: { emit?: Emit; signal?: AbortSignal | null }): Promise<unknown>;
}>;

export function createAiRuntime(config: AiConfig | undefined, serverEnv: Record<string, unknown> = {}): AiRuntime {
  const projectKey = config ? Object.getOwnPropertyDescriptor(serverEnv, config.keyEnv)?.value : undefined;
  const enabled = Boolean(config?.enabled && config.baseUrl && config.model && typeof projectKey === "string" && projectKey.trim().length > 0);
  return Object.freeze({
    enabled,
    async chat(input: unknown, options: { emit?: Emit; signal?: AbortSignal | null } = {}) {
      const startedAt = performance.now();
      let request: Request | null = null;
      let result: Record<string, unknown>;
      let usage: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };
      try {
        try {
          request = resolveRequest(config, serverEnv, input, isAbortSignal(options.signal) ? options.signal : null);
        } catch (error) {
          // A hostile input (a Proxy trap, a throwing toJSON) is still only an invalid request.
          throw error instanceof AiFailure ? error : new AiFailure("AI_INVALID_REQUEST");
        }
        const response = await send(request);
        usage = response.usage;
        result = Object.freeze({
          ok: true as const,
          text: response.text,
          ...(response.json === undefined ? {} : { json: response.json }),
          usage: Object.freeze({ ...usage }),
          model: request.model,
        });
      } catch (error) {
        result = error instanceof AiFailure ? failure(error.code, error.status) : failure("AI_UPSTREAM_ERROR");
      }
      meter(options.emit, {
        api: request?.api ?? config?.api ?? null,
        model: request?.model ?? config?.model ?? null,
        outcome: result.ok ? "ok" : result.code,
        ...(typeof result.status === "number" ? { status: result.status } : {}),
        // Token counts, under names the log redactor does not mistake for credentials.
        usage: { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens },
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      return result;
    },
  });
}

/** The frozen `ctx.ai` projection handed to one handler context. */
export function createContextAiApi(ai: AiRuntime | undefined, emit: Emit, signal: () => AbortSignal | null | undefined) {
  const runtime = ai ?? createAiRuntime(undefined);
  return Object.freeze({
    enabled: runtime.enabled,
    chat(input: unknown) {
      return runtime.chat(input, { emit, signal: signal() ?? null });
    },
  });
}
