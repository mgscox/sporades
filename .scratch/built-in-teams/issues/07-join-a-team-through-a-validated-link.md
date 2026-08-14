# 07 — Join a Team through a validated link

**What to build:** Let a linked user whose attached email matches a usable Join link become an ordinary Team member in the same transaction that consumes the link, with safe retry and concurrency behavior and no implicit role grants.

**Blocked by:** 04 — List Team memberships within admin scope; 06 — Validate Join links after authentication.

**Status:** done

- [ ] A linked current user can submit the opaque Join code through the browser Team interface and receive the committed membership on success.
- [ ] The trusted server Team interface provides the same current-user joining behavior.
- [ ] Joining repeats code integrity, grant existence, expiry, revocation, consumption, Team existence, linked-user, and normalized-email checks rather than trusting prior validation.
- [ ] Membership insertion and Join-grant consumption occur in one Transaction boundary.
- [ ] A successful Join link creates management role `member` and no application-role assignments.
- [ ] Join links can never grant `admin` or any Capsule-declared application role.
- [ ] Membership uniqueness is enforced by persistent storage under repeated and concurrent joins.
- [ ] A retry by the same already joined user returns an idempotent safe outcome and does not add roles or duplicate membership.
- [ ] Once one user consumes a link, another user cannot use it even when the second user has the same normalized email.
- [ ] Concurrent redemption produces at most one membership outcome associated with the consumed grant.
- [ ] An Anonymous user cannot join directly, and attempting to do so leaves both grant and Team unchanged.
- [ ] Expired, revoked, malformed, tampered, mismatched, deleted-Team, and already-consumed cases have no partial membership or consumption side effects.
- [ ] The recipient may retain their initial Team and join additional Teams; no current-Team selection is changed.
- [ ] Team admins can observe the new safe membership through admin-scoped listing after commit, while ordinary members still cannot enumerate it.
- [ ] Structured outcomes are redacted and do not expose Join secrets or target emails.
- [ ] Tests cover email and OAuth recipients, rollback, restart persistence, retry, two-user and same-email races, multiple-Team membership, no-role grants, public types, server parity, and generated-runtime parity.
