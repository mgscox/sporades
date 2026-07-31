# 02 — Support Postmark SMTP extensions

**What to build:** Let a Capsule configured for Postmark add Postmark-specific delivery information through the common `provider` object while continuing to send over the generic SMTP transport. Sporades translates the supported fields into Postmark SMTP headers and rejects unsupported or unsafe values before delivery.

**Blocked by:** 01 — Send mail through generic SMTP.

**Status:** done

- [x] A Postmark SMTP declaration selects the Postmark provider codec without changing the common `ctx.mail.send(...)` interface.
- [x] `provider.tag` becomes the documented Postmark tag header and observes Postmark's single-tag and size constraints.
- [x] `provider.metadata` becomes validated Postmark metadata headers with deterministic key normalization and collision handling.
- [x] `provider.messageStream` becomes the documented Postmark message-stream header.
- [x] Provider data cannot override sender, recipient, subject, body, MIME, authentication, or transport-controlled headers.
- [x] Unsupported Postmark provider fields fail with `UNSUPPORTED_MAIL_PROVIDER_FIELD` and name the rejected field.
- [x] Tests capture the emitted MIME message and prove the exact Postmark headers for tag, metadata, and message-stream cases.
- [x] Tests prove malformed keys, control characters, oversized values, and protected-header attempts fail before SMTP delivery.
- [x] Postmark configuration and example usage are documented without embedding credentials or recommending a Postmark SDK.
