# Building the Server

Use the server authoring interface to define tables, queries, mutations,
authorization policy, middleware, and HTTP integration endpoints.

Start at the narrowest server seam: declare one table, expose one query, then
add the mutation that changes it. Apply ACL policy at the table and
`requireAuth` at handlers that must reject Anonymous sessions. Use middleware
only for behaviour genuinely shared across handlers.

Server handlers receive runtime-owned `ctx` capabilities. Keep secrets in
Sealed Server env, use the current actor by default, and enter the Privileged
server role only for explicitly userless system work.

Work through [tables, queries, mutations, `requireAuth`, Server env, middleware,
and actor selection](./reference.md#building-the-server-side). For inbound HTTP
integrations, continue with [Custom HTTP endpoints](./reference.md#custom-http-endpoints).

Keep browser concerns in the [client](./client.md), and use [Jobs and Schedules](./background-work.md) for durable background work.
