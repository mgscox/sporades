Status: ready-for-agent

# Preserve Transactions And Audit Durability For Privileged DB Work

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Make privileged DB work preserve the intended Transaction boundary. Privileged writes inside a mutation participate in the mutation Transaction where specified, privileged runs outside an existing Transaction do not create a new automatic Transaction, and privileged audit evidence remains durable even when app data rolls back.

## Acceptance criteria

- [ ] Privileged DB writes inside a mutation share the mutation Transaction boundary and roll back with the mutation when the mutation fails.
- [ ] Privileged DB work outside an existing Transaction follows the underlying DB API behavior and does not imply a new automatic Transaction around the whole callback.
- [ ] Privileged audit events survive app data rollback when a privileged run occurs inside a mutation Transaction boundary.
- [ ] Single-operation database atomicity claims match existing Transaction boundary policy and do not imply broader file/storage rollback guarantees.
- [ ] Tests cover the behavior through the server handler seam rather than private helper calls alone.

## Blocked by

- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md
