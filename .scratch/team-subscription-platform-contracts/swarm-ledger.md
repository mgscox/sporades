# Team subscription platform contracts swarm ledger

Coordinator base: `494a086`

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | done | None | `494a086` | `codex/team-contracts-01` / `/private/tmp/sporades-team-contracts-01` | `/root/ticket_01_exact_counts_takeover` | `5b3b409` | `/root/rereview_ticket_01_exact_counts` | ACCEPT | `6893db7`, `80d6cd7` | integration: 20 pass, 0 fail, 1 PostgreSQL skip on Node 22; typecheck/generated-bin passed | pending |
| 02 | done | 01 | `80d6cd7` | `codex/team-contracts-02` / `/private/tmp/sporades-team-contracts-02` | `/root/ticket_02_privileged_inspections` | `319bd4a` | `/root/acceptance_review_ticket_02` | ACCEPT | `16d784a`..`dea4ebc` | integration: focused 67/67; typecheck/build/docs/generated-bin passed | pending |
| 03 | done | None | `494a086` | `codex/team-contracts-03` / `/private/tmp/sporades-team-contracts-03` | `/root/ticket_03_unique_declarations` | `28e0d12` | `/root/definitive_review_ticket_03` | ACCEPT | `f638b36`..`20baabb` | integration: 59 pass, 0 fail, 1 PostgreSQL skip; typecheck/build/docs/generated-bin passed | pending |
| 04 | done | 03 | `20baabb` | `codex/team-contracts-04` / `/private/tmp/sporades-team-contracts-04` | `/root/ticket_04_postgres_takeover` | `74b118d` | `/root/review_ticket_04_74b` | ACCEPT | `bd2aeaa`..`8542eb9` | integration: Node24 libSQL/reactive pass; Node22 SQLite/libSQL/PostgreSQL 125/125; typecheck/build/docs/generated-bin passed | pending |
| 05 | done | 03 | `19e7b63` | `codex/team-contracts-05` / `/private/tmp/sporades-team-contracts-05` | `/root/ticket_05_atomic_unique_migration` | `417a8182` | `/root/acceptance_review_ticket_05` | ACCEPT | `2cf8381`..`4605ec5` | integration: SQLite/libSQL/PostgreSQL 99/99; typecheck/build/docs/generated-bin passed | pending |
| 06 | ready | 02, 04, 05 | `4605ec5` | pending | pending | pending | pending | pending | pending | pending | pending |

## Baseline

- `main` at `494a086`, with published `v0.8.5` ancestry reachable through merged PR #14.
- Ticket graph validated with the issue-swarm validator; initial frontier is Tickets 01 and 03.
- Public TDD seams confirmed by the approved tickets: current-user and Privileged Teams interfaces; Capsule table declaration and writable table interfaces; Capsule startup/schema migration through shared adapter conformance; packed public server contract.
- Worker and reviewer model: `gpt-5.6-terra`, reasoning effort `medium`, explicitly selected by the user.
- `npm run typecheck` passed on the coordinator base.
- Focused baseline ran 67 tests: 66 passed; `test/database-adapter-engine-seam.test.js` hit the pre-existing Node 24 native `InternalCallbackScope::Close` assertion after its first two cases. Team, ACL, public-contract, and strict TypeScript cases passed. Treat the same native assertion separately from source regressions and require affected focused cases to run where the environment permits.
