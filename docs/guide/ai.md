# AI

`ctx.ai` is a small, server-only client for OpenAI-compatible model endpoints.
It is meant for short synchronous calls on the request path, such as checking a
form answer before it is saved. Calls never throw and never retry, so a handler
can fail open: when the model is slow, unavailable, or unconfigured, accept the
input and carry on.

Capsules use provider-neutral types. Provider wire formats stay inside runtime
adapters, and no provider SDK is bundled into Capsule code.

## Configure a provider

Add an `ai` section to `sporades.json` and store the key in Sealed Server env:

```json
{
  "ai": {
    "api": "chat-completions",
    "baseUrl": "https://api.example.com/v1",
    "model": "small-model",
    "keyEnv": "AI_API_KEY"
  }
}
```

```sh
sporades env set AI_API_KEY --stdin
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the project default dormant. |
| `api` | `"chat-completions"` | Wire protocol: `"chat-completions"` posts to `{baseUrl}/chat/completions`; `"responses"` posts to `{baseUrl}/responses` with `store: false`. |
| `baseUrl` | required | The API base, usually ending in `/v1`. HTTPS, or plain HTTP for `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and `host.docker.internal`. No credentials, query or fragment. |
| `model` | required | The provider's model name. |
| `keyEnv` | `"AI_API_KEY"` | The Server env key that holds the API key. Only the name goes in `sporades.json`. |

The integration is dormant until the named key has a value: the Capsule starts
normally, `ctx.ai.enabled` is `false`, and calls return `AI_UNCONFIGURED`.
`keyEnv` is never added to the [required Server env](../reference/projects-and-configuration.md#required-server-env)
set, so `sporades doctor` and `sporades host push` accept an env without it.
Declare it in `env.required` yourself if a release must not ship without AI.

Local models work through the same endpoint. For Ollama, use
`"baseUrl": "http://localhost:11434/v1"` in a Dev session, or
`http://host.docker.internal:11434/v1` from a Container session, and set the key
to any non-empty value. Ollama and vLLM both serve Chat Completions; use
`"api": "responses"` only for providers that implement the Responses API.
OpenAI's reasoning models reject `max_tokens` on Chat Completions, so use
`"api": "responses"` with those models when you set `maxTokens`.

## Check an answer on submit

This mutation checks a VAT number's shape before saving it. It rate-limits the
check per user, masks the identifier so the provider never sees the real value,
and accepts the answer whenever the check cannot complete.

```ts
import { capsule, mutation, String, table } from "sporades/server";

// 9 for digits, A for letters: the model judges the shape, never the value.
const mask = (value: string) => value.replace(/[0-9]/g, "9").replace(/[A-Za-z]/g, "A");

const verdict = {
  type: "object",
  properties: { plausible: { type: "boolean" }, reason: { type: "string" } },
  required: ["plausible", "reason"],
  additionalProperties: false,
};

export default capsule({
  name: "answers",
  schema: { answers: table({ field: String(), value: String(), ownerId: String() }) },
  mutations: {
    submitVatNumber: mutation(async (ctx, value: string, confirmed: boolean) => {
      if (!confirmed && ctx.rateLimit(`ai-check:${ctx.auth.userId}`, { limit: 20, windowMs: 60_000 }).ok) {
        const check = await ctx.ai.chat<{ plausible: boolean; reason: string }>({
          system: "Judge whether the masked value has the shape of a UK VAT number. 9 is any digit, A any letter.",
          messages: [{ role: "user", content: mask(value) }],
          jsonSchema: { name: "vat_shape", schema: verdict },
          maxTokens: 60,
          timeoutMs: 1500,
        });
        // Fail open: only a successful "implausible" verdict asks the user to confirm.
        if (check.ok && !check.data.json.plausible) {
          return { saved: false, warning: check.data.json.reason };
        }
      }
      await ctx.db.answers.insert({ field: "vat", value, ownerId: ctx.auth.userId });
      return { saved: true };
    }),
  },
});
```

A mutation's transaction stays open while the call runs, so keep `timeoutMs`
short and call the model before writing. A Custom endpoint or a Job can make the
same call outside a client mutation.

## Call options

`ctx.ai.chat(input)` accepts:

| Field | Limits | Meaning |
| --- | --- | --- |
| `messages` | 1–64, roles `user`, `assistant`, `system` | The conversation. |
| `system` | string | Instructions placed before the conversation. |
| `maxTokens` | 1–32768 | Output token ceiling, sent as `max_tokens` (Chat Completions) or `max_output_tokens` (Responses). Some providers require a higher minimum, such as 16 for the Responses API. |
| `timeoutMs` | 1–30000, default 2000 | Deadline for the whole call, including reading the reply. |
| `temperature` | 0–2 | Omit to use the provider default. |
| `jsonSchema` | `{ name, schema, strict? }` | Request structured JSON output. `strict` defaults to `true`. The parsed value is returned as `data.json`. |
| `provider` | `{ api?, baseUrl?, model?, apiKey? }` | Per-call overrides (see below). |

Each content string may be up to 32,768 characters, and all content together up
to 131,072. Input outside these bounds returns `AI_INVALID_REQUEST` without a
network call.

### Override the provider per call

Every value in `provider` takes precedence over `sporades.json` and the Server
env key, and works even when `ai` is absent or disabled. Values that are not
given fall back to the project settings. If no base URL, model or key remains,
the call returns `AI_UNCONFIGURED`. `baseUrl` follows the same rules as
`ai.baseUrl`. The project key is only ever sent to the project base URL: a call
that overrides `baseUrl` must also pass `apiKey`.

```ts
// Staging points at a local model; production uses the project default.
const provider = ctx.env.AI_STAGING_URL
  ? { baseUrl: ctx.env.AI_STAGING_URL, model: "llama3.1:8b", apiKey: "ollama" }
  : undefined;
const result = await ctx.ai.chat({ messages, provider });
```

`ctx.ai.enabled` describes only the project default.

## Results

Calls resolve to a result object:

```ts
{ ok: true, data: { text, json?, model, finishReason, usage } }
{ ok: false, error: { code, message, status? } }
```

`usage` holds `promptTokens`, `completionTokens` and `totalTokens`, each `null`
when the provider does not report it. `finishReason` is `"stop"`, `"length"`
(output hit `maxTokens`), `"content_filter"`, `"other"`, or `null`.

| Code | When |
| --- | --- |
| `AI_UNCONFIGURED` | No base URL, model or key after applying `provider` over the project default. Nothing is sent. |
| `AI_INVALID_REQUEST` | Input outside the documented bounds. Nothing is sent. |
| `AI_TIMEOUT` | `timeoutMs` elapsed. The request is cancelled. |
| `AI_ABORTED` | The handler signal (a cancelled Job, or a client that disconnected from a Custom endpoint) or runtime shutdown cancelled the call. |
| `AI_UPSTREAM_ERROR` | A network failure, a redirect, or a non-2xx reply. `status` carries the HTTP status when there was one. |
| `AI_INVALID_RESPONSE` | The reply was not JSON, exceeded 1 MiB, carried no text (for example a refusal), or did not parse as JSON for a `jsonSchema` call. |

## Privacy and metering

- Prompts, replies and provider error bodies are never logged or returned.
- Requests go only to the resolved base URL. Redirects are refused rather than
  followed.
- The Responses API is called with `store: false`. Choose a zero-data-retention
  provider or a local model for free text, and mask identifiers before sending.
- Each call writes one `ai.call` event to the [JSONL log](../reference/operations-and-hosting.md):

```json
{ "category": "ai", "event": "ai.call", "level": "info",
  "data": { "api": "chat-completions", "model": "small-model", "outcome": "ok",
            "latencyMs": 412, "status": 200,
            "usage": { "prompt": 58, "completion": 9, "total": 67 } } }
```

Failed calls log at `warn` with the error code as `outcome`. Use these events to
track cost per Capsule, for example with `sporades logs --json`.

`ctx.ai` is available to queries, mutations, Custom endpoints, App message
handlers, middleware, lifecycle hooks, Jobs and Privileged callbacks. It is not
available in browser code.
