export type AiRole = "system" | "user" | "assistant";
export type AiFinishReason = "stop" | "length" | "content_filter" | "other";
/** A validated, bounded request. `jsonSchema.schema` is a detached JSON copy. */
export type AiRequest = Readonly<{
    system: string | null;
    messages: ReadonlyArray<Readonly<{
        role: AiRole;
        content: string;
    }>>;
    maxTokens: number | null;
    temperature: number | null;
    jsonSchema: Readonly<{
        name: string;
        schema: Record<string, unknown>;
        strict: boolean;
    }> | null;
}>;
/** A decoded provider reply. `null` counts mean the provider did not report them. */
export type AiReply = Readonly<{
    text: string;
    model: string | null;
    finishReason: AiFinishReason | null;
    usage: Readonly<{
        prompt: number | null;
        completion: number | null;
        total: number | null;
    }>;
}>;
/**
 * One wire protocol. `encode` returns the JSON request body for `path` (relative to the configured
 * base URL); `decode` returns null for a reply carrying no usable text, such as a refusal.
 */
export interface AiProviderAdapter {
    readonly path: string;
    encode(request: AiRequest, model: string): unknown;
    decode(body: unknown): AiReply | null;
}
export declare function isPlainObject(value: unknown): value is Record<string, any>;
export declare const tokenCount: (value: unknown) => number | null;
//# sourceMappingURL=ai-provider.d.ts.map