# 03 — Coordinate mutations and endpoints with the amended resource boundary

**What to build:** Join existing mutation/Custom endpoint transactions to the same resource and receipt protocol, ordering Grant exchange, rotation, revocation, migration and notification preparation.

**Blocked by:** 02.

**Status:** done — merged as `669c74cd` in [PR #63](https://github.com/mgscox/sporades/pull/63); integration gate passed.

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [x] Enforce first-application-operation entry, one existing anchor, and no nested/multiple resource acquisition. Reuse the outer transaction; hold its lock until outer commit/rollback even after scope callback returns. Treat returned data as provisional before outer commit.
- [x] Use the identical Capsule/table/ID identity across Jobs, mutations, endpoints and permitted existing Privileged execution. Re-read current authority after acquisition and preserve current ACL/Team checks; naming a resource must never grant access.
- [x] Implement the ADR lock order and conflicting locks for runtime authorization rows; prove both revoke-before-acquire denial and acquire-before-revoke serialization, including Team membership and ACL changes. No pre-acquisition cache may authorize the protected operation.
- [x] Prove Job-versus-Grant rotation/revocation in both ordered schedules on independent connections, without partial interleaved DB state. Document that all application writers requiring this guarantee must join the same resource protocol.
- [x] Test outer rollback removes receipt and staged intent, post-commit enqueue visibility, opaque authorization errors, parent-context reentry rejection and escaped handle invalidation. Before 06 use runtime-owned intent persistence fixtures, never substitute these for the final end-to-end check.
- [x] Apply the non-Job 30,000ms outer-transaction budget and 1,000ms reserve. Preserve provisional result semantics and status receipt lookup; reject application operations after the single scope closes.
- [x] Update context types, generated contracts and canonical docs with focused tests; no new browser capability, nested Privileged authority or SMTP fence claim.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Ticket 02 handoff

02 currently rejects mutation/endpoint resource entry. Reuse its canonical identity, complete captured actor binding, receipt schema and error shapes; implement outer transaction joining here without opening a second resource transaction.

## Completion evidence

The reviewed candidate `205df5da` joined current main `9590f031` and merged as `669c74cd`. Independent exact-SHA review accepted the complete ticket diff, and the GitHub automated reviewer gave a fresh thumbs-up for that candidate. The merge tree equals the accepted candidate.

Post-merge resource/process tests passed 85/85, with typechecking and generated-artifact checks passing. Candidate validation also passed 174 File tests, 7 provider-auth tests, and 46 documentation tests; authentication/reconnect integration passed 164 tests with two PostgreSQL tests skipped because this slice did not configure the PG test URL. Those skips do not establish PostgreSQL support. Runtime-owned staged-intent rollback fixtures remain distinct from ticket 06 delivery acceptance.

Regression evidence covers caught/unawaited failures, receipt persistence, deadlines, current authority ordering, commit uncertainty and connection quarantine, ACL/log suppression, and causal child dispatch. The [parity checklist](../ticket03-parity-checklist.md) records the shipped boundary. Ticket 04 onward and parent #52 remain open; notification acceptance is still unsupported.
