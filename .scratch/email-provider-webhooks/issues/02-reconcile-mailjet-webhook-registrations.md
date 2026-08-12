# 02 — Reconcile Mailjet webhook registrations

**What to build:** An operator can explicitly reconcile Mailjet's callback
registrations with an enabled Capsule, creating missing subscriptions, repairing
the configured callback URL, and removing only obsolete registrations owned by
that Capsule. The configured relative route and public origin remain one source
of truth, and credentials are never revealed in output.

**Blocked by:** 01 — Dispatch Mailjet verified email events.

**Status:** ready-for-agent

- [ ] Reconciliation is an explicit operator action and never runs at Capsule
      startup or as an incidental deployment side effect.
- [ ] It manages only the configured event types and only registrations that
      belong to the configured Capsule callback.
- [ ] It safely reads required server-only configuration, redacts all secrets,
      and proves created, repaired, unchanged, and removed registration cases.
