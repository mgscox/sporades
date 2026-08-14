# 03 — Create and rename additional Teams

**What to build:** Let a linked user create additional named Teams, become each Team's first admin, rename Teams they administer, and list all of their memberships without introducing an implicit current-Team selection.

**Blocked by:** 01 — List the current user's initial singleton Team.

**Status:** ready-for-agent

- [ ] A linked user can create an additional Team through the browser Team interface and receives its committed Team and creator-admin membership.
- [ ] The trusted server Team interface provides the same current-user Team creation behavior from supported handler contexts.
- [ ] Team creation and creator-admin membership are one Transaction boundary and cannot leave an adminless Team.
- [ ] A user may create and belong to multiple Teams up to documented bounded limits.
- [ ] Team names are required, normalized and bounded as presentation metadata, and never used as identity or authorization authority.
- [ ] A current Team admin can rename that Team through the browser and trusted server interfaces.
- [ ] Ordinary members and non-members cannot rename a Team, and public denials do not disclose private Team state.
- [ ] Rename authorization is checked inside the same transaction as the change so stale admin state cannot authorize it.
- [ ] Team listing returns every Team containing the caller without selecting or persisting one as current.
- [ ] Operations always accept an explicit Team ID where scope is required.
- [ ] Creation and rename emit bounded structured security events without exposing Session or provider details.
- [ ] Tests prove multi-Team listing, cross-user isolation, rollback, bounded validation, restart persistence, trusted-server parity, public types, and generated-runtime parity.
