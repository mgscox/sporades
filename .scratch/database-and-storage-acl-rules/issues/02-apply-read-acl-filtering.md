Status: done

# Apply Read ACL Filtering

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Wrap app-table read operations so rows are filtered through declared `read` ACL rules after fetch. The first implementation should prioritize correctness and engine independence over SQL-level policy compilation.

## Acceptance criteria

- [x] Query read results include only rows accepted by the table's `read` ACL.
- [x] Tables without matching read ACLs preserve existing open behavior.
- [x] Read ACL filtering applies consistently to single-row and multi-row table API reads.
- [x] Denied rows are omitted rather than exposed with denial details.
- [x] The implementation does not compile ACL rules into database-specific SQL.
- [x] Tests cover allowed rows, denied rows, mixed result sets, missing rules, and async read rules.

## Blocked by

- .scratch/database-and-storage-acl-rules/issues/01-declare-app-table-acl-rules.md
