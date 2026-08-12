# 03 — Document Capsule email-event handling

**What to build:** Capsule authors can configure Mailjet delivery-event
handling, consume the provider-neutral subscription, and make an informed
decision about what event data to retain. Documentation explains that raw event
data is available but is not retained by Sporades, and that durable application
work should be enqueued as a Job.

**Blocked by:** 01 — Dispatch Mailjet verified email events; 02 — Reconcile Mailjet webhook registrations.

**Status:** ready-for-agent

- [ ] Documentation shows a complete, secure Mailjet setup and the single
      provider-neutral Capsule subscription.
- [ ] It states callback retry and acknowledgement semantics, the meaning and
      limits of delivery/open/click events, and raw-payload privacy obligations.
- [ ] It makes clear that registration changes require an explicit operator
      action and that the app chooses its own persistence, retention, export,
      and erasure policy.
