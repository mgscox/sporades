# AI checks

Sporades owns a small server-only client for OpenAI-compatible model endpoints:
`ctx.ai.chat(...)`. It is meant for short, synchronous checks on the request
path — for example "this doesn't look like a VAT number, submit anyway?" — and
works unchanged against a hosted zero-data-retention provider or a local model
served by Ollama or vLLM. No provider SDK is bundled into Capsule code; the
OpenAI wire formats stay inside the runtime.

## Configure a provider

Declare the endpoint in `sporades.json` and store the key in Sealed Server env:

```json
{
  "ai": {
    "api": "chat-completions",
    "baseUrl": "https://api.example-zdr.com/v1",
    "model": "small-checker",
    "keyEnv": "AI_API_KEY"
  }
}
```

```sh
sporades env set AI_API_KEY --stdin
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the declaration dormant; `baseUrl` and `model` may then be omitted. |
| `api` | `"chat-completions"` | `"chat-completions"` (`POST {baseUrl}/chat/completions`) or `"responses"` (`POST {baseUrl}/responses`, always sent with `store: false`). |
| `baseUrl` | — | Required when enabled. HTTPS for any host; plain HTTP only for loopback, private-network (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), `host.docker.internal`, or single-label hosts such as a Compose service named `ollama`. No credentials, query, or fragment. |
| `model` | — | Required when enabled. 1–256 printable characters. |
| `keyEnv` | `"AI_API_KEY"` | Sealed Server env key holding the bearer key. Uppercase, no `SPORADES_` prefix. |

The client is **dormant while the key is unset**: the Capsule starts normally,
`ctx.ai.enabled` is `false`, and calls resolve `AI_UNCONFIGURED`. The AI key is
deliberately **not** part of the [required Server env](./configuration.md#required-server-env)
set, so `sporades doctor` and `sporades host push` are unaffected by declaring
`ai`. Add `keyEnv` to `env.required` yourself if a release must not ship
without it. Omitting `ai` leaves existing Capsules unchanged.

A local model needs no real key, but the client still requires a non-empty value
so a dormant Capsule never calls out by accident:

```json
{ "ai": { "baseUrl": "http://host.docker.internal:11434/v1", "model": "llama3.2" } }
```

```sh
printf 'local' | sporades env set AI_API_KEY --stdin
```

## Call it from server code

```ts
import { capsule, mutation } from "sporades/server";

export default capsule({
  name: "Client Input Chaser",
  mutations: {
    checkVatNumber: mutation(async (ctx, value: string) => {
      const result = await ctx.ai.chat({
        system: "Decide whether the text is plausibly a VAT registration number.",
        messages: [{ role: "user", content: value }],
        maxTokens: 64,
        jsonSchema: {
          type: "object",
          properties: { plausible: { type: "boolean" }, reason: { type: "string" } },
          required: ["plausible", "reason"],
          additionalProperties: false,
        },
      });
      // Never block the user on the model: fall back to accepting the input.
      if (!result.ok) return { warn: false };
      const answer = result.json as { plausible?: unknown };
      return { warn: answer?.plausible === false };
    }),
  },
});
```

`ctx.ai` is available to queries, mutations, Custom endpoints, App messages,
middleware, mutation hooks, lifecycle hooks, Jobs, and active Privileged
callbacks. It is absent from client code, table ACL rules, and Schedule payload
factories. Like other external effects, it is refused inside a
[resource scope](../reference/jobs-and-schedules.md#sqlite-resource-transactions-ticket-02),
and calling it first prevents the same handler from entering one.

### Input

| Field | Notes |
| --- | --- |
| `messages` | 1–64 `{ role: "user" \| "assistant", content: string }` turns. |
| `system` | Optional instructions, sent as a system message or Responses `instructions`. |
| `maxTokens` | Optional output cap, 1–131072 (`max_tokens` / `max_output_tokens`). |
| `timeoutMs` | Whole-call deadline, 100–30000 ms. **Defaults to 2000.** |
| `temperature` | Optional, 0–2. |
| `jsonSchema` | Optional JSON Schema object (≤ 64 KiB) requested in strict structured-output mode. The text is parsed into `json`; Sporades does not validate it against the schema, so check the shape you rely on. |
| `provider` | Optional `{ api?, baseUrl?, model?, apiKey? }` overriding the project settings for this call only. Overrides refine a declared, enabled `ai` block; they cannot activate an undeclared or disabled one. |
| `signal` | Optional `AbortSignal`. A Job's or Privileged callback's `ctx.signal` is honoured automatically. |

Combined `system` and message content is limited to 256 KiB. Unknown fields,
accessor properties and non-JSON schema values are rejected.

### Result

`ctx.ai.chat(...)` **never throws and never retries**. It resolves one of:

```ts
{ ok: true, text, json?, usage: { inputTokens, outputTokens, totalTokens }, model }
{ ok: false, code, message, status? }
```

| Code | When |
| --- | --- |
| `AI_UNCONFIGURED` | `ai` is omitted or `enabled: false`, or no key/base URL/model resolves. |
| `AI_INVALID_REQUEST` | The input failed validation. Nothing was sent. Input is validated before configuration, so a dormant Capsule still reports malformed calls. |
| `AI_TIMEOUT` | `timeoutMs` elapsed before the complete response arrived. |
| `AI_ABORTED` | The caller's or context's signal aborted the call. |
| `AI_UPSTREAM_ERROR` | Network failure, a refused redirect, or a non-2xx status (reported in `status`). |
| `AI_INVALID_RESPONSE` | The body was not valid JSON, exceeded 1 MiB, lacked text output, or schema output did not parse as JSON. |

`message` is a constant per code. Provider error bodies are discarded, never
returned or logged.

## Privacy and transport

- Prompt, system and response content is never logged. Each call emits exactly
  one `ai.call` event (category `ai`) with `api`, `model`, `outcome` (`ok` or
  the error code), optional HTTP `status`, `usage.input` / `usage.output` /
  `usage.total` token counts, and `latencyMs`.
- Requests use `redirect: "error"`, so a provider redirect cannot carry the
  bearer key to another origin. The Responses API is always sent with
  `store: false`. Choose a zero-data-retention provider or a local model for
  personal data; Sporades does not control what the provider retains.
- A per-call `provider.apiKey` is used only for that request.

## Transactions

A model call is external: it cannot roll back with a failed mutation, and a
mutation awaiting it keeps its database transaction open until the call
settles. Keep `timeoutMs` short on mutation paths, or call `ctx.ai` from a query
or Custom endpoint before writing. For work that may take longer than a request
should wait, call it from a [Job](./background-work.md).
