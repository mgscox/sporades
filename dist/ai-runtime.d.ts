import { type AiConfig } from "./ai-config.js";
/**
 * Runtime-owned `ctx.ai` client for OpenAI-compatible endpoints.
 *
 * The Capsule-facing contract is provider-neutral: `chat(input)` takes neutral messages and resolves
 * a closed result object. It never throws and never retries. OpenAI wire shapes — Chat Completions
 * and Responses — exist only inside the two adapters below. Prompt and response content never
 * reaches a log, an error message, or telemetry; each call emits one `ai.call` metering event with
 * api, model, token counts, latency and outcome.
 */
export type AiErrorCode = "AI_UNCONFIGURED" | "AI_INVALID_REQUEST" | "AI_TIMEOUT" | "AI_ABORTED" | "AI_UPSTREAM_ERROR" | "AI_INVALID_RESPONSE";
type Emit = ((event: Record<string, unknown>) => unknown) | undefined;
export declare const AI_DEFAULT_TIMEOUT_MS = 2000;
export declare const AI_MAX_TIMEOUT_MS = 30000;
export declare const AI_MIN_TIMEOUT_MS = 100;
export declare const AI_MAX_MESSAGES = 64;
export declare const AI_MAX_PROMPT_BYTES: number;
export declare const AI_MAX_SCHEMA_BYTES: number;
export declare const AI_MAX_RESPONSE_BYTES: number;
export declare const AI_MAX_OUTPUT_TOKENS = 131072;
export type AiRuntime = Readonly<{
    enabled: boolean;
    chat(input: unknown, options?: {
        emit?: Emit;
        signal?: AbortSignal | null;
    }): Promise<unknown>;
}>;
export declare function createAiRuntime(config: AiConfig | undefined, serverEnv?: Record<string, unknown>): AiRuntime;
/** The frozen `ctx.ai` projection handed to one handler context. */
export declare function createContextAiApi(ai: AiRuntime | undefined, emit: Emit, signal: () => AbortSignal | null | undefined): Readonly<{
    enabled: boolean;
    chat(input: unknown): Promise<unknown>;
}>;
export {};
//# sourceMappingURL=ai-runtime.d.ts.map