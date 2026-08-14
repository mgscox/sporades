# 09 — Declare and assign membership application roles

**What to build:** Let Capsule code declare app-specific Team roles such as `author` and `reviewer`, and let Team admins atomically assign or revoke those roles on individual memberships without confusing them with Team administration.

**Blocked by:** 07 — Join a Team through a validated link.

**Status:** ready-for-agent

- [ ] Capsule server definition accepts a bounded declaration of application Team-role identifiers without requiring Teams to be explicitly enabled.
- [ ] Role identifiers use a documented stable lowercase grammar and reject malformed values, duplicates, excessive counts, Sporades-reserved prefixes, `admin`, and `member` at Capsule load.
- [ ] An existing Capsule with no role declaration loads and behaves unchanged with an empty application-role vocabulary.
- [ ] Application-role assignments belong to one Team membership, not directly to a Sporades user or globally to the Capsule.
- [ ] One membership may hold multiple declared application roles, and one user may have different roles in different Teams.
- [ ] A Team admin can atomically update a member's roles using bounded non-overlapping add and remove sets through the browser and trusted server interfaces.
- [ ] Ordinary members, non-members, and admins of another Team cannot change assignments.
- [ ] Assignment rejects unknown Teams, non-members, undeclared roles, malformed sets, or conflicting add/remove values without partial writes.
- [ ] Team admins receive no application roles automatically; Join-link membership starts with no application roles.
- [ ] Team-admin promotion or demotion does not implicitly change application roles.
- [ ] Removing a role from the Capsule declaration makes retained assignments inactive immediately, excludes them from public membership results, and denies any future authority from that role.
- [ ] Reintroducing the same declared role reactivates retained assignments so a deployment rollback is non-destructive.
- [ ] Renaming a role is treated as removal plus addition and does not migrate assignments automatically.
- [ ] Membership removal, leave, and Team deletion remove relevant active and inactive role assignments atomically.
- [ ] Admin-scoped member listing and own-membership results expose only active declared roles.
- [ ] Structured role-change events expose bounded role identifiers and actor/target identity without Session or provider details.
- [ ] Tests cover declaration validation, multi-role and multi-Team assignment, atomic updates, authorization, inactive/reactivated declarations, rollback, lifecycle cleanup, public types, server parity, and generated-runtime parity.
