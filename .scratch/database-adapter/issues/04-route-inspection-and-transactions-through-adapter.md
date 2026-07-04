Status: ready-for-agent

# Route Inspection And Transactions Through Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Move transaction boundaries and database inspection surfaces onto the Database adapter so command/runtime code above the adapter no longer relies on SQLite-specific internals.

## Acceptance criteria

- [ ] Mutation transaction handling uses adapter-owned transaction primitives.
- [ ] `sporades db` inspection/query behavior is preserved through adapter-backed inspection methods.
- [ ] Runtime health checks use adapter-backed database checks.
- [ ] SQLite-specific inspection remains available for SQLite through the adapter without leaking into higher layers.
- [ ] Tests cover transaction commit/rollback, mutation failure behavior, `sporades db` output, and health checks.

## Blocked by

- .scratch/database-adapter/issues/03-route-runtime-storage-through-adapter.md

