# Ordinary Job resource fences

Parent: https://github.com/mgscox/sporades/issues/52

Application motivation: https://github.com/mgscox/saas-tickets/issues/63

This is the approved seven-ticket implementation plan for a supported, opt-in named-resource transaction boundary shared by ordinary Jobs, mutations, and Custom endpoints. The boundary preserves the execution actor and current resource authorization. Existing Capsules that omit it retain their current behavior.

The plan favors a runtime-owned transaction scope over exposing compare-and-set and requiring every Capsule to invent a recovery protocol. This is a proposed direction, subject to ticket 01's external-side-effect proof gate. Database authority and external acceptance are distinct: a database lock, an AbortSignal, or a check immediately before SMTP submission does not alone prevent a paused owner from submitting after its database authority is lost. Neither ordinary SMTP nor a database transaction provides rollback of an already accepted message.

## Tickets and frontier

| Ticket | Delivers | Blocked by |
| --- | --- | --- |
| [01](issues/01-prove-external-side-effect-contract.md) | Proven external-side-effect and recovery contract | None |
| [02](issues/02-run-resource-transactions-on-sqlite.md) | Ordinary Job resource transactions on SQLite | 01 |
| [03](issues/03-coordinate-jobs-mutations-and-endpoints.md) | Shared authority across Jobs, mutations, and Custom endpoints | 02 |
| [04](issues/04-support-resource-transactions-on-postgresql.md) | Real PostgreSQL conformance | 02 |
| [05](issues/05-enforce-libsql-compatibility.md) | Proven libSQL support or rejection before execution | 02 |
| [06](issues/06-support-proven-external-handoff.md) | External handoff implementing the proven contract | 02 |
| [07](issues/07-verify-grant-coordination-workflow.md) | Complete Grant coordination and compatibility evidence | 03, 04, 05, 06 |

Work only the frontier: `ready-for-agent` does not override an unresolved blocking edge. Ticket 01 is the initial frontier; tickets 03-06 can proceed independently after 02. Each ticket is a complete, verifiable slice including its relevant public types, generated artifacts, documentation, and tests. No separate horizontal documentation or test phase substitutes for that responsibility.

Ticket 01 clears the gate only when there is a concrete implementable contract satisfying the parent, or an explicitly approved amendment with its scope recorded. An impossibility result is useful evidence but does not automatically unblock implementation or authorize weaker acceptance criteria. Do not modify or close the parent issue as part of publishing or executing this plan. A database-only capability or an unsupported-SMTP error does not establish completion of issue #52.

## Approved test environment

Matt explicitly approved starting a local Docker PostgreSQL instance for this work. A local disposable PostgreSQL container must be spun up before PostgreSQL acceptance testing; running the tests with PostgreSQL skipped is not evidence of conformance. Use the repository's dedicated local test database configuration and test harness. That harness currently expects host `127.0.0.1`, port `55432`, and database `sporades_w17`, supplied through `SPORADES_POSTGRES_TEST_URL`. Recheck those harness constraints before setup, use test-only credentials, and keep resets confined to the dedicated test database. Reuse a suitable task-owned container or start one; do not replace an unrelated service occupying the port. Routine setup and teardown of this task's disposable local test container are included in the approval.

Tests will not pass with symlinked `node_modules`. Install dependencies directly in the implementation worktree with `npm ci`; do not symlink or borrow another checkout's `node_modules`. Verify that the worktree's `node_modules` directory is a real directory before running checks. This requirement concerns the dependency directory, not the separately known symlink in the user's workspace path.

This planning PR does not need to start the container or install dependencies. Those prerequisites apply when implementation and runtime validation begin.

## Completion evidence

For each implementation slice, record focused tests that demonstrate the behavior and the relevant generated-contract checks. The final workflow ticket additionally requires typechecking, the full existing test suite, documentation checks, real PostgreSQL execution, and an explicit result for libSQL support or fail-closed behavior. Distinguish source/test evidence from real process, database, and SMTP receiver observations. Claims of adapter support must identify the actual engine and failure modes exercised.

Use independently running workers/connections and explicit synchronization barriers for concurrency proofs. The existing single worker and same-connection serialization are not cross-process locking evidence. The chosen test schedule should make the winner and loser deterministic; the API need not promise FIFO fairness.

Current planning evidence found a 30-second ordinary Job claim lease without renewal. Recheck this during implementation. Acquisition and execution must fit the remaining supported ownership budget unless an explicit, proven renewal protocol is added. Timers and cooperative cancellation alone must not release authority while stale work can still perform protected effects.
