Status: done

# Preserve Transactions And Audit Durability For Privileged DB Work

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Make privileged DB work preserve the intended Transaction boundary. Privileged writes inside a mutation participate in the mutation Transaction where specified, privileged runs outside an existing Transaction do not create a new automatic Transaction, and privileged audit evidence remains durable even when app data rolls back.

## Acceptance criteria

- [x] Privileged DB writes inside a mutation share the mutation Transaction boundary and roll back with the mutation when the mutation fails.
- [x] Privileged DB work outside an existing Transaction follows the underlying DB API behavior and does not imply a new automatic Transaction around the whole callback.
- [x] Privileged audit events survive app data rollback when a privileged run occurs inside a mutation Transaction boundary.
- [x] Single-operation database atomicity claims match existing Transaction boundary policy and do not imply broader file/storage rollback guarantees.
- [x] Tests cover the behavior through the server handler seam rather than private helper calls alone.

## Blocked by

- .scratch/privileged-server-role/issues/05-implement-privileged-db-access-through-normal-adapter-boundaries.md

## Verification

- Worker thread: `019f42f0-2481-7cf2-bf35-77c9ff723ed8`
- Review thread: `019f42ff-bb62-7662-b33d-21f4343639a8` accepted after the idempotent rollback-audit fix.
- `npm run build`
- `node --test --test-name-pattern "privileged DB writes in failing mutations|privileged DB work outside existing transactions|privileged audit rollback recovery" test/database-adapter.test.js`
- `node --test --test-name-pattern "leaked privileged table APIs|normal handler contexts cannot forge privileged DB ACL bypass|privileged table API bypasses normal ACL|privileged file" test/database-adapter.test.js`
- `node ./scripts/check-generated-bin.mjs`
