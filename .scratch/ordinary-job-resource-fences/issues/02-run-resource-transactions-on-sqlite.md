# 02 — Implement SQLite resource transactions and replay receipts

**What to build:** A server-only resources.run/status API implementing ADR-0054 M1: same-resource database serialization, exact Job ownership, and durable operation receipts. No SMTP handoff guarantee.

**Blocked by:** None — ticket 01 evidence and explicit M1 approval are recorded.

**Status:** implemented — draft review pending

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [x] Implement the exact ADR API, bounds, existing anchor identity, canonical input digest, actor binding and stable error codes; reject unsupported contexts/adapters/nesting before callback or writes. Enforce one scope as the first application DB/provider operation of the invocation.
- [x] Use a real dedicated SQLite BEGIN IMMEDIATE transaction with immediate RESOURCE_BUSY. Hold writer authority through commit/rollback; document database-wide writer contention. Do not reset a durable claim on restart or release an engine lock just because a timer expires.
- [x] Lock/check the exact Job ID and claim token on entry and precommit; use the original lease deadline, 1,000ms drain reserve and no renewal. Prove recovery/cancellation before acquisition rejects entry, and after acquisition waits for engine release. An admitted commit can finish after expiry without admitting a competing owner.
- [x] Persist operation receipt, input digest, actor binding, JSON result, application writes and enqueued Jobs atomically. Retain receipt/tombstones indefinitely. On same-bound retry return recorded result without callback; mismatched input or actor never replays it. No notification transport is added here; the accept surface is fail-closed until 06.
- [x] Preserve current anchor/per-operation ACL and Team checks under the captured execution actor, plus existing audited Privileged Job entry. Bind aliases to the transaction; reject parent reentry, late handles, nested privilege, unsupported effects and reconnect-after-loss. Drain admitted ACL/DB/log work before commit.
- [x] Use independent SQLite workers and explicit barriers to prove deterministic winner/busy loser, rollback, process kill/restart, stopped owner at deadline, cancellation, shutdown and late-handle rejection. Separately prove unknown-commit receipt reconciliation after a lost commit response and failure after successful scope followed by Job retry.
- [x] Ship public server types, generated artifacts, canonical docs and focused parity/compatibility tests together. Verify non-opt-in Jobs unchanged; no tests weakened or skipped.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Implementation evidence and scope corrections

Implemented on `codex/issue-52-ticket02-sqlite-resources` from `6570a7ba`.
The authoritative ADR now explicitly distinguishes completed-plan API from this
slice: mutation/endpoint entry remains fail closed for 03, intent acceptance for
06; arbitrary imported JavaScript I/O is not sandboxed. Independent SQLite
cancellation/recovery may return busy without committing and require retry after
engine release; no hidden callback replay was introduced. See ADR-0054's ticket-02
corrections and the canonical Jobs reference for exact bounds, errors and storage.

Evidence: `test/resource-transactions.test.js`, `test/resource-process.test.js`,
`test/support/resource-process-worker.js`, the shipped Bundle resource test in
`test/server-bundle-module-graph.test.js`, and strict public API typing in
`test/types.test.js`. Process tests use real independent SQLite runtimes, IPC
barriers, verified OS suspension, process death and controllable original-lease
clocks; they do not substitute same-connection serialization for engine evidence.
PostgreSQL and libSQL resource conformance remains unexercised by this slice.
