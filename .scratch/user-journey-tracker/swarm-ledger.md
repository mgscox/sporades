# User Journey Tracker Swarm Ledger

Base branch: `main`

Baseline at `5bd74f6`: `npm test` passed 596, failed 0, skipped 8.

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 05 | done | 04 done | `e08e845` | `codex/user-journey-05-final` / `/tmp/sporades-user-journey-swarm/issue-05-final` | `/root/journey_05_final` | `b32481a` | `/root/journey_fix_02` | ACCEPT | `d19a080` | reviewer 45/45; integration 45/45, build, typecheck, generated parity | accepted worktree pending removal; obsolete evidence branches retained |
| 06 | rework | 05 merged and integration-green | `f1a084d` | `codex/user-journey-06` / `/tmp/sporades-user-journey-swarm/issue-06` | `/root/journey_issue_06` | `deb560d` | `/root/journey_fix_02` | REQUEST_CHANGES: framework list and Shadow DOM guidance incomplete | pending | implementation/API/roadmap accepted; narrow docs rework | pending |

## Preserved abandoned attempt

- Branch/worktree: `codex/user-journey-05` / `/Users/mattcox/.codex/worktrees/sporades-user-journey-05`
- Base: `6763e62`
- Worker commit: `e35cdc9`
- State: abandoned because no live worker remains, the branch predates integrated
  contract fixes `ef80a9c` and `852bfa8`, and the worktree contains an
  uncommitted change to `test/user-journey-expiry.test.js`.
- Preservation: leave the branch and dirty worktree untouched as evidence for
  the replacement worker; do not review or integrate this stale SHA.
