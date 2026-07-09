Status: done

# Make Database Inspection SQL Genuinely Read-Only

## What to build

Harden `sporades db query` so inspection SQL cannot mutate runtime state through a running Dev session or direct database inspection. Read-only inspection should allow useful table and metadata reads, while rejecting side-effect SQL such as writes, schema changes, attachment, extension loading, and mutating PRAGMAs.

## Acceptance criteria

- [ ] Running Dev inspection queries cannot execute side-effect SQL even when the statement text starts with a superficially read-like keyword.
- [ ] Direct local Container database inspection keeps its existing read-only behavior.
- [ ] Safe read queries and safe metadata inspection continue to work for supported database adapters.
- [ ] Rejected statements return a structured error with an actionable hint.
- [ ] Regression tests cover representative write, schema, attachment, and mutating PRAGMA attempts, plus at least one allowed read query.

## Blocked by

- .scratch/security-hardening/issues/02-protect-dev-inspection-with-session-token.md
