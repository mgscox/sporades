# Multi-Provider OAuth Swarm Ledger

Base branch: `main`

Planning base: `613f597`.

Baseline at `613f597`: `npm test` passed 961, failed 0, skipped 38
outside the sandbox. The first sandboxed attempt produced loopback `EPERM`
failures and a Node v24 callback assertion while unwinding those failures; it
was discarded as non-authoritative environment noise.

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | done | None | `716075b` | `codex/multi-provider-oauth-01` / removed worktree | `/root/oauth_01` | `4dff228` | `/root/oauth_01_review` | ACCEPT for `716075b...4dff228`; prior `313d6bf` REQUEST_CHANGES void for replacement SHA | `39e9e7a` | integration: adapter 70 pass, 0 fail, 1 Postgres opt-in skip; Container/Dev callback 3 pass; type/build/generated/docs/diff green | clean worktree removed; reviewed branch retained for SHA audit |
| 02 | done | None (01 done) | `da7602c` | `codex/multi-provider-oauth-02` / removed worktree | `/root/oauth_01` | `d30cbbb` | `/root/oauth_01_review` | ACCEPT for `da7602c...d30cbbb`; prior `3ccb801` REQUEST_CHANGES void for replacement SHA | `6ef5d6a` | integration: OAuth + adapters 75 pass, 0 fail, 1 Postgres opt-in skip; Dev 3 pass; Container 1 pass; type/build/generated/docs/diff green | clean worktree removed; reviewed branch retained for SHA audit |
| 03 | rework | None (02 done) | `c3da4ab` | `codex/multi-provider-oauth-03` / `/private/tmp/sporades-multi-provider-oauth-swarm/issue-03` | `/root/oauth_01` | `eb0de23` | `/root/oauth_01_review` | REQUEST_CHANGES for `c3da4ab...eb0de23`: multiline Apple PEM + atomic config/env; shape-safe credential JSON; no unsafe localhost Apple callback | — | focused gates green; TypeDoc diff confirmed generated parity; `/private/tmp` Vite failure remains unrelated baseline | same worker rework required; replacement SHA will void prior verdict |
| 04 | blocked | 02, 03 | — | — | — | — | — | — | — | — | — |
| 05 | blocked | 02, 03 | — | — | — | — | — | — | — | — | — |
| 06 | blocked | 02, 03 | — | — | — | — | — | — | — | — | — |
| 07 | blocked | 04, 05, 06 | — | — | — | — | — | — | — | — | — |
| 08 | blocked | 07; real provider registrations and credentials | — | — | — | — | — | — | — | — | — |

## External acceptance boundary

Issue 08 is tracker-labelled `ready-for-human`. Once Issue 07 is merged and
integration-green, Issue 08 becomes `external-blocked` until the maintainer
provides or confirms the real Google, Microsoft, Apple, and Facebook provider
registrations and secret-safe credentials required for Hosted Capsule
acceptance.
