# 02 — Support Postmark SMTP extensions

**What to build:** Let a Capsule configured for Postmark add Postmark-specific delivery information through the common `provider` object while continuing to send over the generic SMTP transport. Sporades translates the supported fields into Postmark SMTP headers and rejects unsupported or unsafe values before delivery.

**Blocked by:** 01 — Send mail through generic SMTP.

**Status:** done

- [ ] A Postmark SMTP declaration selects the Postmark provider codec without changing the common `ctx.mail.send(...)` interface.
- [ ] `provider.tag` becomes the documented Postmark tag header and observes Postmark's single-tag and size constraints.
- [ ] `provider.metadata` becomes validated Postmark metadata headers with deterministic key normalization and collision handling.
- [ ] `provider.messageStream` becomes the documented Postmark message-stream header.
- [ ] Provider data cannot override sender, recipient, subject, body, MIME, authentication, or transport-controlled headers.
- [ ] Unsupported Postmark provider fields fail with `UNSUPPORTED_MAIL_PROVIDER_FIELD` and name the rejected field.
- [ ] Tests capture the emitted MIME message and prove the exact Postmark headers for tag, metadata, and message-stream cases.
- [ ] Tests prove malformed keys, control characters, oversized values, and protected-header attempts fail before SMTP delivery.
- [ ] Postmark configuration and example usage are documented without embedding credentials or recommending a Postmark SDK.
