# 01 — Expose exact accepted Team membership counts

**What to build:** Let any current linked Team member read the exact accepted membership total for an explicitly identified Team without receiving a membership directory or weakening existing Team-management authorization.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] A current ordinary member and a current admin can each retrieve the exact accepted membership count for their exact Team.
- [ ] Counts above 100 remain exact while the Team-summary presentation count remains bounded by its existing cap.
- [ ] Pending Join links do not affect the accepted membership count.
- [ ] Authorization and counting observe the same durable Team state without deriving the answer from pages or presentation summaries.
- [ ] Unknown-Team and non-member calls fail with the same opaque client-safe denial and disclose no Team or member details.
- [ ] The count reflects committed Join, leave, removal, and Team-deletion outcomes immediately.
- [ ] Current-user membership enumeration remains admin-only, and the new count result contains no identities, roles, emails, or other presentation fields.
- [ ] Public server declarations, emitted runtime behavior, canonical Team documentation, and focused contract tests agree on the new interface.
