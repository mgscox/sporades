# 05 — Define and enforce libSQL compatibility

**What to build:** A Capsule using libSQL either receives a proven resource transaction contract or an explicit capability error before any protected work begins. It never unknowingly receives weaker authority under the same API.

**Blocked by:** 02 — Run ordinary Jobs inside a resource transaction on SQLite.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Evaluate the actual libSQL transport and deployment behavior for transaction expiry, idle expiry, connection loss, and resumed owners while external work is pending.
- [ ] If support is demonstrable, run the shared conformance contract against a real representative service and record its relevant limits; a service fake alone is insufficient evidence of remote expiry guarantees.
- [ ] If those guarantees cannot be demonstrated, reject the opt-in scope before invoking its callback or performing application writes or external sends. Return a stable, bounded capability error.
- [ ] Do not silently downgrade to an in-process mutex, an unfenced lease, or ordinary autocommit execution. Never execute the protected callback to discover that support is absent.
- [ ] Document the exact supported or unsupported behavior, relevant deployment constraints, and public failure contract. Ensure declaration types and generated runtime behavior agree.
- [ ] Test the support gate, callback non-execution on rejection, and continued ordinary Job operation for Capsules that omit the new API.

**Validation prerequisites:** Install dependencies directly in the implementation worktree; tests will not pass with symlinked `node_modules`.
