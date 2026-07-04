Status: ready-for-agent

# Apply Write ACL Transactions

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Wrap app-table insert, update, and delete operations so declared ACL rules accept or reject writes using previous and next row state inside the mutation transaction where possible.

## Acceptance criteria

- [ ] Insert ACLs receive `previous = null` and `next` as the inserted row candidate.
- [ ] Update ACLs receive both previous and next row state.
- [ ] Delete ACLs receive previous row state and `next = null`.
- [ ] Denied writes are rolled back and do not persist partial changes.
- [ ] Hooks or fan-out that imply successful mutation do not run for denied writes.
- [ ] Tables without matching write ACLs preserve existing open behavior.
- [ ] Tests cover insert, update, delete, rollback, fallback `write`, operation-specific override, and async rules.

## Blocked by

- .scratch/database-and-storage-acl-rules/issues/01-declare-app-table-acl-rules.md

