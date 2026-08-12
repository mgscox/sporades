# 07 — Adapt Mailgun email events

**What to build:** A Capsule can consume signed Mailgun lifecycle events through
the same consolidated dispatcher and provider-neutral subscription as the
existing providers. Mailgun HMAC verification, event envelopes, regional
registration details, and acknowledgement semantics remain inside its adapter.

**Blocked by:** 01 — Dispatch Mailjet verified email events.

**Status:** done

- [x] The optional Mailgun route verifies the Webhook Signing Key before
      dispatch and accepts parent-account signatures for subaccount events.
- [x] Documented outbound lifecycle envelopes normalize into
      `VerifiedEmailEvent` with exact parsed envelope data under `raw`.
- [x] Provider-specific `200`/`406` acknowledgement semantics and non-Delivery
      retry behavior are documented and tested.
- [x] Mailgun events use the existing dispatcher and one optional Capsule
      subscription without a Mailgun-specific Capsule interface.
- [x] Live test-mode validation confirms provider-authored signed callbacks and
      cleanup after an authorized sandbox recipient is available.
