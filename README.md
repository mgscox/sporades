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
