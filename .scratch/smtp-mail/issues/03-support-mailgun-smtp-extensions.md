# 03 — Support Mailgun SMTP extensions

**What to build:** Let a Capsule configured for Mailgun use Mailgun-specific tags, variables, templates, and delivery options through the common `provider` object. Sporades translates the supported values into Mailgun's documented SMTP headers while preserving the generic SMTP transport and common result contract.

**Blocked by:** 01 — Send mail through generic SMTP.

**Status:** done

- [ ] A Mailgun SMTP declaration selects the Mailgun provider codec without changing the common `ctx.mail.send(...)` interface.
- [ ] `provider.tags` emits repeatable Mailgun tag headers with bounded, validated values.
- [ ] `provider.variables` and `provider.recipientVariables` emit valid JSON Mailgun variable headers with deterministic serialization and size enforcement.
- [ ] Supported template name, template version, template variables, tracking, test-mode, delivery-window, and delivery-time values map to their documented Mailgun SMTP headers.
- [ ] Provider data cannot override sender, recipient, subject, body, MIME, authentication, or transport-controlled headers.
- [ ] Unsupported Mailgun provider fields fail with `UNSUPPORTED_MAIL_PROVIDER_FIELD` and name the rejected field.
- [ ] Tests capture the emitted MIME message and prove exact headers, including repeated tags and JSON-valued variables.
- [ ] Tests prove malformed JSON-compatible values, control characters, oversized values, and protected-header attempts fail before SMTP delivery.
- [ ] Mailgun configuration and example usage are documented without embedding credentials or recommending a Mailgun SDK.
