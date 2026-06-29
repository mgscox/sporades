# Add SDK-level app messages over client transport

Status: done

## What to build

Allow app-defined messages over the existing Sporades client transport without exposing raw WebSocket objects to app code. App and server code should provide unprefixed type names; Sporades owns the internal `app.` prefix and reserved platform namespaces. Messages should be sent/received through `sporades/client` SDK primitives and through server `ctx`.

## Acceptance criteria

- [x] App code can send arbitrary JSON-serializable app messages with unprefixed type names.
- [x] Server code can send app messages through context, for example `ctx.messages.send({ type: "whatever", data, scope })`.
- [x] Sporades adds and reserves the internal `app.` prefix; app and server code do not provide it manually.
- [x] App code can subscribe to app messages through SDK APIs, including filter-style usage such as `onMessage().filter((message) => message.type === "whatever")`.
- [x] App messages default to delivery only to the current user's connected clients.
- [x] App-wide broadcast with `{ scope: "all" }` can only be sent from server code.
- [x] Client-origin app messages cannot broadcast to all connected clients.
- [x] Client-origin app messages are always mediated by server code.
- [x] The platform does not directly relay arbitrary client messages to other clients without a server handler.
- [x] Client-origin app messages enter server code through declared capsule handlers, for example `capsule({ messages: { typing: message((ctx, data) => ...) } })`.
- [x] Message handlers are typed, discoverable, and testable in the same spirit as queries and mutations.
- [x] Message handlers can return a response to the originating SDK call.
- [x] Fan-out uses explicit server calls such as `ctx.messages.send()`.
- [x] v2 app messages are ephemeral and are not persisted or replayed.
- [x] App message payloads are JSON-serializable only.
- [x] Binary payloads use `files.*`, not app messages.
- [x] Targeted multi-user delivery requires an explicit scope, such as `{ scope: "users", userIds: [...] }`.
- [x] Targeted client-origin delivery is authorized server-side.
- [x] App code does not receive or manipulate raw WebSocket instances.
- [x] Core Sporades message types for auth, queries, mutations, files, and runtime control remain reserved.
- [x] Attempts to use platform-reserved type names fail with structured errors and actionable hints.
- [x] App messages are documented as an escape hatch for real-time events, not a replacement for queries, mutations, auth, or files.

## Blocked by

None - can start once the SDK API shape is agreed.
