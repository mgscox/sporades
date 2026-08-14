# 04 — List Team memberships within admin scope

**What to build:** Let users inspect their own Team memberships while restricting full membership enumeration to admins of the exact Team being listed, returning only the safe profile and role information needed to build a management UI.

**Blocked by:** 03 — Create and rename additional Teams.

**Status:** done

- [ ] A linked user can read their own membership for each Team to which they belong.
- [ ] Reading one's own membership reveals no other member records or Join-link state.
- [ ] A current Team admin can list memberships for that exact Team through the browser interface.
- [ ] The trusted server Team interface applies the same current-user admin check and result shape.
- [ ] An ordinary member cannot enumerate the Team's other memberships.
- [ ] An admin of Team A cannot enumerate Team B unless they are also a current admin of Team B.
- [ ] A non-member receives an opaque denial that does not reveal whether a Team ID exists.
- [ ] Membership results contain only stable user ID, display name, optional picture, management role, and active application roles.
- [ ] Membership results omit email addresses, Provider subjects, identity records, Session details, credentials, and inactive application-role assignments.
- [ ] Admin status is checked against committed membership state for every request rather than trusted from browser state.
- [ ] Result counts and page sizes are bounded so a large Team cannot create an unbounded response.
- [ ] Tests use at least two Teams and multiple users to prove own-membership visibility, ordinary-member denial, Team-specific admin scope, safe projection, pagination or bounds, server parity, and generated-runtime parity.
