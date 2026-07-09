Status: done

# Expose Privileged Run Across Trusted Server Surfaces

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Make `ctx.privileged.run(...)` behave consistently across trusted Capsule server surfaces: queries, mutations, Custom endpoints, App messages, context middleware, and lifecycle-supported paths. Middleware may perform a privileged run, but privilege remains scoped to that callback and must not silently make downstream handlers privileged.

## Acceptance criteria

- [x] Queries, mutations, Custom endpoints, App messages, context middleware, and supported lifecycle hooks can each perform an explicit privileged run where a server context exists.
- [x] A privileged run inside context middleware does not make the downstream query, mutation, endpoint, or message handler privileged.
- [x] Returning or leaking the derived privileged context from middleware is disallowed or made ineffective.
- [x] Lifecycle runs emit audit events for each actual lifecycle execution, including repeated Dev restart or rebuild executions where applicable.
- [x] Shutdown hook behavior stays within existing shutdown guarantees and does not add stronger shutdown ordering, waiting, or retry semantics.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md

## Verification

- Issue-swarm worker: 019f42f0-24f2-7240-b88a-20b5028b0f3d
- Review: 019f430c-c362-7312-9227-4283e175c960 accepted after leaked privileged file API fix.
- `npm run build`
- `node --test test/database-adapter.test.js --test-name-pattern "privileged runs are available across trusted server surfaces|supported lifecycle hooks emit privileged audit events|leaked privileged table APIs|privileged file access can read"`
- `node ./scripts/check-generated-bin.mjs`
- `node --test test/client-runtime.test.js --test-name-pattern "browser client runtime exposes no Privileged server role authority"`
- `git diff --check`
