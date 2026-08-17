# 01 — Introduce transaction-bound trusted app-database reads

**What to build:** Give Sporades-owned trusted policy callbacks one reusable internal way to read app-owned state without ordinary actor ACL filtering, while keeping that authority read-only, bound to an existing transaction, attributable to a runtime-selected purpose, and unusable after the callback settles.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] A runtime-owned trusted-read module accepts an existing transaction, a runtime-selected purpose, subject metadata, and cancellation state, then invokes one callback with the familiar app-table query surface.
- [ ] Trusted reads bypass app-table row ACLs through an unforgeable runtime-owned capability rather than a caller-set property, actor identity, role name, or browser-supplied intent.
- [ ] The callback can inspect app-owned tables only; runtime-owned auth, Team, Job, log-index, schema-metadata, and storage implementation tables remain unavailable.
- [ ] The trusted database surface exposes query composition and reads but no insert, insert-or-ignore, update, delete, transaction, schema, adapter, or raw-SQL operation.
- [ ] Reads use the caller's existing transaction and observe app-table writes made earlier in that transaction without opening a nested transaction or a separate snapshot.
- [ ] Capability authority is revoked in `finally` after synchronous success, asynchronous success, denial, thrown failure, or cancellation, and retained table/query handles fail closed after revocation.
- [ ] Purpose attribution is selected by Sporades from a closed runtime-owned vocabulary; Capsule code and browser callers cannot invent, widen, or reuse a trusted-read purpose.
- [ ] The module does not become a public `bypassACL` operation and does not expose the Privileged server role, mutation authority, or a new browser/client credential.
- [ ] Focused conformance proves ACL bypass, read-only shape, same-transaction visibility, opaque failure, cancellation, and post-settlement revocation on SQLite, libSQL, and PostgreSQL where configured.
- [ ] An architectural decision records the qualification rule for future consumers: Sporades owns the transition, trusted Capsule policy must decide it from app state, the decision and transition must be atomic, browser callers cannot choose the policy, and read-only access is sufficient.
- [ ] Existing normal ACL enforcement and audited Privileged server-role database access retain their current behavior and lifecycle guarantees.
