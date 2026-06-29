# Add context middleware

Status: ready-for-agent

## What to build

Add Capsule-level context middleware so developers can consistently enrich or guard context across queries, mutations, and endpoints. Middleware should compose with existing auth, env, database, logging, endpoint, and mutation hook behavior.

## Acceptance criteria

- [ ] A Capsule can register context middleware through the `capsule()` definition.
- [ ] Middleware runs for queries, mutations, and endpoints.
- [ ] Middleware can read the existing context and return an enriched context for the handler.
- [ ] Middleware can block a request with a structured error.
- [ ] Middleware ordering is deterministic and documented.
- [ ] Middleware behavior is covered across WebSocket query/mutation requests and HTTP endpoint requests.

## Blocked by

- .scratch/sporades-v1/issues/08-expose-endpoint-context-and-structured-responses.md
- .scratch/sporades-v1/issues/10-add-pre-post-mutation-hooks.md
