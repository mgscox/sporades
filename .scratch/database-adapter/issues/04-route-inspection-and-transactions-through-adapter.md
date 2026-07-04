Status: done

# Route Inspection And Transactions Through Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Move transaction boundaries and database inspection surfaces onto the Database adapter so command/runtime code above the adapter no longer relies on SQLite-specific internals.

## Acceptance criteria

- [x] Mutation transaction handling uses adapter-owned transaction primitives.
- [x] `sporades db` inspection/query behavior is preserved through adapter-backed inspection methods.
- [x] Runtime health checks use adapter-backed database checks.
- [x] SQLite-specific inspection remains available for SQLite through the adapter without leaking into higher layers.
- [x] Tests cover transaction commit/rollback, mutation failure behavior, `sporades db` output, and health checks.

## Blocked by

- .scratch/database-adapter/issues/03-route-runtime-storage-through-adapter.md
