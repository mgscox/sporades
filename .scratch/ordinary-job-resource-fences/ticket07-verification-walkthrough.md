# Ticket 07 amended Grant workflow verification walkthrough

Date: 2026-09-20. Source commit before this document: `f0d905e5bb6615a26d9b10764feecd445df017e0`. At verification start, `HEAD` and `origin/main` were exactly this commit; the direct current-main run therefore classifies all ten full-suite failures as baseline.

This is a redacted local verification record for issue #52 under the approved M1 amendment. It records only observed evidence. It does not change the parent issue, claim a deployment, or certify a complete application-specific reference Capsule.

## Boundary and approval

The maintainer approval record is present and marks M1 approved. The governing boundary is:

- resource authority covers the engine transaction, protected database work, receipt, and durable notification-intent acceptance;
- later SMTP submission and receiver acceptance are outside that authority;
- a committed intent may still send after Grant rotation or revocation;
- uncertainty is retried automatically, so duplicate receiver acceptance is possible;
- SMTP acknowledgement is not inbox delivery; exactly-once and unconditional eventual delivery are not promised.

The approval evidence is [maintainer-approval.md](maintainer-approval.md). The normative contract is [ADR-0054](../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Intent acceptance is not evidence of authority through SMTP completion.

## Eight ticket-07 criteria

| # | Status | Observed evidence | Remaining limit |
| --- | --- | --- | --- |
| 1 | **Verified for approval and mapping; original strict guarantees remain unmet** | The approval record explicitly accepts M1, automatic uncertainty retry, duplicate risk, and post-revocation send risk. The original guarantee map below retains the dropped guarantees as amended or unmet. | No evidence turns intent acceptance into SMTP acceptance or proves strict stale-SMTP prevention. |
| 2 | **Partially verified** | Independent SQLite process tests exercise Grant rotation and revocation before and after acquisition, current Team membership, post-acquisition reads, and one captured linked execution actor (`test/resource-process.test.js:114`, `:127`, `:143`, `:155`, `:175`; `test/resource-transactions.test.js:3666`, `:3709`, `:3800`). Notification preparation is atomic in mutation and Job scopes (`test/notification-intents.test.js:132`). | No observed test drives exchange, rotation, revocation, legacy migration, and notification preparation as five operations against one application reference Capsule and one existing Grant anchor. Exchange and application legacy migration are **unverified**. |
| 3 | **Partially verified** | Revocation before acquisition denies callback work with zero protected writes; rotation before acquisition is re-read. Rotation or revocation after acquisition loses with a deterministic busy outcome until the resource commit, then succeeds (`test/resource-process.test.js:114-172`). A committed intent survives later anchor deletion and enters delivery retry (`test/notification-intents.test.js:796`). | These are composable primitive tests, not one end-to-end Grant-link workflow. Current authorization for later link use, distinct from disclosure in the email, is **unverified** in a reference Capsule. Later SMTP remains outside M1. |
| 4 | **Partially verified** | Real independent SQLite workers cover kill/restart, stopped-owner expiry, resumed-owner rejection, cancellation ordering, graceful shutdown, late-handle rejection, and lost-commit receipt reconciliation (`test/resource-process.test.js:78-262`). Resource tests cover scope success followed by handler failure/retry, current-actor receipt access, deadline/claim rejection, and unknown commit reconciliation (`test/resource-transactions.test.js:3229`, `:3631-3734`). Real PostgreSQL process tests pass 2/2 for process death and paused-owner recovery. | The evidence is spread across generic resource fixtures rather than a complete Grant reference Capsule. The isolated real-PostgreSQL resource suite has a merged startup/readiness race described under blockers. |
| 5 | **Verified at the SQLite process and controlled-receiver boundaries** | Notification tests pass 36/36. They cover atomic intent staging, rollback, acknowledgement loss, the not-accepted twin, crash before send, crash after acceptance, durable backoff/restart, permanent rejection, per-recipient isolation, and monotonic late acknowledgement (`test/notification-intents.test.js:132-376`, `:689-765`). The controlled receiver observes one accepted/lost-reply message before retry, then three accepted messages after retry: a duplicate for the accepted twin and one acceptance for the initially unaccepted twin (`:689-707`). | This proves controlled SMTP receiver acceptance only. It does not prove inbox delivery, exactly-once behavior, unconditional eventual delivery, or stale-SMTP fencing. |
| 6 | **Partially verified** | SQLite 3.53.3 focused run: 173 total, 125 passed, 0 failed, 48 PostgreSQL-only skips. Local and remote libSQL entry surfaces fail closed before callback, storage, intent, network, timer, mutex, autocommit, or lease work (`test/resource-transactions.test.js:3834`). PostgreSQL 17.11 process recovery passes 2/2 and PostgreSQL schema/publication plus durable delivery passes 3/3. | The isolated PostgreSQL resource transaction file does not complete green because of a current-main notification-startup/readiness race. PostgreSQL support is therefore not fully re-certified by this run. The libSQL result certifies rejection, not libSQL resource support. |
| 7 | **Unmet as an all-green gate** | Fresh local dependencies, build, typecheck, generated bundle parity, docs/API generation, and the documentation site pass. Documentation tests pass 48/48. The full suite completes with 2,614 total, 2,406 passed, 10 failed, 198 skipped, 0 cancelled, and 0 todo. | The ten current-main failures and the isolated PostgreSQL readiness defect are listed below. No test was weakened, deleted, or skipped to manufacture a pass. |
| 8 | **Verified by this document** | This walkthrough records the approved amendment, command results, engine versions, per-criterion evidence, receiver observations, original-guarantee map, and remaining limits without sensitive connection material. | The parent issue remains unchanged. Publication of this walkthrough does not close the original strict SMTP gaps. |

## Original issue #52 guarantee map

| Original acceptance criterion | Classification under M1 | Observed result |
| --- | --- | --- |
| Hold exclusive authority from before the first write until after an external side effect completes. | **Amended; original guarantee unmet.** M1 holds engine authority through atomic database work and durable intent acceptance only. | Atomic protected writes, receipt, and intent are observed. Later SMTP is outside authority, and post-revocation submission is explicitly observed as possible. |
| Recover after process death without deadlock and prevent stale writes or sends after authority loss, including resumed-owner cases. | **Amended; strict stale-send part unmet.** Engine recovery must reject stale database writes and stale intent acceptance; it cannot revoke already accepted intent or in-flight SMTP. | SQLite and PostgreSQL process tests prove engine-lock recovery and stale database rejection. The controlled delivery contract accepts possible stale or duplicate SMTP acceptance. |
| Two competing Jobs produce a deterministic winner and clean loser with no partial interleaved state. | **Unchanged.** | Independent SQLite workers pass deterministic commit and rollback competition; notification acceptance deduplicates identical intent and rolls back conflicting intent. PostgreSQL process lock exclusion passes, but the full PostgreSQL resource file is not green. |
| Work identically on SQLite and PostgreSQL, or document differences and fail closed. | **Unchanged.** | SQLite focused evidence is green; PostgreSQL process and publication slices are green; libSQL is explicitly unsupported and fails closed. Complete PostgreSQL re-certification is blocked by the current-main readiness race. |
| Document retry, cancellation, expiry, and lease recovery while authority is held. | **Unchanged.** | Focused resource/process evidence covers each lifecycle. The full suite still has a current-main Job cancellation regression, so the repository-wide gate is not green. |
| Capsules that do not opt in behave as before and the full existing suite is green. | **Unchanged and unmet in this checkout.** | The focused non-opt-in resource regression passes, but the full suite has ten current-main failures. |

## Verification environment and commands

The worktree had no dependency directory before installation. `npm ci` created a real local directory with 270 packages. No dependency directory was symlinked.

Engine and tool versions:

- Node.js 24.19.0
- npm 11.17.0
- SQLite 3.53.3
- PostgreSQL 17.11
- Docker client and server 29.7.2

Commands and results:

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 270 packages installed in the worktree. |
| `npm run build` | Passed. |
| `npm run typecheck` | Passed. |
| `npm run test:docs` after writing this walkthrough | 48 total; 48 passed; 0 failed; 0 skipped; 0 cancelled; 0 todo. |
| `npm run docs:check` after writing this walkthrough | Passed; its documentation-test rerun was again 48/48, API generation passed, and the documentation site built. |
| `node ./scripts/check-generated-bin.mjs` after writing this walkthrough | Passed with no generated-bundle drift. |
| `env -u SPORADES_POSTGRES_TEST_URL node --test --test-concurrency=1 test/resource-transactions.test.js test/resource-process.test.js test/notification-intents.test.js` | 173 total; 125 passed; 0 failed; 48 PostgreSQL-only skips; 0 cancelled; 0 todo. This is the SQLite, controlled-receiver, and libSQL fail-closed evidence. |
| Approved PostgreSQL wrapper running `test/resource-postgres-process.test.js` | 2 total; 2 passed; no failures or skips. |
| Approved PostgreSQL wrapper running `test/resource-postgres-publication.test.js` | 3 total; 3 passed; no failures or skips. |
| Approved PostgreSQL wrapper running `test/resource-transactions.test.js` in isolation | Did not complete green: 178 total at interruption; 154 passed; 23 failed; 1 cancelled; no skips. The first failure group starts at `test/resource-transactions.test.js:1816`, and the failed test leaves an open handle, so the stuck runner was stopped. |
| `env -u SPORADES_POSTGRES_TEST_URL npm test` | Completed in about 15 minutes: 2,614 total; 2,406 passed; 10 failed; 198 skipped; 0 cancelled; 0 todo. |

PostgreSQL commands were invoked only through the approved credential-injecting wrapper. This record contains no connection value.

## Evidence boundary

- **Source checks:** build, typecheck, generated bundle parity, documentation tests, API generation, and documentation site build.
- **Process and database evidence:** independent SQLite child processes; real PostgreSQL child processes and connections; actual engine locks, process death, pause/resume, rollback, restart, receipts, and durable intent tables.
- **Controlled receiver observation:** a loopback SMTP receiver actually accepted one message whose reply was lost, accepted its duplicate on retry, and later accepted the initially unaccepted twin. This is receiver acceptance, not inbox delivery.
- **Not observed:** a complete application reference Capsule covering all five Grant operations; production deployment; external provider delivery; link-use authorization after revocation; strict stale-SMTP prevention.

## Current-main failures and minimal follow-up proposals

The worktree was identical to `origin/main` before this document, so these failures are current-main baseline failures, not documentation changes from ticket 07. They remain open; ticket 07 does not implement product repairs.

1. `test/database-adapter-conformance-coverage.test.js:67` reports four adapter methods without a conformance case. Minimal RED/GREEN: retain the existing failing coverage assertion, then add engine-neutral conformance surface cases that call and assert both sides of `findAuthUserFileAuthority`, `lockAuthUserFileAuthority`, `lockFileById`, and `withResourceTransaction`.
2. `test/dev.test.js:2139` and `test/dev.test.js:2263` are **environment/tooling compatibility failures**, not observed product-runtime defects: npm 11 rejects project-scoped `--allow-scripts`. Minimal RED/GREEN: pin an npm-11 packed-install regression, then express allowed lifecycle scripts in the generated fixture package or fixture configuration rather than the rejected command-line option.
3. `test/host.test.js:6211` and the two subtests at `test/host.test.js:11126` receive generic archive extraction/inspection diagnostics instead of the expected metadata/bounds diagnoses. Minimal RED/GREEN: retain fixtures for nested metadata and metadata-only count/byte overflow, then normalize the archive inspector's platform-specific tool failures to the existing bounded public categories before extraction.
4. `test/job-retry-cancel.test.js:47` observes `cancelled` where a handler that already succeeded is expected to remain `succeeded`. Minimal RED/GREEN: preserve this race as RED, then order settlement so a completed successful handler wins before a later cancellation marker while cancellation still wins before completion.
5. `test/runtime-database-lifecycle.test.js:108` rejects the observed teardown aggregate ordering/content. Minimal RED/GREEN: retain the three-failure lifecycle fixture, then preserve lifecycle, scanner, and mail failures in the documented teardown order without dropping or rewrapping their identities.
6. `test/team-billing-erasure.test.js:152` finds that retained local erasure admission does not reject after transaction settlement. Minimal RED/GREEN: retain the escaped-handle assertion, then revoke local erasure admission at mutation settlement and check lifetime before every retained use.
7. `test/resource-transactions.test.js:1816` is a **source/test integration defect** with real PostgreSQL. Runtime startup launches the delivery worker without awaiting it at `src/server-runtime-source.ts:2207`; the worker calls `ensureNotificationIntentStorage` at `src/notification-intent-runtime.ts:344-346`; PostgreSQL storage bootstrap invokes shared resource bootstrap at `src/notification-intent-runtime.ts:52-57`. That asynchronous bootstrap can create resource tables while the readiness test is preparing intentionally malformed tables. Later cases cascade and retain an open handle. Smallest RED-before/GREEN-after proposal: add one focused test beside `test/resource-transactions.test.js:1816` that initializes PostgreSQL notification delivery, pauses its bootstrap, installs one malformed resource table, releases bootstrap, and currently observes competing DDL plus an unclean close; then serialize the startup worker's storage verification with the same resource-bootstrap readiness operation so the green test receives one fixed redacted storage error, never enters protected work, and closes with no retained process or connection.

The full-suite host archive group includes a parent aggregate failure in addition to its two named subtests, which accounts for the reported total of ten failures. Apart from the two npm 11 packed-install failures classified as environmental/tooling compatibility, the remaining failures are current-main source or test-contract defects.

## Conclusion

M1 has strong focused evidence for its actual boundary: atomic database work plus durable notification intent, recovery without a permanent application claim, automatic retry of uncertainty, possible duplicates, and explicit post-revocation delivery risk. The complete application-specific Grant walkthrough requested by ticket 07 is not present in the observed suite, the full repository suite is not green, and the full PostgreSQL resource gate is blocked by a merged readiness race. Therefore issue #52 must not be represented as satisfying its original authority-through-SMTP or strict stale-send guarantees.
