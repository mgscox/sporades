# Multi-Provider OAuth Swarm Ledger

Base branch: `main`

Planning base: `613f597`.

Baseline at `613f597`: `npm test` passed 961, failed 0, skipped 38
outside the sandbox. The first sandboxed attempt produced loopback `EPERM`
failures and a Node v24 callback assertion while unwinding those failures; it
was discarded as non-authoritative environment noise.

| Issue | State | Blockers | Base SHA | Branch / worktree | Worker | Worker SHA | Reviewer | Verdict | Merged SHA | Tests | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | rework | None | `716075b` | `codex/multi-provider-oauth-01` / `/private/tmp/sporades-multi-provider-oauth-swarm/issue-01` | `/root/oauth_01` | `313d6bf` | `/root/oauth_01_review` | REQUEST_CHANGES: Session fixture gate red; legacy email bridge unsafe when unverified or ambiguous; callback drops conflict code | — | focused identity/type/generated checks green; reviewer adapter gate 67 pass, 1 fail, 1 Postgres opt-in skip | worker rework active; prior verdict pinned only to `313d6bf` |
| 02 | blocked | 01 | — | — | — | — | — | — | — | — | — |
| 03 | blocked | 02 | — | — | — | — | — | — | — | — | — |
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
