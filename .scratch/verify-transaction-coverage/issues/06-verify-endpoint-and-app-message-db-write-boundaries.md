Status: ready-for-agent

# Verify Endpoint And App Message DB Write Boundaries

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Verify and fix intended transaction boundaries for Capsule app-table writes that
run outside normal mutation handlers. Custom endpoints receive `ctx.db`, and
App message handlers receive a mutation-style context that can also write app
tables. These surfaces need explicit workflow-level coverage so multi-write
handler workflows either share one Database adapter transaction or are
classified as intentionally single-statement writes.

## Acceptance criteria

- [ ] Custom endpoint handlers that perform multiple app-table writes have a proven transaction boundary or are explicitly rejected/deferred with a documented reason.
- [ ] App message handlers that perform multiple app-table writes have a proven transaction boundary or are explicitly rejected/deferred with a documented reason.
- [ ] Failed endpoint handler writes roll back together when the endpoint workflow owns a multi-write app-table outcome.
- [ ] Failed App message handler writes roll back together when the message workflow owns a multi-write app-table outcome.
- [ ] Single-statement endpoint and App message writes are classified as intentionally database-atomic when no adjacent write depends on shared atomicity.
- [ ] Tests cover the behavior through runtime-facing endpoint and App message paths rather than only adapter helpers.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md
