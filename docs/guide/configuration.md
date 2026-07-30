# Configuration

`sporades.json` owns declared Capsule configuration. Sealed Server env owns
server-only values. `.sporades/` is generated runtime state and must not be hand-edited.

Use the detailed reference for:

- [Capsule configuration and local services](./reference.md#configuration)
- [HTTP security policy](./reference.md#security-policy)
- [Sealed Server env](./reference.md#use-sealed-server-env)
- [current-user preferences](./reference.md#user-preferences)

For exact generated paths, see the [runtime layout](../runtime-layout.md).

## SMTP mail

Capsule server code sends provider-independent messages with
`ctx.mail.send(...)`. The interface is always present; when `mail.smtp` is
omitted, sending fails with `MAIL_DISABLED`.

```json
{
  "mail": {
    "smtp": {
      "vendor": "generic",
      "host": "smtp.example.com",
      "port": 587,
      "tls": {
        "mode": "required-starttls",
        "rejectUnauthorized": true
      },
      "auth": {
        "method": "PLAIN",
        "usernameEnv": "SMTP_USERNAME",
        "passwordEnv": "SMTP_PASSWORD"
      },
      "defaultFrom": "Capsule <mail@example.com>",
      "connectionTimeoutMs": 10000,
      "socketTimeoutMs": 30000
    }
  }
}
```

The JSON configuration contains only Server env key names. Store the referenced
username and password in Sealed Server env; never put credentials or provider
tokens in `sporades.json`.

```ts
await ctx.mail.send({
  to: "recipient@example.com",
  subject: "The report is ready",
  textBody: "Your report is ready.",
  htmlBody: "<p>Your report is ready.</p>",
});
```

Unicode subjects and display names are MIME encoded. Envelope email addresses
must currently be ASCII; internationalized local parts and domains are rejected
before Sporades opens an SMTP connection.

SMTP delivery is an external, non-transactional side effect. A later mutation
rollback cannot recall a message that has already left the SMTP server. For
important notifications, enqueue a durable Job, send from its handler, and use
an application-level idempotency key or delivery record. Job execution and SMTP
delivery are at least once rather than exactly once.
