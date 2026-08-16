# 02 — Expose the complete Privileged Team inspection surface

**What to build:** Give audited userless server work one consistent Team-inspection surface covering every existing inspection that does not inherently require a current user, while keeping user-scoped and mutating Team operations unavailable.

**Blocked by:** 01 — Expose exact accepted Team membership counts

**Status:** ready-for-agent

- [ ] Privileged callbacks can count accepted members, enumerate the existing safe member projection, list safe active Join-link metadata, and perform the existing safe Join-link inspection.
- [ ] Privileged Team inspections perform no current-user membership or admin check and do not invent or capture a Sporades user identity.
- [ ] Current-user Team listing and email-bound Join-link validation remain unavailable because their meaning requires a current user.
- [ ] Team creation, rename, Join, leave, deletion, role/member administration, and Join-link creation or revocation remain unavailable because they mutate Team state.
- [ ] Exact-Team inspections return a stable `TEAM_NOT_FOUND` failure for deleted or unknown Teams rather than reporting a zero-member Team; safe Join-link inspection retains its existing invalid-capability behavior.
- [ ] Results expose no provider subjects, sessions, credentials, raw internal rows, or recoverable Join-link capabilities.
- [ ] Every inspection is effective only inside an active audited Privileged callback and respects callback invalidation, abort signals, and existing audit lifecycle events.
- [ ] Public declarations, runtime-emitted server behavior, the domain overview, product requirements, Team reference, and focused lifecycle/security tests consistently describe and enforce the complete classification.
