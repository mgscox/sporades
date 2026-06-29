# Add context middleware

Status: done

## What to build

Add Capsule-level context middleware so developers can consistently enrich or guard context across queries, mutations, and endpoints. Middleware should compose with existing auth, env, database, logging, endpoint, and mutation hook behavior.

## Acceptance criteria

- [x] A Capsule can register context middleware through the `capsule()` definition.
- [x] Middleware runs for queries, mutations, and endpoints.
- [x] Middleware can read the existing context and return an enriched context for the handler.
- [x] Middleware can block a request with a structured error.
- [x] Middleware ordering is deterministic and documented.
- [x] Middleware behavior is covered across WebSocket query/mutation requests and HTTP endpoint requests.

## Blocked by

- .scratch/sporades-v1/issues/08-expose-endpoint-context-and-structured-responses.md
- .scratch/sporades-v1/issues/10-add-pre-post-mutation-hooks.md
