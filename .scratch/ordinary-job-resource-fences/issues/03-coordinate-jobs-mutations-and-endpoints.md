# 03 — Coordinate mutations and endpoints with the amended resource boundary

**What to build:** Join existing mutation/Custom endpoint transactions to the same resource and receipt protocol, ordering Grant exchange, rotation, revocation, migration and notification preparation.

**Blocked by:** M1 approval and 02.

**Status:** blocked — amendment-awaiting-approval

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Proposed, not approved. These criteria supersede this ticket's original scope only if M1 is explicitly approved; they do not weaken the unchanged parent today.

- [ ] Enforce first-application-operation entry, one existing anchor, and no nested/multiple resource acquisition. Reuse the outer transaction; hold its lock until outer commit/rollback even after scope callback returns. Treat returned data as provisional before outer commit.
- [ ] Use the identical Capsule/table/ID identity across Jobs, mutations, endpoints and permitted existing Privileged execution. Re-read current authority after acquisition and preserve current ACL/Team checks; naming a resource must never grant access.
- [ ] Implement the ADR lock order and conflicting locks for runtime authorization rows; prove both revoke-before-acquire denial and acquire-before-revoke serialization, including Team membership and ACL changes. No pre-acquisition cache may authorize the protected operation.
- [ ] Prove Job-versus-Grant rotation/revocation in both ordered schedules on independent connections, without partial interleaved DB state. Document that all application writers requiring this guarantee must join the same resource protocol.
- [ ] Test outer rollback removes receipt and staged intent, post-commit enqueue visibility, opaque authorization errors, parent-context reentry rejection and escaped handle invalidation. Before 06 use runtime-owned intent persistence fixtures, never substitute these for the final end-to-end check.
- [ ] Apply the non-Job 30,000ms outer-transaction budget and 1,000ms reserve. Preserve provisional result semantics and status receipt lookup; reject application operations after the single scope closes.
- [ ] Update context types, generated contracts and canonical docs with focused tests; no new browser capability, nested Privileged authority or SMTP fence claim.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.
