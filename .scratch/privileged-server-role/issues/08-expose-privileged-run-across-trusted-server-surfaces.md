Status: ready-for-agent

# Expose Privileged Run Across Trusted Server Surfaces

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Make `ctx.privileged.run(...)` behave consistently across trusted Capsule server surfaces: queries, mutations, Custom endpoints, App messages, context middleware, and lifecycle-supported paths. Middleware may perform a privileged run, but privilege remains scoped to that callback and must not silently make downstream handlers privileged.

## Acceptance criteria

- [ ] Queries, mutations, Custom endpoints, App messages, context middleware, and supported lifecycle hooks can each perform an explicit privileged run where a server context exists.
- [ ] A privileged run inside context middleware does not make the downstream query, mutation, endpoint, or message handler privileged.
- [ ] Returning or leaking the derived privileged context from middleware is disallowed or made ineffective.
- [ ] Lifecycle runs emit audit events for each actual lifecycle execution, including repeated Dev restart or rebuild executions where applicable.
- [ ] Shutdown hook behavior stays within existing shutdown guarantees and does not add stronger shutdown ordering, waiting, or retry semantics.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md
