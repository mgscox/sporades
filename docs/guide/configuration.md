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

### Postmark SMTP extensions

Set `mail.smtp.vendor` to `postmark` to translate supported fields from the
common `provider` object into Postmark SMTP headers. Continue to use the generic
SMTP host, port, TLS, and Server env credential configuration; Sporades does
not use or require a Postmark SDK.

```json
{
  "mail": {
    "smtp": {
      "vendor": "postmark",
      "host": "smtp.postmarkapp.com",
      "port": 587,
      "tls": {
        "mode": "required-starttls",
        "rejectUnauthorized": true
      },
      "auth": {
        "method": "PLAIN",
        "usernameEnv": "POSTMARK_SMTP_USERNAME",
        "passwordEnv": "POSTMARK_SMTP_PASSWORD"
      },
      "defaultFrom": "Capsule <mail@example.com>"
    }
  }
}
```

```ts
await ctx.mail.send({
  to: "recipient@example.com",
  subject: "Welcome",
  textBody: "Welcome to the Capsule.",
  provider: {
    tag: "welcome-email",
    metadata: {
      account_id: "account-123"
    },
    messageStream: "transactional-dev"
  }
});
```

Postmark permits one tag of at most 1,000 characters and up to ten metadata
fields. Metadata names are normalized to lowercase, must be at most 20
characters, and must remain unique after case normalization. Metadata values
must be strings of at most 80 characters. Message Stream IDs use Postmark's
lowercase 30-character identifier format. Sporades rejects unsupported fields,
case-colliding metadata keys, control characters, and attempts to pass raw or
protected headers before opening an SMTP connection.

### Mailgun SMTP extensions

Set `mail.smtp.vendor` to `mailgun` to translate supported fields from the
common `provider` object into Mailgun's documented `X-Mailgun-*` SMTP headers.
The transport remains ordinary SMTP; Sporades neither uses nor requires a
Mailgun SDK. Keep the SMTP credentials referenced through Sealed Server env.

```json
{
  "mail": {
    "smtp": {
      "vendor": "mailgun",
      "host": "smtp.mailgun.org",
      "port": 587,
      "tls": {
        "mode": "required-starttls",
        "rejectUnauthorized": true
      },
      "auth": {
        "method": "PLAIN",
        "usernameEnv": "MAILGUN_SMTP_USERNAME",
        "passwordEnv": "MAILGUN_SMTP_PASSWORD"
      },
      "defaultFrom": "Capsule <mail@example.com>"
    }
  }
}
```

```ts
await ctx.mail.send({
  to: "recipient@example.com",
  subject: "Welcome",
  htmlBody: "<p>Welcome to the Capsule.</p>",
  provider: {
    tags: ["welcome", "new-customer"],
    variables: { accountId: "account-123" },
    recipientVariables: {
      "recipient@example.com": { firstName: "Amy" }
    },
    templateName: "welcome-email",
    templateVersion: "v2",
    templateVariables: { firstName: "Amy" },
    tracking: {
      enabled: true,
      clicks: "htmlonly",
      opens: true,
      pixelLocationTop: true
    },
    testMode: false,
    deliveryTime: "Fri, 14 Oct 2011 12:00:00 +0000",
    deliverWithin: "1h30m",
    deliveryTimeOptimizePeriod: "24h",
    timeZoneLocalize: "14:30"
  }
});
```

Mailgun accepts up to three printable ASCII tags of 128 characters each.
`variables` and `templateVariables` are JSON dictionaries;
`recipientVariables` maps up to 1,000 plain recipient addresses to JSON
dictionaries. Sporades sorts object keys before serialization, limits user
variables to 4 KiB and the larger recipient/template variable maps to 32 KiB,
and escapes non-ASCII data in the MIME header value. Provider fields cannot
override message, MIME, authentication, or transport headers. Unsupported
fields and malformed values fail before an SMTP connection is opened.
Each serialized JSON key or value token must fit within a 997-character
continuation line; larger individual tokens are rejected during message
normalization even when the complete object remains below its byte limit.

Tags, template names, and template versions may contain single internal spaces,
but leading, trailing, and repeated whitespace is rejected before SMTP delivery
so MIME folding cannot silently change provider identifiers.

Tracking booleans become Mailgun `yes` or `no` values; click tracking also
accepts `htmlonly`. `deliveryTime` uses RFC 2822 format, `deliverWithin` ranges
from `5m` through `24h`, the optimization period ranges from `24h` through
`72h`, and timezone localization uses `HH:mm` or `hh:mmaa`.
