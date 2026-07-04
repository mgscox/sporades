Status: ready-for-agent

# Apply Read ACL Filtering

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Wrap app-table read operations so rows are filtered through declared `read` ACL rules after fetch. The first implementation should prioritize correctness and engine independence over SQL-level policy compilation.

## Acceptance criteria

- [ ] Query read results include only rows accepted by the table's `read` ACL.
- [ ] Tables without matching read ACLs preserve existing open behavior.
- [ ] Read ACL filtering applies consistently to single-row and multi-row table API reads.
- [ ] Denied rows are omitted rather than exposed with denial details.
- [ ] The implementation does not compile ACL rules into database-specific SQL.
- [ ] Tests cover allowed rows, denied rows, mixed result sets, missing rules, and async read rules.

## Blocked by

- .scratch/database-and-storage-acl-rules/issues/01-declare-app-table-acl-rules.md

