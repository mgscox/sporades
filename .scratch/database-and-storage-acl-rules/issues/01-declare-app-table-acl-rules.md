Status: ready-for-agent

# Declare App Table ACL Rules

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Add Capsule definition support for app-table ACL rules declared in server code. The declaration shape should support `read`, `write`, `insert`, `update`, and `delete`, with `write` acting as the fallback for write operations.

## Acceptance criteria

- [ ] Table definitions can declare ACL rules in Capsule definition code.
- [ ] ACL rules may be synchronous or asynchronous.
- [ ] `write` applies to insert, update, and delete unless an operation-specific rule is present.
- [ ] Missing ACL rules allow the operation by default.
- [ ] ACL declarations are validated with structured errors for unsupported shapes.
- [ ] Type/runtime docs show examples for owner-based read/write policy.
- [ ] Tests cover declaration, fallback precedence, async rules, invalid declarations, and allow-by-default behavior.

## Blocked by

None - can start immediately

