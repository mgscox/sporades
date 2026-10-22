# MCP bridge

A Capsule can serve a [Model Context Protocol](https://modelcontextprotocol.io)
endpoint so agents can call its operator tools and selected Custom endpoints
directly. The bridge has no model inside it: each tool call becomes one HTTP
request against the Capsule, and the tool returns that response's status and
body. See [ADR-0059](../adr/0059-capsule-mcp-bridge-translates-tools-to-http.md).

## Enable the bridge

Name a Sealed Server env key in `sporades.json`:

```json
{
  "mcp": { "enabled": true, "keyEnv": "MCP_API_KEY" }
}
```

Then set the key itself. Use at least 32 random characters:

```sh
openssl rand -base64 48 | sporades env set MCP_API_KEY --stdin
```

`keyEnv` must be an uppercase Server env name outside the reserved `SPORADES_`
prefix. The runtime reads the key at startup, so a new or rotated key takes
effect on the next Dev rebuild, `sporades deploy`, Host push or restart.
Rotate it by setting a new value and restarting; the old key stops working
immediately.

The bridge works the same in Dev sessions, local Container sessions and Hosted
Capsules.

## Authentication

Every bridge route needs `Authorization: Bearer <key>`:

- `POST /__sporades/mcp`
- every route under `/__sporades/ops/`

A missing or wrong key gets `401` with no detail. If `mcp` is absent or
disabled, or the configured key is missing or shorter than 32 characters, the
routes answer `404` as if they did not exist. In the last case the runtime logs
one `mcp.key.unavailable` warning naming the env key, never its value.

The key is operator authority. It can read every table and log entry, so keep
it out of client code and source control.

## Connect a client

The bridge uses MCP's stateless Streamable HTTP transport: JSON-RPC 2.0 over
`POST`, one JSON response per request, no server-sent events and no session.
It supports `initialize`, `ping`, `tools/list` and `tools/call`.

Point any MCP client that supports remote HTTP servers with custom headers at
the Capsule:

```json
{
  "mcpServers": {
    "my-capsule": {
      "type": "http",
      "url": "https://notes.example.com/__sporades/mcp",
      "headers": { "Authorization": "Bearer ${MCP_API_KEY}" }
    }
  }
}
```

## Tools

### Operator tools

Each operator tool is one key-guarded runtime route:

| Tool | Route | Input |
| --- | --- | --- |
| `sporades_logs` | `GET /__sporades/ops/logs` | none |
| `sporades_logs_tail` | `GET /__sporades/ops/logs/tail` | none |
| `sporades_db_list` | `GET /__sporades/ops/db/list` | none |
| `sporades_db_dump` | `GET /__sporades/ops/db/dump` | none |
| `sporades_db_query` | `POST /__sporades/ops/db/query` | `{ "sql": "select ..." }` (read-only) |

The routes return the same envelopes as `sporades logs --json` and
`sporades db list|dump|query --json`, and can also be called directly with the
key. Local identity simulation (`sporades auth as`) stays Dev-only.

### Capsule tools

A Custom endpoint becomes a tool only when it opts in with `mcp`:

```ts
endpoints: {
  openInvoices: endpoint(
    { method: "GET", path: "/api/invoices/open", mcp: { description: "Open invoices for a Team" } },
    async (ctx) => ({ body: await listOpenInvoices(ctx, ctx.request.query.teamId) }),
  ),
  internal: endpoint({ method: "POST", path: "/api/internal" }, handler), // not a tool
}
```

`mcp: true` uses `METHOD /path` as the description. The tool name is the
endpoint's key, which must be 1–64 letters, digits, `_` or `-` and must not
start with `sporades_`. Multipart ingress and File attachment endpoints cannot
opt in.

A Capsule tool takes `{ "query"?: { [name]: string }, "body"?: any }`. `query`
becomes the query string; `body` is sent as JSON (not for `GET` or `HEAD`).
The bridged request carries neither the MCP key nor any caller credential, so
the endpoint sees an ordinary unauthenticated request with a fresh Anonymous
session and must apply its own authorization.

Queries, mutations, App messages and live subscriptions are not tools. Wrap
one in an exposed endpoint to bridge it.

### Results

Every `tools/call` result has the same shape:

```json
{
  "content": [{ "type": "text", "text": "{\"status\":200,\"body\":{...}}" }],
  "structuredContent": { "status": 200, "body": { } },
  "isError": false
}
```

`body` is the parsed JSON response, or the raw text if it is not JSON.
`isError` is `true` for any status of 400 or above. An unknown or unexposed
tool, or malformed arguments, returns JSON-RPC error `-32602`.

## Admission and limits

The MCP request and each bridged request are ordinary HTTP requests. Both pass
the security policy, request-admission policy and quotas. The bridged request
arrives from the runtime's own address, so on a Hosted Capsule an admission
policy with address rules fails closed for it, and quotas count both requests.
Request bodies follow `http.maxBodyBytes`.
