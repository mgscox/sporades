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
| 01 | done | None | `ac20cf1` | `codex/smtp-mail-01` / removed worktree | `/root/smtp_01` | `c16b7a4` | `/root/smtp_01_review` | ACCEPT; prior replacement SHAs REQUEST_CHANGES and void | `ab731ed` | integration 95 pass, 0 fail, 2 opt-in skip; live Mailjet STARTTLS 1 pass, 0 skip; build/generated/diff green | worktree removed; branch retained for audit history |
| 02 | rework | 01 done | `6b0d35f` | `codex/smtp-mail-02` / `/private/tmp/sporades-smtp-mail-swarm/issue-02` | `/root/smtp_02` | `5756a03` | `/root/smtp_01_review` | REQUEST_CHANGES: inherited/symbol/accessor/non-enumerable provider fields bypass complete payload accounting | — | reviewer 13 focused pass plus typecheck/generated/diff; header mappings and published limits otherwise aligned | original worktree retained; rework active |
| 03 | ready | 01 done | — | — | — | — | — | — | — | — | — |
| 04 | ready | 01 done | — | — | — | — | — | — | — | — | — |
| 05 | blocked | 02, 03, 04 | — | — | — | — | — | — | — | — | — |
