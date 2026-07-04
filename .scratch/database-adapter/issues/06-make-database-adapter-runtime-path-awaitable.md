Status: ready-for-agent

# Make Database Adapter Runtime Path Awaitable

## Parent

.scratch/database-adapter/PRD.md

## What to build

Prepare the internal Database adapter boundary for service-backed adapters by
allowing runtime database operations to be awaited without changing Capsule
authoring APIs.

The current adapter was extracted from synchronous `node:sqlite` behavior. The
service-backed SQLite-compatible spike recommends libSQL as the first target,
but production libSQL access should use async HTTP/client calls. This issue
should convert the runtime-owned adapter call sites deliberately, keeping
`ctx.db` stable for Capsule handlers.

## Acceptance criteria

- [ ] App table reads and writes can await adapter operations without changing the public `ctx.db` API.
- [ ] Auth storage paths can await adapter operations.
- [ ] File metadata storage paths can await adapter operations.
- [ ] Log index writes/reads can await adapter operations.
- [ ] Schema migration and system metadata paths can await adapter operations.
- [ ] Inspection and health paths can await adapter operations.
- [ ] Mutation transactions still await the full handler and roll back failed writes.
- [ ] Existing SQLite behavior remains covered by tests.

## Blocked by

- .scratch/database-adapter/issues/05-spike-service-backed-sqlite-compatible-adapter.md
