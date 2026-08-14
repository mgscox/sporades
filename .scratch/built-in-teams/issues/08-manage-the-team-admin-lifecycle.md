# 08 — Manage the Team-admin lifecycle

**What to build:** Let Team admins promote members, safely demote admins, remove members, and delete an unused Team while ordinary members may leave, with every path preserving at least one admin for every surviving Team under concurrent changes.

**Blocked by:** 07 — Join a Team through a validated link.

**Status:** ready-for-agent

- [ ] A current Team admin can promote an ordinary member to `admin` through the browser and trusted server Team interfaces.
- [ ] Multiple Team admins are supported and visible through safe admin-scoped membership listing.
- [ ] A current admin can demote an admin to `member` only when another committed admin remains.
- [ ] The last surviving admin cannot be demoted, removed, or allowed to leave while the Team survives.
- [ ] Admin authorization and remaining-admin invariants are checked inside the same Transaction boundary as each mutation.
- [ ] Concurrent demotion or removal attempts cannot leave a surviving Team with zero admins.
- [ ] A current Team admin can remove another member when the last-admin rule permits it.
- [ ] Member removal cannot target the caller; self-removal uses the explicit leave operation.
- [ ] A non-admin member can leave a Team through the browser and trusted server interfaces.
- [ ] An admin's leave attempt is rejected until another admin exists and the caller has been demoted.
- [ ] Removal and leave revoke membership authority immediately and atomically remove every active and inactive application-role assignment for that membership.
- [ ] A sole-member admin can explicitly delete that Team; a Team with any other member cannot be deleted.
- [ ] Team deletion atomically removes the Team and outstanding Join-grant state without deleting the Sporades user or rewriting Capsule app-domain data.
- [ ] Initial-Team bootstrap history prevents Team deletion from silently causing another initial Team to be recreated.
- [ ] Ordinary members and non-members cannot promote, demote, remove, or delete through stale or forged client state.
- [ ] Every operation returns stable structured results or opaque denials and emits bounded redacted security events.
- [ ] Tests cover the full promotion/demotion/remove/leave/delete lifecycle, rollback, stale clients, cross-Team authorization, deterministic concurrency races at the Transaction seam, one public-seam concurrency regression, public types, and generated-runtime parity.
