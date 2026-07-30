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
| 02 | done | 01 done | `6b0d35f` | `codex/smtp-mail-02` / removed worktree | `/root/smtp_02` | `72a7779` | `/root/smtp_01_review` | ACCEPT; prior `5756a03` REQUEST_CHANGES void | `3940fd5` | integration 35 pass, 0 fail, 1 Mailjet opt-in skip; build/generated/docs/diff green | worktree removed; branch retained for audit history |
| 03 | done | 01 done | `912a1ac` | `codex/smtp-mail-03` / removed worktree | `/root/smtp_03` | `bbe1402` | `/root/smtp_01_review` | ACCEPT; prior `df0ef2d`, `b913a04`, and `88bf341` REQUEST_CHANGES and void | `378ca69` | integration 18 pass, 0 fail, 1 Mailjet opt-in skip; typecheck/build/generated/docs/diff green | worktree removed; branch retained for audit history |
| 04 | ready | 01 done | — | — | — | — | — | — | — | — | — |
| 05 | blocked | 02, 03, 04 | — | — | — | — | — | — | — | — | — |
