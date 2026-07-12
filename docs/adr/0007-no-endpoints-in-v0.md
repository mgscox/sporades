# Historical v0 endpoint deferral

Status: Superseded

Superseded by the implemented Custom endpoints runtime. This ADR remains as
the historical decision for the first v0 local-only scope.

v0 did not include `endpoint({ method, path }, handler)`. The server exposed
queries, mutations, and auth over the WebSocket transport. In an interpreted sandbox environment,
endpoints existed partly to receive Google OAuth callbacks; early Sporades
deferred webhooks and other HTTP-based integrations.

Current behavior supports Custom endpoints declared in Capsule definitions with
`endpoint({ method, path }, handler)`. Endpoints receive normal Sporades
context plus `ctx.request`, can resolve auth from the
`x-sporades-session-token` header, and are intended as HTTP integration escape
hatches rather than the primary app data API.
