# 04 — Insert rows idempotently against declared uniqueness

**What to build:** Let Capsule mutations atomically attempt an insert against an explicitly named declared unique constraint, returning the winning row or `null` for that exact conflict without weakening any other validation or authorization.

**Blocked by:** 03 — Declare unique constraints on Capsule tables

**Status:** done

- [ ] The conflict-field tuple must exactly match one declared unique constraint in its declared order; undeclared, partial, reordered, empty, or malformed targets fail before writing.
- [ ] Value normalization, reference integrity, and insert ACL authorization run through the same authoritative path as an ordinary insert before the atomic write is attempted.
- [ ] A winning call returns its inserted row, while a committed or concurrent winner on the named constraint returns `null`.
- [ ] Conflicts on another unique constraint, reference failures, ACL denial, value errors, and infrastructure failures are never converted to `null`.
- [ ] Existing ordinary insert behavior and return shape remain unchanged.
- [ ] Reactive row caches and mutation refresh behavior are invalidated for a successful insert but not needlessly cleared when no row is written.
- [ ] Two real concurrent PostgreSQL mutation transactions bootstrapping the same singleton both complete, persist exactly one row, and allow the losing transaction to re-read the winner after receiving `null`.
- [ ] Equivalent SQLite and libSQL behavior is proven through the shared cross-engine conformance surface rather than engine-specific behavioral implementations or mocks.
- [ ] Public server declarations, emitted runtime behavior, documentation, and focused security/transaction tests agree on the operation.
