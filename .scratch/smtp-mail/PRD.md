# Server-only SMTP mail

## Status

Implemented. Issues 01-05 are complete and independently accepted. Generic
SMTP delivery was also exercised through an authenticated STARTTLS provider.

## Product contract

Capsule server code sends provider-independent mail through
`ctx.mail.send(...)`. `sporades.json` declares an optional `mail.smtp`
transport while credentials remain in Server env. The same configuration and
generated Server Bundle run in Dev sessions, local Container sessions, and
Hosted Capsules.

The runtime supports generic SMTP plus validated Postmark, Mailgun, and
SMTP2GO-compatible header extensions without provider SDKs. Provider data
cannot replace message addressing, MIME content, authentication, or transport
configuration. Transport timeouts are bounded, active sockets close during
shutdown, and structured diagnostics exclude message content and secrets.

Direct SMTP delivery is an external, non-transactional side effect. Important
notifications should run through durable Jobs with application-level
idempotency designed for at-least-once execution.

## Delivery slices

1. [Generic SMTP transport](./issues/01-send-mail-through-generic-smtp.md)
2. [Postmark SMTP extensions](./issues/02-support-postmark-smtp-extensions.md)
3. [Mailgun SMTP extensions](./issues/03-support-mailgun-smtp-extensions.md)
4. [Portable SMTP and SMTP2GO](./issues/04-support-portable-smtp-providers-and-smtp2go.md)
5. [Production runtime and documentation parity](./issues/05-prove-production-runtime-and-documentation-parity.md)

The implementation and review record remains in [the swarm
ledger](./swarm-ledger.md).
