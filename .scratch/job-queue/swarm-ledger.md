# Job Queue Swarm Ledger

Base: `0e78191709f3562fbf5b8517ebe22362e11859a8`

| Issue | State | Blockers | Base SHA | Worker SHA | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01-run-and-inspect-current-user-jobs | done | None | 0e78191709f3562fbf5b8517ebe22362e11859a8 | e9c3c185ded6319728c097f4504652da46511fc1 | ACCEPT | d1664d0 | Integration: build + focused job/type tests green; docs test baseline failure recorded | worktree retained until swarm completion |
| 02-add-privileged-jobs-and-actor-provenance | done | 01 | a1ab9047b8c570a60584e9256638885bdb3026cc | eb3146a0a160d588b81a50321889adf907ad35f4 | ACCEPT | 1ffebf8 | Integration: build + captured/privileged/current-user/type tests green | worktree retained until swarm completion |
| 03-add-delays-retries-and-cancellation | done | 02 | 34a02ae984b0170a0100b6e5a03012a40655d935 | 1d322d68623eb60fd472b9e52fbff995c8bd6405 | ACCEPT | 44459dc | Integration: full delay/retry/cancel + privileged/current-user/type suites green | worktree retained until swarm completion |
| 04-recover-jobs-with-at-least-once-delivery | done | 03 | 0995023 | f9728983b2c47a3db2e8d7c41d499bcfe0e91b8e | ACCEPT | 3d58b91 | Integration: full queue + lease/recovery/type suites green; Container/Hosted seam limitation recorded | worktree retained until swarm completion |
| 05-list-and-inspect-jobs-across-runtime-sessions | ready | 04 | 3d58b91 | — | — | — | ready after issue 04 integration | pending |
| 06-document-job-queue-and-update-roadmap | blocked | 05 | — | — | — | — | — | — |

## Baseline

- Dependencies: `node_modules` present; Node `v24.16.0`.
- Graph validation: passed against the recorded base.
- Broad-suite result: `npm test` green (one expected Postgres integration skip because `SPORADES_POSTGRES_TEST_URL` is unset).
- Later integration note: `node --test test/docs.test.js` fails on the planning-base assertion that expects `Job queue | design`; `docs/ROADMAP.md` in base `0e78191` says `ready`.
