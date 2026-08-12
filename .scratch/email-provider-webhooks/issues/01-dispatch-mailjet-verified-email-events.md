# 01 — Dispatch Mailjet verified email events

**What to build:** A Capsule can opt into one provider-neutral email-event
subscription. When Mailjet is enabled, Sporades exposes only its configured
provider-facing route, verifies incoming callbacks, maps Mailjet's single and
batched payloads into `VerifiedEmailEvent` values (including the raw per-event
JSON), and sends them through one consolidated runtime dispatcher to that
subscription. Sporades does not persist raw payloads by default.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A disabled Mailjet integration exposes no provider-facing route and invokes
      no Capsule handler.
- [x] A verified Mailjet callback reaches the one provider-neutral Capsule
      subscription through the consolidated dispatcher; invalid callbacks do
      not.
- [x] Single-event and grouped callbacks normalize to the same event contract,
      preserve raw per-event JSON, and have tested acknowledgement and failure
      behaviour.
- [x] No provider-specific Capsule-facing event interface is introduced.
