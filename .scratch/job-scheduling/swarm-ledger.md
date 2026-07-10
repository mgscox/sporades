# Job Scheduling Swarm Ledger

Planning base: `ba5388863493a8b2962f233d5c5980604db73352`
Validated swarm base: `4377ca26858dfbc9c61e9f9660c3e1ed79b6c0d8`

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | done | None | `4b33165249ca7cbc6e09242c291b658288c1254c` | `codex/job-scheduling-01-clock` / removed worktree | `job_scheduling_01` | `3e3376f51e3e2df509a4626612dd1753496cef10` | `job_scheduling_01_review` | ACCEPT | `ef1a6fdfaf033b0f8028f6da84687576da69cb6b` | RED: missing clock export; worker full 534 pass, 7 skips; review/integration focused 13/13 + generated parity | worktree removed; branch retained because cherry-picked ancestry |
| 02 | done | 01 | `96675ceed9186313725ff8fffa10e3ecb66d6e98` | `codex/job-scheduling-02-static` / removed worktree | `job_scheduling_02` | `e9b09ab82355a28d210f29129240fb5cf8c56f04` | `job_scheduling_02_review` | ACCEPT | `f2322415f1527fbbc07956fa67d4dd56ea460e1b` | Review 3 rounds; integration 24/24; full batch 543 pass, 7 skips | worktree removed; branch retained |
| 03 | done | 02 | `391f849be04511ed150836b192635033cb5892ee` | `codex/job-scheduling-03-payload` / removed worktree | `job_scheduling_03` | `d2a103762b45d353b2d9d35e52e7ad34ff8e4e0e` | `job_scheduling_03_review` | ACCEPT | `d1d30c562782dd0a3cf8694e4b6f92fef0241c7b` | Review 2 rounds; integration scheduling/type/generated 21/21 | worktree removed; branch retained |
| 04 | done | 02 | `6581e2b79b818cd611994440d57ad48eb953d8d4` | `codex/job-scheduling-04-timezone` / removed worktree | `job_scheduling_04` | `34fb710ffbe71d87e488a212febc3425e49bfc38` | `job_scheduling_04_review` | ACCEPT | `35e345777f7dee91f1793ad44ab582bc7906d46d` | Review 3 rounds; integration scheduling/docs 39/39; worker full 558 pass, 7 skips | worktree removed; branch retained |
| 05 | done | 03, 04 | `be8c33fc9dec533056ce3be896463f62a607b58d` | `codex/job-scheduling-05-recovery` / removed worktree | `job_scheduling_05` | `7fe83cb01c59d8b8f9d872bd8244bc55c6b9fd6a` | `job_scheduling_05_review` | ACCEPT | `2f04c382399ac5e87cf9d54aad9f8dad53d22269` | Review 2 rounds; focused review 7 pass/1 PG skip; integration build/type/generated + atomic regression green | worktree removed; branch retained |
| 06 | done | 05 | `37be3d472ce2f98f5066c262bd4a79fc38000655` | `codex/job-scheduling-06-crash-safe` / removed worktree | `job_scheduling_06` | `459da2e11696628fa5673336205b8a367e2d5296` | `job_scheduling_06_review` | ACCEPT | `740a94449a507500aba9d541ed456fc843450e1b` | Review 2 rounds; review focused 8/8; integration build/generated + 3 matched focused green | worktree removed; branch retained |
| 07 | working | 06 | `413b1220d47a5ed7183b9d1218b84edc30840888` | `codex/job-scheduling-07-inspection` / `/Users/mattcox/.codex/worktrees/job-scheduling-07` | `job_scheduling_07` | — | — | — | — | — | pending |
| 08 | blocked | 07 | — | — | — | — | — | — | — | — | pending |
| 09 | blocked | 08 | — | — | — | — | — | — | — | — | pending |
| 10 | blocked | 09 | — | — | — | — | — | — | — | — | pending |

## Baseline

- Checkout: clean `main`, ahead of `origin/main`; planning and tracker-normalization commits are local.
- Dependencies: `node_modules` present.
- Graph: validated with exact parent and blocker paths; blocker counts `0,1,1,1,2,1,1,1,1,1`.
- Broad suite: `npm test` passed with 533 tests passing and 7 environment-gated tests skipped.
