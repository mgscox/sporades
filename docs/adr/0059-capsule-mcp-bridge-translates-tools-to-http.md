# ADR-0059: The Capsule MCP bridge translates tools to HTTP routes

Status: Accepted

## Context

Agents increasingly speak the Model Context Protocol (MCP). Reaching a running
Capsule today means either the CLI (Dev debug routes behind a Dev inspection
token, `docker exec` actions for Container sessions, SSH to the Host helper for
Hosted Capsules) or Capsule-specific HTTP endpoints. None of these is an MCP
server, so an agent needs an LLM-driven wrapper or a hand-written bridge to call
them.

The PRD lists "a public hosted management API" as a non-goal. An MCP route that
serves operator tools on Container and Hosted Capsules is such an API, so this
ADR narrows that non-goal deliberately.

## Decision

1. **One opt-in route.** `sporades.json` declares
   `mcp: { "enabled": true, "keyEnv": "<NAME>" }`. `keyEnv` names a Sealed Server
   env key (the usual `^[A-Z][A-Z0-9_]*$` shape, outside the reserved `SPORADES_`
   prefix). The runtime then serves `POST /__sporades/mcp` in Dev, Container and
   Hosted sessions using MCP's stateless Streamable HTTP transport (JSON-RPC 2.0;
   `initialize`, `ping`, `tools/list`, `tools/call`).
2. **One key protects every bridge route.** Each request to `/__sporades/mcp` and
   to the operator routes under `/__sporades/ops/` must carry
   `Authorization: Bearer <key>`, compared in constant time. A wrong or absent
   key gets an opaque `401`. When MCP is disabled, or the configured key is
   absent or shorter than 32 characters, those routes answer the ordinary `404`.
   The key is set and rotated with `sporades env set <NAME> --stdin` and takes
   effect on the next runtime start, push or Dev rebuild.
3. **A tool is one HTTP request.** The bridge is a static translation table:
   `tools/call` becomes one loopback `fetch` against the runtime's own listener,
   and the tool result carries that response's status and body unchanged. The
   bridge contains no model and no tool-specific logic.
4. **Operator tools** map to key-guarded runtime routes:
   `sporades_logs` → `GET /__sporades/ops/logs`,
   `sporades_logs_tail` → `GET /__sporades/ops/logs/tail`,
   `sporades_db_list` → `GET /__sporades/ops/db/list`,
   `sporades_db_dump` → `GET /__sporades/ops/db/dump`,
   `sporades_db_query` → `POST /__sporades/ops/db/query` (read-only SQL).
   These reuse the Dev inspection implementations; the Dev-only, token-guarded
   `/__sporades/debug/*` routes are unchanged. Local identity simulation stays
   Dev-only and is not bridged. Further operator routes (Jobs, Schedules,
   Access keys) join the table when they become HTTP routes.
5. **Capsule tools are opt-in endpoints.** A Custom endpoint appears as a tool
   only when declared with `mcp: true` or `mcp: { description }`. Its input is
   `{ query?: Record<string, string>, body?: JSON }`. The bridged request carries
   no MCP key and no caller credential, so the endpoint sees an ordinary
   unauthenticated request and applies its own authorization. Undeclared
   endpoints cannot be listed or called.

## Consequences

- The key is operator authority: it can read the full database and logs. It is
  never logged and never forwarded to Capsule code.
- Bridged requests pass the same security, admission and quota checks as any
  other request, from a loopback address. A Hosted admission policy with
  address rules fails closed for them, and quotas count both the MCP request and
  its bridged request.
- Queries, mutations, App messages and live subscriptions are not tools. A
  Capsule that wants one bridged wraps it in an exposed endpoint.
- No new dependency: the JSON-RPC surface is small and implemented directly.
