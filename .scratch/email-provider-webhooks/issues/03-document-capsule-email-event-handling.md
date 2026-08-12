# 03 — Document Capsule email-event handling

**What to build:** Capsule authors can configure Mailjet delivery-event
handling, consume the provider-neutral subscription, and make an informed
decision about what event data to retain. Documentation explains that raw event
data is available but is not retained by Sporades, and that durable application
work should be enqueued as a Job.

**Blocked by:** 01 — Dispatch Mailjet verified email events. Ticket 02 remains a
separate operator-reconciliation workflow and does not block manual setup docs.

**Status:** done

- [x] Documentation shows a complete, secure Mailjet setup and the single
      provider-neutral Capsule subscription.
- [x] It states callback retry and acknowledgement semantics, the meaning and
      limits of delivery/open/click events, and raw-payload privacy obligations.
- [x] It makes clear that registration changes require an explicit operator
      action and that the app chooses its own persistence, retention, export,
      and erasure policy.
