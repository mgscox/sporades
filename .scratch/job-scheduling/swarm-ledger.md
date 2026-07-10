# Job Scheduling Swarm Ledger

Planning base: `ba5388863493a8b2962f233d5c5980604db73352`
Validated swarm base: `4377ca26858dfbc9c61e9f9660c3e1ed79b6c0d8`

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | done | None | `4b33165249ca7cbc6e09242c291b658288c1254c` | `codex/job-scheduling-01-clock` / removed worktree | `job_scheduling_01` | `3e3376f51e3e2df509a4626612dd1753496cef10` | `job_scheduling_01_review` | ACCEPT | `ef1a6fdfaf033b0f8028f6da84687576da69cb6b` | RED: missing clock export; worker full 534 pass, 7 skips; review/integration focused 13/13 + generated parity | worktree removed; branch retained because cherry-picked ancestry |
| 02 | done | 01 | `96675ceed9186313725ff8fffa10e3ecb66d6e98` | `codex/job-scheduling-02-static` / removed worktree | `job_scheduling_02` | `e9b09ab82355a28d210f29129240fb5cf8c56f04` | `job_scheduling_02_review` | ACCEPT | `f2322415f1527fbbc07956fa67d4dd56ea460e1b` | Review 3 rounds; integration 24/24; full batch 543 pass, 7 skips | worktree removed; branch retained |
| 03 | done | 02 | `391f849be04511ed150836b192635033cb5892ee` | `codex/job-scheduling-03-payload` / removed worktree | `job_scheduling_03` | `d2a103762b45d353b2d9d35e52e7ad34ff8e4e0e` | `job_scheduling_03_review` | ACCEPT | `d1d30c562782dd0a3cf8694e4b6f92fef0241c7b` | Review 2 rounds; integration scheduling/type/generated 21/21 | worktree removed; branch retained |
| 04 | review | 02 | `6581e2b79b818cd611994440d57ad48eb953d8d4` | `codex/job-scheduling-04-timezone` / `/Users/mattcox/.codex/worktrees/job-scheduling-04` | `job_scheduling_04` | `34fb710ffbe71d87e488a212febc3425e49bfc38` | `job_scheduling_04_review` | — | — | Final docs RED stale blanket statement; docs 15/15, diff green | pending |
| 05 | blocked | 03, 04 | — | — | — | — | — | — | — | — | pending |
| 06 | blocked | 05 | — | — | — | — | — | — | — | — | pending |
| 07 | blocked | 06 | — | — | — | — | — | — | — | — | pending |
| 08 | blocked | 07 | — | — | — | — | — | — | — | — | pending |
| 09 | blocked | 08 | — | — | — | — | — | — | — | — | pending |
| 10 | blocked | 09 | — | — | — | — | — | — | — | — | pending |

## Baseline

- Checkout: clean `main`, ahead of `origin/main`; planning and tracker-normalization commits are local.
- Dependencies: `node_modules` present.
- Graph: validated with exact parent and blocker paths; blocker counts `0,1,1,1,2,1,1,1,1,1`.
- Broad suite: `npm test` passed with 533 tests passing and 7 environment-gated tests skipped.
