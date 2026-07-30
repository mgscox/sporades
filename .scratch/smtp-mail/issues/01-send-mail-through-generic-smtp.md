# 01 — Send mail through generic SMTP

**What to build:** Let Capsule server code send a plain-text or HTML email through one generically configured SMTP provider using `ctx.mail.send(...)`. Sporades owns configuration, Server env credential resolution, message validation, SMTP transport lifecycle, and stable result and error shapes. Omitting SMTP configuration disables delivery without changing the server context shape.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `sporades.json` accepts an optional `mail.smtp` declaration containing vendor identity, host, port, TLS mode, authentication method and Server env references, default sender, and bounded connection and socket timeouts.
- [ ] SMTP passwords, usernames, and tokens remain in Server env; configuration stores only non-secret values and Server env key names.
- [ ] Omitting `mail.smtp` leaves `ctx.mail.send(...)` present but makes it reject with a stable `MAIL_DISABLED` error and an actionable configuration hint.
- [ ] Invalid SMTP configuration fails deterministically before runtime startup, including invalid ports, contradictory TLS settings, invalid timeout bounds, malformed Server env references, and incomplete authentication declarations.
- [ ] `ctx.mail.send(...)` accepts common `to`, `cc`, `bcc`, `from`, `replyTo`, `subject`, `textBody`, `htmlBody`, and optional `provider` fields, with address values accepted individually or as arrays.
- [ ] A message requires a sender from either the call or configured default, at least one recipient, a subject, and at least one of `textBody` or `htmlBody`.
- [ ] Message validation rejects control-character/header injection, protected-header overrides, unsupported values, and bounded-size violations before opening an SMTP connection.
- [ ] A successful authenticated STARTTLS send returns a stable result containing the SMTP message ID and accepted and rejected recipients.
- [ ] SMTP connection, TLS, authentication, timeout, rejection, and invalid-message failures are normalized into stable mail error codes without leaking credentials or raw transport internals.
- [ ] The mail interface is available to queries, mutations, Custom endpoints, App message handlers, context middleware, mutation hooks, lifecycle hooks, current-user and Privileged Job handlers, and `ctx.privileged.run(...)` callbacks.
- [ ] Mail authority is absent from browser/client exports, table ACL evaluation contexts, and Schedule payload factories.
- [ ] Tests exercise the public interface through a captured SMTP transport rather than requiring a real external provider.
- [ ] Documentation states that direct SMTP delivery is an external non-transactional side effect and recommends a durable Job plus application-level idempotency for important notifications.
