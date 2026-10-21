# Building the Server

Use the server authoring interface to define tables, queries, mutations,
authorization policy, middleware, and HTTP integration endpoints.

Start at the narrowest server seam: declare one table, expose one query, then
add the mutation that changes it. Apply ACL policy at the table and wrap
handlers that must reject Anonymous sessions with declarative
`requireAuth(handler)`. Use `requireUserAuth(ctx)` for an inline user check;
the older inline `requireAuth(ctx)` spelling remains a deprecated compatible
alias. Use middleware only for behaviour genuinely shared across handlers.

Server handlers receive runtime-owned `ctx` capabilities. Keep secrets in
Sealed Server env, use the current actor by default, and enter the Privileged
server role only for explicitly userless system work.

Work through [tables, queries, mutations, `requireAuth`, `requireUserAuth`,
Credential provenance, Server env, middleware, and actor
selection](../reference/server-runtime.md#building-the-server-side).
For inbound HTTP integrations, continue with
[Custom HTTP endpoints](../reference/server-runtime.md#custom-http-endpoints).

Keep browser concerns in the [client](./client.md), and use [Jobs and Schedules](./background-work.md) for durable background work.

## Send email from trusted server code

Configure one SMTP provider in [`sporades.json`](./configuration.md#smtp-mail),
then call `ctx.mail.send(...)` from a query, mutation, Custom endpoint, App
message, middleware, mutation hook, lifecycle hook, Job, or active Privileged
callback. `ctx.mail` is not available to client code, table ACL rules, or
Schedule payload factories.

Use a direct send only when the handler should wait for the provider and the
side effect is safe to happen immediately. SMTP delivery cannot participate in
a database Transaction: if a later write fails or rolls back, a message already
accepted by the SMTP server cannot be recalled.

For important or retryable notifications, enqueue a durable Job and send from
the Job handler. Job execution is at least once, so make delivery idempotent at
the application level—for example, retain a stable notification key and a sent
record, and tolerate an interrupted attempt being recovered. See the complete
[durable mail Job example](./configuration.md#durable-mail-with-jobs).

## Ask a model from trusted server code

Declare an OpenAI-compatible endpoint under [`ai`](./ai.md#configure-a-provider)
in `sporades.json`, store its key in Sealed Server env, then call
`ctx.ai.chat({ messages, system?, maxTokens?, timeoutMs?, temperature?, jsonSchema?, provider? })`.
The call never throws and never retries: it resolves `{ ok: true, text, json?, usage, model }`
or `{ ok: false, code }` with one of `AI_UNCONFIGURED`, `AI_INVALID_REQUEST`,
`AI_TIMEOUT`, `AI_ABORTED`, `AI_UPSTREAM_ERROR` (with `status`), or
`AI_INVALID_RESPONSE`. Prompt and response content is never logged. See the
[AI checks guide](./ai.md).
