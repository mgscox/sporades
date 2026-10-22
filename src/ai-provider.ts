// Provider-neutral AI boundary. Only adapter modules know a provider's wire format; the runtime
// core, Capsule context and public types use these shapes exclusively.

export type AiRole = "system" | "user" | "assistant";
export type AiFinishReason = "stop" | "length" | "content_filter" | "other";

/** A validated, bounded request. `jsonSchema.schema` is a detached JSON copy. */
export type AiRequest = Readonly<{
  system: string | null;
  messages: ReadonlyArray<Readonly<{ role: AiRole; content: string }>>;
  maxTokens: number | null;
  temperature: number | null;
  jsonSchema: Readonly<{ name: string; schema: Record<string, unknown>; strict: boolean }> | null;
}>;

/** A decoded provider reply. `null` counts mean the provider did not report them. */
export type AiReply = Readonly<{
  text: string;
  model: string | null;
  finishReason: AiFinishReason | null;
  usage: Readonly<{ prompt: number | null; completion: number | null; total: number | null }>;
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

export function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const tokenCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
