# 03 — Coordinate Jobs with mutations and endpoints

**What to build:** A Capsule's ordinary Job, mutation, and Custom endpoint can coordinate one named resource through the same supported scope, allowing notification preparation and Grant authority changes to obey one transaction ordering.

**Blocked by:** 02 — Run ordinary Jobs inside a resource transaction on SQLite.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Reuse the owning mutation or Custom endpoint transaction rather than opening an independent transaction. Hold resource authority until that outer transaction commits or rolls back, even when the scope callback has already returned.
- [ ] Use the same resource identity and runtime-owned lock across Jobs, mutations, Custom endpoints, and permitted Privileged execution. Lock ownership does not grant access to the underlying resource.
- [ ] Require authority-sensitive state to be read again after acquisition; do not accept pre-acquisition reads as proof of current Grant authority.
- [ ] Define and enforce legal entry/nesting and lock acquisition order, with bounded failure for unsupported compositions rather than reentrant deadlock or independently committed work.
- [ ] Prove both orderings of a Job versus revocation or rotation. If the authority change commits first, the later Job observes it; if the protected Job wins, the competing change cannot interleave with its protected work.
- [ ] Prove outer rollback, post-commit Job dispatch, cancellation requests within an owning transaction, current actor authorization, and revocation of escaped capabilities across all supported contexts.
- [ ] Publish the complete context/type, generated artifact, and documentation changes with focused tests; no new browser capability or authority widening is introduced.

**Validation prerequisites:** Install dependencies directly in the implementation worktree; tests will not pass with symlinked `node_modules`.
