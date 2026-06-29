# Add SDK-level app messages over client transport

Status: needs-triage

## What to build

Allow app-defined messages over the existing Sporades client transport without exposing raw WebSocket objects to app code. App and server code should provide unprefixed type names; Sporades owns the internal `app.` prefix and reserved platform namespaces. Messages should be sent/received through `sporades/client` SDK primitives and through server `ctx`.

## Acceptance criteria

- [ ] App code can send arbitrary JSON-serializable app messages with unprefixed type names.
- [ ] Server code can send app messages through context, for example `ctx.messages.send({ type: "whatever", data, scope })`.
- [ ] Sporades adds and reserves the internal `app.` prefix; app and server code do not provide it manually.
- [ ] App code can subscribe to app messages through SDK APIs, including filter-style usage such as `onMessage().filter((message) => message.type === "whatever")`.
- [ ] App messages default to delivery only to the current user's connected clients.
- [ ] App-wide broadcast with `{ scope: "all" }` can only be sent from server code.
- [ ] Client-origin app messages cannot broadcast to all connected clients.
- [ ] Client-origin app messages are always mediated by server code.
- [ ] The platform does not directly relay arbitrary client messages to other clients without a server handler.
- [ ] Client-origin app messages enter server code through declared capsule handlers, for example `capsule({ messages: { typing: message((ctx, data) => ...) } })`.
- [ ] Message handlers are typed, discoverable, and testable in the same spirit as queries and mutations.
- [ ] Message handlers can return a response to the originating SDK call.
- [ ] Fan-out uses explicit server calls such as `ctx.messages.send()`.
- [ ] v2 app messages are ephemeral and are not persisted or replayed.
- [ ] App message payloads are JSON-serializable only.
- [ ] Binary payloads use `files.*`, not app messages.
- [ ] Targeted multi-user delivery requires an explicit scope, such as `{ scope: "users", userIds: [...] }`.
- [ ] Targeted client-origin delivery is authorized server-side.
- [ ] App code does not receive or manipulate raw WebSocket instances.
- [ ] Core Sporades message types for auth, queries, mutations, files, and runtime control remain reserved.
- [ ] Attempts to use platform-reserved type names fail with structured errors and actionable hints.
- [ ] App messages are documented as an escape hatch for real-time events, not a replacement for queries, mutations, auth, or files.

## Blocked by

None - can start once the SDK API shape is agreed.
