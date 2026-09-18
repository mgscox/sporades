# 02 — Implement SQLite resource transactions and replay receipts

**What to build:** A server-only resources.run/status API implementing ADR-0054 M1: same-resource database serialization, exact Job ownership, and durable operation receipts. No SMTP handoff guarantee.

**Blocked by:** 01 evidence plus explicit maintainer approval of M1. Neither is replaced by this proposal.

**Status:** blocked — amendment-awaiting-approval

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Proposed, not approved. These criteria supersede this ticket's original scope only if M1 is explicitly approved; they do not weaken the unchanged parent today.

- [ ] Implement the exact ADR API, bounds, existing anchor identity, canonical input digest, actor binding and stable error codes; reject unsupported contexts/adapters/nesting before callback or writes. Enforce one scope as the first application DB/provider operation of the invocation.
- [ ] Use a real dedicated SQLite BEGIN IMMEDIATE transaction with immediate RESOURCE_BUSY. Hold writer authority through commit/rollback; document database-wide writer contention. Do not reset a durable claim on restart or release an engine lock just because a timer expires.
- [ ] Lock/check the exact Job ID and claim token on entry and precommit; use the original lease deadline, 1,000ms drain reserve and no renewal. Prove recovery/cancellation before acquisition rejects entry, and after acquisition waits for engine release. An admitted commit can finish after expiry without admitting a competing owner.
- [ ] Persist operation receipt, input digest, actor binding, JSON result, application writes and enqueued Jobs atomically. Retain receipt/tombstones indefinitely. On same-bound retry return recorded result without callback; mismatched input or actor never replays it. No notification transport is added here; the accept surface is fail-closed until 06.
- [ ] Preserve current anchor/per-operation ACL and Team checks under the captured execution actor, plus existing audited Privileged Job entry. Bind aliases to the transaction; reject parent reentry, late handles, nested privilege, unsupported effects and reconnect-after-loss. Drain admitted ACL/DB/log work before commit.
- [ ] Use independent SQLite workers and explicit barriers to prove deterministic winner/busy loser, rollback, process kill/restart, stopped owner at deadline, cancellation, shutdown and late-handle rejection. Separately prove unknown-commit receipt reconciliation after a lost commit response and failure after successful scope followed by Job retry.
- [ ] Ship public server types, generated artifacts, canonical docs and focused parity/compatibility tests together. Verify non-opt-in Jobs unchanged; no tests weakened or skipped.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.
