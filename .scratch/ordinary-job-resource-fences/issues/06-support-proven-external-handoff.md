# 06 — Support the proven external handoff boundary

**What to build:** A Capsule performs an external handoff while coordinating a named resource using the concrete protocol proven in ticket 01, with explicit ownership, cancellation, retry, and uncertain-acceptance behavior.

**Blocked by:** 02 — Run ordinary Jobs inside a resource transaction on SQLite.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Implement the precise external acceptance boundary and recovery protocol established by ticket 01. If that gate has not produced an implementable contract, keep this ticket blocked rather than inventing weaker semantics.
- [ ] Expose only the runtime-owned scoped capability required by that contract, preserving actor/resource authorization and preventing retained or Privileged aliases from outliving their authority.
- [ ] Reject unsupported destinations or protocols before submission. An ownership check immediately before a send, an AbortSignal, or socket destruction alone does not prove strict stale-send prevention.
- [ ] Using a controlled receiver and independent workers, pause the old owner after its final local check, revoke or lose its authority, permit takeover, and resume it. Prove the agreed result at external acceptance as well as in the database.
- [ ] Test cancellation, execution-budget exhaustion, process death, database connection loss, receiver stalls, acknowledgement loss after acceptance, and commit failure after acceptance. Record outcomes and retry eligibility without treating an unknown outcome as a confirmed failure.
- [ ] Do not roll back, erase, or misreport an already accepted external effect. Preserve documented at-least-once behavior unless the participating destination provides and tests a stronger guarantee.
- [ ] Keep ordinary SMTP outside any strict fencing promise unless the protocol actually proves that promise. An unsupported-SMTP error by itself does not satisfy the parent issue or this ticket's required supported handoff.
- [ ] Ship supported public types, generated runtime behavior, bounded redacted diagnostics, canonical documentation, and focused compatibility tests together.

**Validation prerequisites:** Follow the shared environment instructions for adapter-backed tests, including the already-approved local PostgreSQL Docker instance. Install dependencies directly in the worktree; tests will not pass with symlinked `node_modules`.
