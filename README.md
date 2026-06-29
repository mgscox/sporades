# Sporades

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
