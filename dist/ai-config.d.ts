/**
 * Optional `sporades.json` `ai` declaration for the runtime-owned `ctx.ai` client.
 *
 * Kept apart from `ai-runtime.ts` so `cli/project-config.ts` can validate a project at build time
 * without importing the HTTP client. The API key is never configuration: `keyEnv` names a Sealed
 * Server env key, and a missing value leaves the client dormant rather than failing startup.
 */
export type AiApiKind = "chat-completions" | "responses";
export type AiConfig = Readonly<{
    enabled: boolean;
    api: AiApiKind;
    baseUrl?: string;
    model?: string;
    keyEnv: string;
}>;
export declare const AI_DEFAULT_KEY_ENV = "AI_API_KEY";
export declare const AI_API_KINDS: readonly AiApiKind[];
/**
 * Own enumerable data properties of a plain object, read without invoking getters. Returns null for
 * anything else so callers decide how to fail.
 */
export declare function captureAiRecord(value: unknown, allowed: ReadonlySet<string>): Map<string, unknown> | null;
export declare function isAiApiKind(value: unknown): value is AiApiKind;
export declare function isAiModelName(value: unknown): value is string;
/**
 * Normalizes an OpenAI-compatible base URL, or returns null. HTTPS is accepted for any host; plain
 * HTTP only for loopback, private-address, `host.docker.internal` and single-label hosts, so a
 * bearer key never crosses the public Internet unencrypted. Credentials, query and fragment are
 * refused, and a trailing slash is removed so `/chat/completions` and `/responses` append cleanly.
 */
export declare function normalizeAiBaseUrl(value: unknown): string | null;
/** Validates the optional `ai` project declaration. Returns undefined when it is omitted. */
export declare function validateAiConfig(value: unknown): AiConfig | undefined;
//# sourceMappingURL=ai-config.d.ts.map