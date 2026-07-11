# User Journey Tracker Swarm Ledger

Base branch: `main`

Baseline at `5bd74f6`: `npm test` passed 596, failed 0, skipped 8.

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 05 | review | 04 done | `af51482` | `codex/user-journey-05-replacement` / `/tmp/sporades-user-journey-swarm/issue-05` | `/root/journey_issue_05` | `4f12ae2` | `/root/journey_fix_02` | pending | pending | RED restart changed session ID; focused 41/41; full 599 pass, 0 fail, 8 skipped; generated parity | pending |
| 06 | blocked | 05 must be merged and integration-green | pending | pending | pending | pending | pending | pending | pending | pending | pending |

## Preserved abandoned attempt

- Branch/worktree: `codex/user-journey-05` / `/Users/mattcox/.codex/worktrees/sporades-user-journey-05`
- Base: `6763e62`
- Worker commit: `e35cdc9`
- State: abandoned because no live worker remains, the branch predates integrated
  contract fixes `ef80a9c` and `852bfa8`, and the worktree contains an
  uncommitted change to `test/user-journey-expiry.test.js`.
- Preservation: leave the branch and dirty worktree untouched as evidence for
  the replacement worker; do not review or integrate this stale SHA.
