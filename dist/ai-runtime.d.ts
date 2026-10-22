import { type AiProtocol } from "./ai-openai-adapters.js";
type RecordValue = Record<string, any>;
/** A disabled stanza keeps whatever it declares, so per-call overrides can still fall back to it. */
export type AiConfig = Readonly<{
    enabled: false;
    api: AiProtocol;
    keyEnv: string;
    baseUrl?: string;
    model?: string;
}> | Readonly<{
    enabled: true;
    api: AiProtocol;
    keyEnv: string;
    baseUrl: string;
    model: string;
}>;
export type AiErrorCode = "AI_UNCONFIGURED" | "AI_INVALID_REQUEST" | "AI_TIMEOUT" | "AI_ABORTED" | "AI_UPSTREAM_ERROR" | "AI_INVALID_RESPONSE";
export declare const AI_DEFAULT_TIMEOUT_MS = 2000;
export declare const AI_MAX_TIMEOUT_MS = 30000;
/** Configuration names the key's Server env entry only; the key value never appears in sporades.json. */
export declare function validateAiConfig(value: unknown): AiConfig | undefined;
/**
 * One AI client per Capsule runtime over a provider adapter selected by `ai.api`. Calls never throw,
 * never retry, and never log prompt or response content: each emits one metering event only.
 */
export declare function createAiRuntime(config: unknown, serverEnv?: RecordValue, options?: {
    log?: (event: RecordValue) => unknown;
}): Readonly<{
    enabled: boolean;
    chat: (input: unknown, callOptions?: {
        signal?: AbortSignal;
        log?: (event: RecordValue) => unknown;
    }) => Promise<Readonly<{
        ok: true;
        data: Readonly<RecordValue>;
    }> | Readonly<{
        ok: false;
        error: Readonly<{
            status?: number | undefined;
            code: AiErrorCode;
            message: string;
        }>;
    }>>;
    /** Aborts in-flight calls at runtime shutdown; later calls settle as AI_ABORTED. */
    close(): void;
}>;
export {};
//# sourceMappingURL=ai-runtime.d.ts.map