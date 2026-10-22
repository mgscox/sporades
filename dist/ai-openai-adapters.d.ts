import { type AiProviderAdapter } from "./ai-provider.js";
/** Chat Completions (`POST {base}/chat/completions`): OpenAI, Ollama, vLLM and most hosted providers. */
export declare const chatCompletionsAdapter: Readonly<AiProviderAdapter>;
/**
 * Responses (`POST {base}/responses`). Sends `store: false` so the provider does not retain the
 * response object for later retrieval.
 */
export declare const responsesAdapter: Readonly<AiProviderAdapter>;
export declare const AI_PROTOCOL_ADAPTERS: Readonly<{
    "chat-completions": Readonly<AiProviderAdapter>;
    responses: Readonly<AiProviderAdapter>;
}>;
export type AiProtocol = keyof typeof AI_PROTOCOL_ADAPTERS;
//# sourceMappingURL=ai-openai-adapters.d.ts.map