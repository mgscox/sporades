# Team subscription platform contracts swarm ledger

Coordinator base: `494a086`

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | ready | None | `494a086` | pending | pending | pending | pending | pending | pending | pending | pending |
| 02 | blocked | 01 | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 03 | ready | None | `494a086` | pending | pending | pending | pending | pending | pending | pending | pending |
| 04 | blocked | 03 | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 05 | blocked | 03 | pending | pending | pending | pending | pending | pending | pending | pending | pending |
| 06 | blocked | 02, 04, 05 | pending | pending | pending | pending | pending | pending | pending | pending | pending |

## Baseline

- `main` at `494a086`, with published `v0.8.5` ancestry reachable through merged PR #14.
- Ticket graph validated with the issue-swarm validator; initial frontier is Tickets 01 and 03.
- Public TDD seams confirmed by the approved tickets: current-user and Privileged Teams interfaces; Capsule table declaration and writable table interfaces; Capsule startup/schema migration through shared adapter conformance; packed public server contract.
- Worker and reviewer model: `gpt-5.6-terra`, reasoning effort `medium`, explicitly selected by the user.
- `npm run typecheck` passed on the coordinator base.
- Focused baseline ran 67 tests: 66 passed; `test/database-adapter-engine-seam.test.js` hit the pre-existing Node 24 native `InternalCallbackScope::Close` assertion after its first two cases. Team, ACL, public-contract, and strict TypeScript cases passed. Treat the same native assertion separately from source regressions and require affected focused cases to run where the environment permits.
