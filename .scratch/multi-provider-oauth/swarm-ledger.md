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
| 03 | done | None (02 done) | `c3da4ab` | `codex/multi-provider-oauth-03` / removed worktree | `/root/oauth_01` | `ca805f3` | `/root/oauth_01_review` | ACCEPT for `c3da4ab...ca805f3`; prior REQUEST_CHANGES verdicts void for replacement SHA | `3cabaf0` | integration: transaction/config/client/docs/Sealed 152 pass; Dev 5; Container 1; type/build/generated/docs/diff green | clean worktree removed; reviewed branch retained for SHA audit |
| 04 | in progress | None (02, 03 done) | `1dc0371` | `codex/multi-provider-oauth-04` / `/private/tmp/sporades-multi-provider-oauth-swarm/issue-04` | `/root/oauth_04` | pending | — | — | — | baseline inherited from integration-green issue 03 | Microsoft worker dispatched |
| 05 | rework | None (02, 03 done) | `1dc0371` | `codex/multi-provider-oauth-05` / `/private/tmp/sporades-multi-provider-oauth-swarm/issue-05` | `/root/oauth_05` | `a7b008d` | `/root/oauth_01_review` | REQUEST_CHANGES for `1dc0371...a7b008d`: trusted HTTPS origin; strict P-256 key; unambiguous bounded form_post; structured JWT object validation | — | focused gates green but claimed HTTPS tracer invalid | same worker rework required; replacement SHA will void prior verdict |
| 06 | in progress | None (02, 03 done) | `1dc0371` | `codex/multi-provider-oauth-06` / `/private/tmp/sporades-multi-provider-oauth-swarm/issue-06` | `/root/oauth_01` | pending | — | — | — | baseline inherited from integration-green issue 03 | Facebook worker dispatched |
| 07 | blocked | 04, 05, 06 | — | — | — | — | — | — | — | — | — |
| 08 | blocked | 07; real provider registrations and credentials | — | — | — | — | — | — | — | — | — |

## External acceptance boundary

Issue 08 is tracker-labelled `ready-for-human`. Once Issue 07 is merged and
integration-green, Issue 08 becomes `external-blocked` until the maintainer
provides or confirms the real Google, Microsoft, Apple, and Facebook provider
registrations and secret-safe credentials required for Hosted Capsule
acceptance.
