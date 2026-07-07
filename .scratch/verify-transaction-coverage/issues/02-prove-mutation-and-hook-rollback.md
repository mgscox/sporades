Status: done

# Prove Mutation And Hook Rollback

## Parent

.scratch/verify-transaction-coverage/PRD.md

## What to build

Add or tighten regression coverage proving that Capsule mutation execution uses
one adapter-owned transaction for app-table writes, before/after mutation hooks,
ACL write checks, and pending ACL writes. Failed mutation handlers, failed
hooks, denied ACL writes, and failed pending ACL writes should roll back all
database writes that belong to the mutation workflow so the caller can retry the
whole mutation without compensating for partial app-table state.

## Acceptance criteria

- [x] A successful mutation still commits app-table writes and hook-visible results.
- [x] A failing custom mutation rolls back app-table writes made before the failure.
- [x] A failing before or after mutation hook rolls back database writes from the mutation workflow.
- [x] Denied or failed ACL write evaluation rolls back app-table and pending ACL writes.
- [x] A failed mutation can be retried successfully without cleanup of partial app-table state from the first attempt.
- [x] Coverage proves the behavior through the public mutation/runtime path rather than only testing adapter helpers.

## Blocked by

- .scratch/verify-transaction-coverage/issues/01-audit-db-write-transaction-boundaries.md
