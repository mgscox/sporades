# Email provider webhooks

## Goal

Let Capsules optionally observe verified outbound-email lifecycle events without
coupling app code to any provider's HTTP route, authentication, or raw payload
shape.

## Requirements

- Each provider adapter owns its callback route, verification, raw parsing, and
  normalization into `VerifiedEmailEvent`.
- All adapters feed one consolidated runtime dispatcher and one optional Capsule
  authoring seam: `emailEvents: emailEvent(handler)`.
- The normalized event includes the exact raw per-event provider JSON. Sporades
  does not persist normalized events or raw payloads by default.
- Enabling a provider route does not require a Capsule subscription. Verified
  callbacks without one are acknowledged and discarded.
- Subscription handlers run as explicit userless system work under the
  Privileged server role. Apps use durable Jobs for retryable processing and
  provider event identity for idempotency.
- Provider callbacks and delivery APIs are mocked from provider documentation in
  automated tests; tests make no live provider calls.
- Provider callback registration and reconciliation are operator concerns and
  remain separate from callback dispatch.

## Delivery sequence

The numbered issues under `issues/` are tracer bullets. Mailjet proves the
dispatcher and public contract first; SMTP2GO then proves the same dispatcher
against a provider with first-class Authorization-header configuration, and
Postmark proves deterministic identities across six distinct event families.
Later
tickets add registration, status derivation, further provider adapters, and
operational documentation without introducing provider-specific Capsule
interfaces.
