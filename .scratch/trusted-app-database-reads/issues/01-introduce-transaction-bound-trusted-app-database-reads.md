# 01 — Introduce transaction-bound trusted app-database reads

**What to build:** Give Sporades-owned trusted policy callbacks one reusable internal way to read app-owned state without ordinary actor ACL filtering, while keeping that authority read-only, bound to an existing transaction, attributable to a runtime-selected purpose, and unusable after the callback settles.

**Blocked by:** None — can start immediately

**Status:** done

- [x] A runtime-owned trusted-read module accepts an existing transaction, a runtime-selected purpose, subject metadata, and cancellation state, then invokes one callback with the familiar app-table query surface.
- [x] Trusted reads bypass app-table row ACLs through an unforgeable runtime-owned capability rather than a caller-set property, actor identity, role name, or browser-supplied intent.
- [x] The callback can inspect app-owned tables only; runtime-owned auth, Team, Job, log-index, schema-metadata, and storage implementation tables remain unavailable.
- [x] The trusted database surface exposes query composition and reads but no insert, insert-or-ignore, update, delete, transaction, schema, adapter, or raw-SQL operation.
- [x] Reads use the caller's existing transaction and observe app-table writes made earlier in that transaction without opening a nested transaction or a separate snapshot.
- [x] Capability authority is revoked in `finally` after synchronous success, asynchronous success, denial, thrown failure, or cancellation, and retained table/query handles fail closed after revocation.
- [x] Purpose attribution is selected by Sporades from a closed runtime-owned vocabulary; Capsule code and browser callers cannot invent, widen, or reuse a trusted-read purpose.
- [x] The module does not become a public `bypassACL` operation and does not expose the Privileged server role, mutation authority, or a new browser/client credential.
- [x] Focused conformance proves ACL bypass, read-only shape, same-transaction visibility, opaque failure, cancellation, and post-settlement revocation on SQLite, libSQL, and PostgreSQL where configured.
- [x] An architectural decision records the qualification rule for future consumers: Sporades owns the transition, trusted Capsule policy must decide it from app state, the decision and transition must be atomic, browser callers cannot choose the policy, and read-only access is sufficient.
- [x] Existing normal ACL enforcement and audited Privileged server-role database access retain their current behavior and lifecycle guarantees.

## Verification

- Implementation commits: `9d23493` and review-fix commit `da0c453`.
- `node --test test/trusted-read.test.js` on Node 24: 8 passed, PostgreSQL skipped because `SPORADES_POSTGRES_TEST_URL` is not configured.
- `npm run build`, `npm run typecheck`, `npm run docs:build`, and generated-bin parity: passed.
- Focused existing Privileged and transaction-scoped regression tests: 23 passed.
- Independent standards and specification re-reviews of `7f57863...da0c453`: no remaining findings.
- Final Node 22 `npm test`: 1,651 passed, 88 skipped, and 2 failures. A follow-up run of the changed trusted-read suite plus scheduling/clock coverage passed every changed and scheduling test and reproduced the pre-existing `test/runtime-clock.test.js` assertion at line 45; PostgreSQL remained unconfigured. The second full-run failure was not retained in clipped TAP output and did not reproduce in the focused follow-up.
