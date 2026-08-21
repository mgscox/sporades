# 06 — Carry Credential provenance through durable Jobs

**What to build:** Preserve the admitted user and named Access-key attribution when Capsule work becomes a durable Job, so retries, restarts, and child Jobs remain historically attributable without reanimating removed authority or rechecking a revoked credential mid-work.

**Blocked by:** 03 — Complete immutable owner lifecycle and recovery

**Status:** complete

- [x] Enqueue from ordinary user work persists a bounded canonical snapshot of the complete AuthContext and Credential provenance, never the bearer token, selector, verifier, grants, or matched scopes.
- [x] Current-user Job execution rehydrates the persisted snapshot rather than requiring a current owner profile row; retries, restart recovery, and child Jobs inherit it unchanged.
- [x] Rotation, revocation, key-history deletion, profile changes, unlinking, owner deletion, and later name reuse do not rewrite or cancel already committed Job work.
- [x] Table, File, and Team checks during Job execution still evaluate current resource and membership state, so captured identity does not restore deleted Team membership or widen authority.
- [x] Detailed and operator Job inspection place Credential provenance on the user-mode `enqueuedBy` value while leaving the execution `actor` as the owning user or Privileged server role; bounded summary lists need not expose provenance.
- [x] Legacy Job rows migrate deterministically to Session provenance using retained actor-provider information and a documented compatibility fallback.
- [x] SQLite, service-backed libSQL, and PostgreSQL tests cover migration, enqueue rollback, restart, retry, child propagation, post-revocation execution, owner deletion, inspection, and stable key attribution after name reuse.
- [x] Source runtime, generated Bundle/runtime declarations, operator inspection, log attribution, and generated-source parity all expose the same Job contract.

## Completion evidence

- Implementation and review repairs: `9d1cd62`, `5023593`, `5f984a4`, `f0945a8`, `04d5528`.
- Focused SQLite, service-backed libSQL, gated PostgreSQL, restart/retry/child, current Table/File/Team authority, malformed retained-state, generated-Bundle, inspection, and secret-exclusion proofs passed.
- Independent Standards and Spec reviews were clean at `04d5528`.
- The mandatory release gate at implementation commit `82ac350` required and passed the cross-engine Access-key Job lifecycle and generated-Bundle cases.
