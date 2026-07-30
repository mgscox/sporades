# SMTP Mail Swarm Ledger

Base branch: `codex/smtp-mail`

Planning commit: `35e1519`.

Swarm base: `33decb670fb120d86dfbcdea88dd6f2444466dd8`.

Baseline at `33decb6`: `npm test` passed 961, failed 0, skipped 38. The
skips are opt-in Postgres, real Host server, and real Container acceptance
tests whose external configuration is not set.

The repository has concurrent workers advancing `main`. Accepted SMTP work is
integrated only into `codex/smtp-mail`. Before final acceptance, merge the then
current `main` into this branch, resolve deliberately, rerun affected and broad
gates, and obtain re-review if the merge changes accepted SMTP behavior.

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | review | None | `ac20cf1` | `codex/smtp-mail-01` / `/private/tmp/sporades-smtp-mail-swarm/issue-01` | `/root/smtp_01` | `c16b7a4` | `/root/smtp_01_review` | pending; three prior replacement SHAs REQUEST_CHANGES and void | — | third rework RED covered encoded address plus mailbox at 77–78 characters; focused mail/types/build/generated/diff green, 11 pass | worker complete; worktree clean; fourth review active |
| 02 | blocked | 01 | — | — | — | — | — | — | — | — | — |
| 03 | blocked | 01 | — | — | — | — | — | — | — | — | — |
| 04 | blocked | 01 | — | — | — | — | — | — | — | — | — |
| 05 | blocked | 02, 03, 04 | — | — | — | — | — | — | — | — | — |
