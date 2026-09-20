# Ordinary Job resource fences — M1 approved

Parent: https://github.com/mgscox/sporades/issues/52

Application motivation: https://github.com/mgscox/saas-tickets/issues/63

The original seven-ticket plan was approved subject to ticket 01's proof gate.
Ticket 01 disproved database-only fencing of ordinary SMTP under recoverable
ownership loss. Its evidence remains in [draft PR #54](https://github.com/mgscox/sporades/pull/54).
The original plan remains in [draft PR #53](https://github.com/mgscox/sporades/pull/53).

**Recommendation: A, runtime-owned resource transactions with durable notification
intent acceptance under approved amendment M1.** Neither A nor CAS solves
the unchanged SMTP requirement. A groups multi-row state and intent acceptance in
one commit; CAS alone would leave recovery to each Capsule. See the
[decision matrix, API and recovery contract](../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md).

**M1 approved by Matt on 2026-09-18**, including automatic resend of uncertain
email attempts with accepted duplicate risk. See the [approval record](maintainer-approval.md)
for the conversation quotation and scope. Ticket 01's amendment gate is cleared;
**tickets 02, 03 and 04 are merged and their integration gates have passed**.
Ticket 05 is complete ([PR #74](https://github.com/mgscox/sporades/pull/74), squash d9f036d5, merged 2026-09-20). Ticket 06 is complete ([PR #75](https://github.com/mgscox/sporades/pull/75), squash 8885992b, merged 2026-09-20). Ticket 07 is complete ([walkthrough](issues/07-verify-grant-coordination-workflow.md); [PR #76](https://github.com/mgscox/sporades/pull/76), squash 14eda541, merged 2026-09-20). Parent #52 is CLOSED.
Ticket 07 completion publishes the M1 evidence and maps the original-requirement gaps; it does not claim that every original guarantee passed.
Original strict SMTP criteria remain disproved; the explicitly accepted amendment
is the implementation contract, not a retroactive proof of those criteria.

M1 trades authority through SMTP completion for atomic database/intent commit.
Later SMTP can occur after resource revocation. Retry uncertain/transient outcomes
with durable capped exponential backoff; a resumed sender or lost reply can cause
duplicates. Permanent rejection stays visible for correction. Jobs retain actor
provenance, not a frozen world view: current Grant checks still occur on acquisition.

## Revised tickets and frontier

The filenames are retained for stable links; the current titles/scopes below
now supersede their old contents under approved M1. Tickets 02–07 are complete.

| Ticket | Approved responsibility | Remaining gate |
| --- | --- | --- |
| [01](issues/01-prove-external-side-effect-contract.md) | Completed negative evidence and approved amended contract | Complete; no experiment rerun |
| [02](issues/02-run-resource-transactions-on-sqlite.md) | SQLite scope, exact Job ownership, receipt replay/recovery | Complete: [PR #61](https://github.com/mgscox/sporades/pull/61) |
| [03](issues/03-coordinate-jobs-mutations-and-endpoints.md) | Shared outer transaction and current authority ordering | Complete: [PR #63](https://github.com/mgscox/sporades/pull/63) |
| [04](issues/04-support-resource-transactions-on-postgresql.md) | Real PG locks, connection loss, receipt conformance | Complete: [PR #65](https://github.com/mgscox/sporades/pull/65) |
| [05](issues/05-enforce-libsql-compatibility.md) | Explicit libSQL unsupported gate, no exploratory support branch | Complete: [PR #74](https://github.com/mgscox/sporades/pull/74) |
| [06](issues/06-support-proven-external-handoff.md) | Durable intent acceptance, automatic retry, accepted duplicates | Complete: [PR #75](https://github.com/mgscox/sporades/pull/75) |
| [07](issues/07-verify-grant-coordination-workflow.md) | Complete amended workflow and original-requirement gap map | Complete: [PR #76](https://github.com/mgscox/sporades/pull/76) |

02–05 can proceed through their dependencies without solving ordinary SMTP
fencing; 06 implements the different intent boundary and automatic delivery retry.
No ticket is removed: 05 and 06 are repurposed. Original strict SMTP implementation,
public CAS API, Job lease renewal and optional libSQL support are unnecessary under
M1. The delivery worker's attempt recovery is separate from source Job renewal.
No test is deleted or weakened. Every slice owns its public types, generated
surfaces, documentation and tests; future checks must identify the boundary proved.

## Approved test environment

Matt explicitly approved starting a local Docker PostgreSQL instance for this work. A local disposable PostgreSQL container must be spun up before PostgreSQL acceptance testing; running the tests with PostgreSQL skipped is not evidence of conformance. Use the repository's dedicated local test database configuration and test harness. That harness currently expects host `127.0.0.1`, port `55432`, and database `sporades_w17`, supplied through `SPORADES_POSTGRES_TEST_URL`. Recheck those harness constraints before setup, use test-only credentials, and keep resets confined to the dedicated test database. Reuse a suitable task-owned container or start one; do not replace an unrelated service occupying the port. Routine setup and teardown of this task's disposable local test container are included in the approval.

Tests will not pass with symlinked `node_modules`. Install dependencies directly in the implementation worktree with `npm ci`; do not symlink or borrow another checkout's `node_modules`. Verify that the worktree's `node_modules` directory is a real directory before running checks. This requirement concerns the dependency directory, not the separately known symlink in the user's workspace path.

This decision PR installs dependencies only for documentation validation. No container or runtime experiment is needed here; the engine prerequisites apply to later implementation conformance.

## Completion evidence

For each implementation slice, record focused tests that demonstrate the behavior and the relevant generated-contract checks. The final workflow ticket additionally requires typechecking, the full existing test suite, documentation checks, real PostgreSQL execution, and an explicit result for libSQL support or fail-closed behavior. Distinguish source/test evidence from real process, database, and SMTP receiver observations. Claims of adapter support must identify the actual engine and failure modes exercised.

Use independently running workers/connections and explicit synchronization barriers for concurrency proofs. The existing single worker and same-connection serialization are not cross-process locking evidence. The chosen test schedule should make the winner and loser deterministic; the API need not promise FIFO fairness.

Current planning evidence found a 30-second ordinary Job claim lease without renewal. Recheck this during implementation. Acquisition and execution must fit the remaining supported ownership budget unless an explicit, proven renewal protocol is added. Timers and cooperative cancellation alone must not release authority while stale work can still perform protected effects.
