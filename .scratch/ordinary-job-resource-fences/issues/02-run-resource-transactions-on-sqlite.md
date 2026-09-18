# 02 — Run ordinary Jobs inside a resource transaction on SQLite

**What to build:** A Capsule can opt an ordinary Job into a named-resource transaction scope on SQLite, so competing workers serialize protected application changes and an interrupted owner cannot retain database authority. The existing ordinary Job path remains unchanged when the scope is omitted.

**Blocked by:** 01 — Prove the external-side-effect contract.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Implement ticket 01's supported server-only scope, acquiring runtime-owned resource authority before protected application reads or writes without exposing raw SQL or a Database adapter.
- [ ] Scope resource identity to the Capsule database consistently across execution actors; do not accidentally create separate user-specific locks for the same shared resource. Bound and validate resource names and keep sensitive resource values out of diagnostics.
- [ ] Bind ordinary Job ownership to the exact Job ID and claim token. Revalidate ownership on entry and before commit; coordinate recovery with active ownership so expiry alone cannot silently replace a protected owner.
- [ ] Commit all protected database changes together, roll them back on failure, and dispatch transactionally enqueued Jobs only after commit. Acquire SQLite write authority early and document contention with other database writers.
- [ ] Bound acquisition and execution within the supported remaining claim budget. Define cancellation, timeout, orderly shutdown, crash, and retry behavior without promising instant cancellation when the cancellation write itself waits on a transaction.
- [ ] Revoke scoped database and related capabilities on settlement or ownership loss; retained aliases, detached callbacks, parent-context reentry, and Privileged projections cannot escape the boundary or inherit new authority.
- [ ] Preserve captured actor attribution and current ACL checks. Reject unsupported nesting and unsupported adapters before invoking the protected callback. External handoff remains unavailable until ticket 06 implements the proven contract.
- [ ] Prove contention, commit, rollback, process restart, stale-owner rejection, cancellation, and shutdown with independent SQLite workers/connections and controlled barriers. Verify no interleaved partial state and no stranded resource after the documented recovery condition.
- [ ] Ship the behavior with public server types, generated runtime/bundle parity, canonical documentation, and focused regression checks showing unchanged non-opt-in Job behavior.

**Validation prerequisites:** Install dependencies directly in the implementation worktree; tests will not pass with symlinked `node_modules`.
