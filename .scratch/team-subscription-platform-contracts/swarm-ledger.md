# Team subscription platform contracts swarm ledger

Coordinator base: `494a086`

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | done | None | `494a086` | `codex/team-contracts-01` / `/private/tmp/sporades-team-contracts-01` | `/root/ticket_01_exact_counts_takeover` | `5b3b409` | `/root/rereview_ticket_01_exact_counts` | ACCEPT | `6893db7`, `80d6cd7` | integration: 20 pass, 0 fail, 1 PostgreSQL skip on Node 22; typecheck/generated-bin passed | pending |
| 02 | done | 01 | `80d6cd7` | `codex/team-contracts-02` / `/private/tmp/sporades-team-contracts-02` | `/root/ticket_02_privileged_inspections` | `319bd4a` | `/root/acceptance_review_ticket_02` | ACCEPT | `16d784a`..`dea4ebc` | integration: focused 67/67; typecheck/build/docs/generated-bin passed | pending |
| 03 | done | None | `494a086` | `codex/team-contracts-03` / `/private/tmp/sporades-team-contracts-03` | `/root/ticket_03_unique_declarations` | `28e0d12` | `/root/definitive_review_ticket_03` | ACCEPT | `f638b36`..`20baabb` | integration: 59 pass, 0 fail, 1 PostgreSQL skip; typecheck/build/docs/generated-bin passed | pending |
| 04 | done | 03 | `20baabb` | `codex/team-contracts-04` / `/private/tmp/sporades-team-contracts-04` | `/root/ticket_04_postgres_takeover` | `74b118d` | `/root/review_ticket_04_74b` | ACCEPT | `bd2aeaa`..`8542eb9` | integration: Node24 libSQL/reactive pass; Node22 SQLite/libSQL/PostgreSQL 125/125; typecheck/build/docs/generated-bin passed | pending |
| 05 | done | 03 | `19e7b63` | `codex/team-contracts-05` / `/private/tmp/sporades-team-contracts-05` | `/root/ticket_05_atomic_unique_migration` | `417a8182` | `/root/acceptance_review_ticket_05` | ACCEPT | `2cf8381`..`4605ec5` | integration: SQLite/libSQL/PostgreSQL 99/99; typecheck/build/docs/generated-bin passed | pending |
| 06 | review | 02, 04, 05 | `6c5e484` | `codex/team-contracts-06` / `/private/tmp/sporades-team-contracts-06` | `/root/ticket_06_combined_proof` | pending | `/root/last_review_ticket_04/ticket04_spec`, `/root/review_ticket_05_atomic_migration` | pending | pending | Node 22.23.2 focused 258/258; full suite exit 0; Node 24 Job lifecycle 7/7; typecheck/build/docs/generated-bin/diff passed; real PG guarded as `sporades_w17`/`sporades`; raw pack inspected at `/private/tmp/sporades-team-contracts-06-pack-984d890/sporades-0.8.5.tgz` (241 files) | pending |

## Baseline

- `main` at `494a086`, with published `v0.8.5` ancestry reachable through merged PR #14.
- Ticket graph validated with the issue-swarm validator; initial frontier is Tickets 01 and 03.
- Public TDD seams confirmed by the approved tickets: current-user and Privileged Teams interfaces; Capsule table declaration and writable table interfaces; Capsule startup/schema migration through shared adapter conformance; packed public server contract.
- Worker and reviewer model: `gpt-5.6-terra`, reasoning effort `medium`, explicitly selected by the user.
- `npm run typecheck` passed on the coordinator base.
- Focused baseline ran 67 tests: 66 passed; `test/database-adapter-engine-seam.test.js` hit the pre-existing Node 24 native `InternalCallbackScope::Close` assertion after its first two cases. Team, ACL, public-contract, and strict TypeScript cases passed. Treat the same native assertion separately from source regressions and require affected focused cases to run where the environment permits.

## Ticket 06 evidence

- Candidate: pending final commit atop the reconciled `6c5e484` history. It captures the PostgreSQL emitted-SQL transaction primitive before a conformance fixture temporarily wraps it, settles/cancels runtime-owned scheduled Job work before adapter closure, awaits that closure in Dev and bundled-runtime lifecycle paths, and corrects the Team Job-failure proof to the transactional contract.
- PostgreSQL guard: before any reset-capable test, a direct connection to `postgres://sporades:sporades@127.0.0.1:55432/sporades_w17` returned `current_database = sporades_w17` and `current_user = sporades`. The guarded harness reset only that database's runtime/app tables.
- Focused Node 22.23.2 proof: 258/258 passed, covering singleton bootstrap and losing-transaction reread, Team/Privileged lifecycle, ACL, unique declarations, reactive `insertOrIgnore`, SQLite/libSQL/PostgreSQL app-table and Team-storage conformance, migration rollback, opaque duplicate diagnostics, identifier quoting, Postgres column names, and scheduled Job shutdown. The new deterministic controllable-clock regression proves a closed runtime cancels scheduled Job work before its adapter closes; Node 24 repeats it 7/7. The Team failure harness now injects through the transaction-scoped adapter and proves a failed Job enqueue rolls back both Team and Job rows with no success audit.
- Full Node 22.23.2 `npm test` exited 0. Typecheck, build, documentation build, generated-bin parity, and `git diff --check` passed.
- Raw `npm pack --json --pack-destination /private/tmp/sporades-team-contracts-06-pack` produced `sporades-0.8.5.tgz` (241 files, 978627 bytes, 4959665 unpacked). Direct extraction confirmed the generated CLI, runtime implementation, public source declarations for `PrivilegedTeamsApi`, `.unique`, and `insertOrIgnore`, plus README/CHANGES documentation. Canonical site documentation is intentionally outside the package's `files` allowlist and was separately built.
- No `npm publish`, push, merge, rebase, database reset outside the guarded target, or downstream change was performed.
