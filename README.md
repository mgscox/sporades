# Sporades

## File uploads

Client code uses `files.upload()` from `sporades/client` to upload browser
`File` or `Blob` values. The SDK first asks the Sporades server for an upload
URL, transfers the bytes internally, and resolves with Sporades-owned metadata:
file ID, original filename, MIME type, size, bucket, storage path, and version.
Arrays are accepted as a convenience and are uploaded sequentially.

Uploaded bytes are private by default and scoped to the current authenticated
user in that user's `default` bucket. During dev sessions, bytes live under
`.sporades/files/`; metadata, buckets, upload records, and public URL records
live in the `.sporades/data.db` SQLite database. Container sessions use the
mounted `/app/data` volume for the same platform-managed storage.

Private reads go through `files.url(fileId)` or `files.download(fileId)`.
Public reads must be created explicitly with exactly one expiry choice:
`ttlSeconds`, `expires`, or `noExpiry: true`. Replacing a file preserves the file
ID, creates a new version, and invalidates previously generated private and
public URLs.

## Endpoint handlers

Capsules can register custom HTTP endpoints with `endpoint({ method, path }, handler)`.
The handler receives the same server-owned context concepts as queries and
mutations:

```ts
endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => ({
  status: 202,
  headers: { "x-sporades-endpoint": "accepted" },
  body: {
    method: ctx.request.method,
    path: ctx.request.path,
    query: ctx.request.query,
    body: ctx.request.body,
    userId: ctx.auth.userId,
  },
}));
```

`ctx` includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.log`, and `ctx.request`.
`ctx.request` exposes `method`, `path`, lower-cased `headers`, query parameters,
and parsed request body data. Structured endpoint responses use
`{ status, headers, body }`; object bodies are returned as JSON, and string bodies
are returned as text.

## App messages

Capsules can declare ephemeral app-level messages with `message(handler)` and
clients can send them through `sporades/client` without touching raw WebSocket
objects:

```ts
// server/index.ts
import { capsule, message } from "sporades/server";

export default capsule({
  messages: {
    typing: message((ctx, data) => {
      ctx.messages.send({ type: "typing", data });
      return { ok: true };
    }),
  },
});
```

```ts
// client/index.tsx
import { onMessage, sendMessage } from "sporades/client";

await sendMessage("typing", { roomId: "general", active: true });

const subscription = onMessage()
  .filter((message) => message.type === "typing")
  .subscribe((message) => {
    console.log(message.data);
  });
```

App and server code use unprefixed type names. Sporades reserves platform
namespaces such as `app.`, `auth.`, `query.`, `mutation.`, `files.`, and
`runtime.` for internal transport messages. Client-origin app messages always
run through declared Capsule handlers; the platform does not directly relay
arbitrary client messages. `ctx.messages.send()` defaults to the current user's
connected clients, and handlers can explicitly target users with
`{ scope: "users", userIds: [...] }`. App-wide `{ scope: "all" }` broadcasts are
not available from client-origin handlers.

App messages are a real-time escape hatch for JSON-serializable, ephemeral
events. Use queries and mutations for durable state, auth APIs for identity, and
file APIs for binary payloads.

## Context middleware

Capsules can register synchronous context middleware with `middleware`. Each
function receives the current `ctx` and can return an enriched context for the
request handler, query, mutation, or mutation hook:

```ts
export default capsule({
  middleware: [
    (ctx) => ({ ...ctx, tenant: ctx.env.TENANT }),
    (ctx) => {
      if (!ctx.tenant) {
        throw Object.assign(new Error("Missing tenant."), {
          hint: "Set TENANT in .env.sporades.server.",
        });
      }
      return ctx;
    },
  ],
});
```

Middleware runs once per WebSocket query request, WebSocket mutation request, and
HTTP endpoint request. Functions run in the order they appear in the array, and
each function receives the context returned by the previous function. Middleware
receives `ctx.kind` as `"query"`, `"mutation"`, or `"endpoint"`. Throw an error
with a `hint` property to block the request with a structured Sporades error.
