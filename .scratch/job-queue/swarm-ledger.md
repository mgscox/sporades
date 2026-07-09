# Job Queue Swarm Ledger

Base: `0e78191709f3562fbf5b8517ebe22362e11859a8`

| Issue | State | Blockers | Base SHA | Worker SHA | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01-run-and-inspect-current-user-jobs | done | None | 0e78191709f3562fbf5b8517ebe22362e11859a8 | e9c3c185ded6319728c097f4504652da46511fc1 | ACCEPT | d1664d0 | Integration: build + focused job/type tests green; docs test baseline failure recorded | worktree retained until swarm completion |
| 02-add-privileged-jobs-and-actor-provenance | ready | 01 | d1664d0 | — | — | — | ready after issue 01 integration | pending |
| 03-add-delays-retries-and-cancellation | blocked | 02 | — | — | — | — | — | — |
| 04-recover-jobs-with-at-least-once-delivery | blocked | 03 | — | — | — | — | — | — |
| 05-list-and-inspect-jobs-across-runtime-sessions | blocked | 04 | — | — | — | — | — | — |
| 06-document-job-queue-and-update-roadmap | blocked | 05 | — | — | — | — | — | — |

## Baseline

- Dependencies: `node_modules` present; Node `v24.16.0`.
- Graph validation: passed against the recorded base.
- Broad-suite result: `npm test` green (one expected Postgres integration skip because `SPORADES_POSTGRES_TEST_URL` is unset).
- Later integration note: `node --test test/docs.test.js` fails on the planning-base assertion that expects `Job queue | design`; `docs/ROADMAP.md` in base `0e78191` says `ready`.
