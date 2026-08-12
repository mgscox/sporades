# 05 — Decide the shared provider-webhook contract

**What to build:** With Mailjet and Postmark proven through the consolidated
dispatcher, record whether provider configuration and registration can now be
shared safely or must remain adapter-owned. The decision protects Capsule
authors from a premature universal configuration model while documenting the
stable extension seam for future providers.

**Blocked by:** 02 — Reconcile Mailjet webhook registrations; 04 — Adapt Postmark email events.

**Status:** ready-for-agent

- [ ] An ADR compares the two working adapters' configuration, verification,
      payload, retry, and registration differences against their proven common
      behavior.
- [ ] It either defines a minimal common contract backed by both adapters or
      explicitly retains adapter-owned configuration and registration, with the
      rationale and future admission criteria.
