# Ordinary Job resource fences — decision pending

Parent: https://github.com/mgscox/sporades/issues/52

Application motivation: https://github.com/mgscox/saas-tickets/issues/63

The original seven-ticket plan was approved subject to ticket 01's proof gate.
Ticket 01 disproved database-only fencing of ordinary SMTP under recoverable
ownership loss. Its evidence remains in [draft PR #54](https://github.com/mgscox/sporades/pull/54).
The original plan remains in [draft PR #53](https://github.com/mgscox/sporades/pull/53).

**Recommendation: A, runtime-owned resource transactions with durable notification
intent acceptance, ONLY under proposed amendment M1.** Neither A nor CAS solves
the unchanged SMTP requirement. A groups multi-row state and intent acceptance in
one commit; CAS alone would leave recovery to each Capsule. See the
[decision matrix, API and recovery contract](../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md).

**M1 approval: absent. Nothing in 02–07 is dispatchable now.** This draft is a
proposal, not authorization. Record an explicit maintainer approval URL and date
here and in ADR-0054 before changing the frontier. Original SMTP criteria stay
unmet unless the maintainer explicitly accepts the changed requirement. If M1 is
declined, keep this whole frontier blocked pending a participating-destination or
quiescence design. Do not close or silently rewrite #52.

M1 trades authority through SMTP completion for atomic database/intent commit.
Later SMTP can occur after resource revocation; unknown delivery is retained and
not automatically retried, so an intent can remain unsent. See ADR for the full
trade-off and proposed replacement wording. Grant link-use validation does not
prevent message disclosure.

## Revised tickets and frontier

The filenames are retained for stable links; the current titles/scopes below
supersede their old contents only on M1 approval. All remain blocked today.

| Ticket | Proposed responsibility | Gate after M1 approval |
| --- | --- | --- |
| [01](issues/01-prove-external-side-effect-contract.md) | Completed negative evidence; unchanged-parent proof remains open | Record M1 approval; no experiment rerun |
| [02](issues/02-run-resource-transactions-on-sqlite.md) | SQLite scope, exact Job ownership, receipt replay/recovery | First implementation frontier after 01 evidence + M1 approval |
| [03](issues/03-coordinate-jobs-mutations-and-endpoints.md) | Shared outer transaction and current authority ordering | 02 |
| [04](issues/04-support-resource-transactions-on-postgresql.md) | Real PG locks, connection loss, receipt conformance | 02 |
| [05](issues/05-enforce-libsql-compatibility.md) | Explicit libSQL unsupported gate, no exploratory support branch | 02 |
| [06](issues/06-support-proven-external-handoff.md) | Durable intent acceptance, one SMTP attempt, retained uncertainty | 02; PG integration also waits for 04 |
| [07](issues/07-verify-grant-coordination-workflow.md) | Complete amended workflow and original-requirement gap map | 03, 04, 05, 06 |

After explicit approval, 02–05 can proceed without solving ordinary SMTP fencing;
06 implements the *different* intent boundary and delivery policy. Until approval,
none may be dispatched as a supposedly independent DB-only fix. No ticket is
removed: 05 and 06 are repurposed. The original strict-SMTP implementation, public
CAS API, lease renewal and optional libSQL support are unnecessary under M1.
No test is deleted or weakened; future acceptance checks must show which boundary
they prove. Each slice owns its public types, generated surfaces, docs and tests.

## Approved test environment

Matt explicitly approved starting a local Docker PostgreSQL instance for this work. A local disposable PostgreSQL container must be spun up before PostgreSQL acceptance testing; running the tests with PostgreSQL skipped is not evidence of conformance. Use the repository's dedicated local test database configuration and test harness. That harness currently expects host `127.0.0.1`, port `55432`, and database `sporades_w17`, supplied through `SPORADES_POSTGRES_TEST_URL`. Recheck those harness constraints before setup, use test-only credentials, and keep resets confined to the dedicated test database. Reuse a suitable task-owned container or start one; do not replace an unrelated service occupying the port. Routine setup and teardown of this task's disposable local test container are included in the approval.

Tests will not pass with symlinked `node_modules`. Install dependencies directly in the implementation worktree with `npm ci`; do not symlink or borrow another checkout's `node_modules`. Verify that the worktree's `node_modules` directory is a real directory before running checks. This requirement concerns the dependency directory, not the separately known symlink in the user's workspace path.

This decision PR installs dependencies only for documentation validation. No container or runtime experiment is needed here; the engine prerequisites apply to later implementation conformance.

## Completion evidence

For each implementation slice, record focused tests that demonstrate the behavior and the relevant generated-contract checks. The final workflow ticket additionally requires typechecking, the full existing test suite, documentation checks, real PostgreSQL execution, and an explicit result for libSQL support or fail-closed behavior. Distinguish source/test evidence from real process, database, and SMTP receiver observations. Claims of adapter support must identify the actual engine and failure modes exercised.

Use independently running workers/connections and explicit synchronization barriers for concurrency proofs. The existing single worker and same-connection serialization are not cross-process locking evidence. The chosen test schedule should make the winner and loser deterministic; the API need not promise FIFO fairness.

Current planning evidence found a 30-second ordinary Job claim lease without renewal. Recheck this during implementation. Acquisition and execution must fit the remaining supported ownership budget unless an explicit, proven renewal protocol is added. Timers and cooperative cancellation alone must not release authority while stale work can still perform protected effects.
