# 07 — Deliver verified Stripe events to Capsule policy

**What to build:** Deliver each admitted Stripe Event from its durable Privileged Job through one stable Capsule authoring seam, with bounded retry, audit provenance, duplicate safety, and order-independent processing while leaving all billing and access consequences to Capsule policy.

**Blocked by:** 06 — Admit signed Stripe callbacks into one Privileged Job.

**Status:** ready-for-agent

- [ ] A Capsule can declare one Stripe event handler through a stable server-only authoring seam without defining or shadowing the provider HTTP route.
- [ ] The handler receives a verified Stripe event rather than a Custom endpoint request or unverified body.
- [ ] The event exposes stable provider identity, event type, provider creation time, live/test mode, relevant object identity, and the verified raw provider value without treating raw data as automatically safe to log or persist.
- [ ] Event execution occurs only from the durable Job under the Privileged server role with the existing started, completed or errored, and finished audit lifecycle.
- [ ] The Privileged callback remains userless, cannot invent a current user or Team membership, and loses authority when its audited callback settles or aborts.
- [ ] Handler success completes the existing Job, while transient or thrown failure follows bounded Job retry under the same Job identity.
- [ ] Duplicate provider delivery cannot create an additional Job or additional successful processing after the idempotent event Job has completed.
- [ ] Event consumers are documented and tested as idempotent and order-independent; a later-arriving older event cannot be assumed to describe current provider state.
- [ ] Unknown verified event types can be ignored safely without failing callback admission or forcing a Sporades release.
- [ ] Sporades creates no Capsule billing, subscription, invoice, entitlement, access, Customer, Team, order, export, erasure, or retention record from an event automatically.
- [ ] Sporades does not retain a second raw Stripe event history outside the durable Job payload, and safe Job inspection does not expose that payload by default.
- [ ] Capsule writes performed by the event handler continue to use existing Database adapter, ACL, Privileged audit, and failure semantics rather than a payment-specific persistence path.
- [ ] Tests prove successful delivery, handler retry, terminal failure, cancellation, audit ordering, privilege invalidation, duplicate delivery, out-of-order events, ignored unknown events, and absence of automatic app persistence.
- [ ] Generated blank guidance clearly identifies where Capsule authors implement Team ownership, billing-holder checks, subscription transitions, entitlements, notifications, retention, export, and erasure.
- [ ] Public declarations, provider adapter, consolidated dispatcher, Job behavior, canonical docs, and real bundled-runtime tests expose one consistent verified-event contract.
