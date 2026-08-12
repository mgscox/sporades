# Mail

Sporades owns server-only SMTP delivery and provider delivery-event callbacks.
Capsules use provider-neutral interfaces; provider-specific transport, callback
verification, and payload shapes stay inside the runtime.

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

TLS modes are explicit:

- `implicit` opens TLS before the SMTP greeting, commonly on port 465.
- `required-starttls` requires the server to advertise STARTTLS and fails
  closed if it does not, commonly on port 587.
- `opportunistic` upgrades when STARTTLS is advertised and otherwise continues
  over plaintext.
- `disabled` uses plaintext for a deliberately trusted relay.

Certificate verification defaults to enabled. Do not set
`rejectUnauthorized: false` in production. When `host` is an IP address, set
`tls.servername` to the DNS name on the SMTP server certificate:

```json
{
  "host": "192.0.2.25",
  "port": 465,
  "tls": {
    "mode": "implicit",
    "servername": "smtp.internal.example"
  }
}
```

Authenticated SMTP is accepted only with `implicit` or `required-starttls`
TLS. Sporades rejects credentials combined with `opportunistic` or `disabled`
delivery so a missing STARTTLS advertisement cannot downgrade authentication
onto plaintext. A trusted relay that intentionally does not require
authentication must opt in exactly with `"auth": { "method": "none" }`.
Unauthenticated or plaintext relays should be restricted by network policy to
the Capsule hosts that need them; never expose an open relay to an untrusted
network.

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

### Durable mail with Jobs

This pattern returns promptly from the mutation and retains one Job identity
for the application notification key:

```ts
import { capsule, job, mutation } from "sporades/server";

export default capsule({
  jobs: {
    sendWelcome: job(async (ctx, payload: { userId: string; email: string }) => {
      // Check and record a stable application delivery key such as
      // `welcome:${payload.userId}` around this operation. Job execution is
      // at least once, so an interrupted attempt may run again.
      return ctx.mail.send({
        to: payload.email,
        subject: "Welcome",
        textBody: "Welcome to the Capsule."
      });
    })
  },
  mutations: {
    queueWelcome: mutation((ctx, user: { id: string; email: string }) =>
      ctx.jobs.enqueue(
        "sendWelcome",
        { userId: user.id, email: user.email },
        { idempotencyKey: `welcome:${user.id}` }
      )
    )
  }
});
```

The Job `idempotencyKey` prevents duplicate Job records for the same handler,
actor, and key; it does not make the SMTP provider exactly once. Keep
application-level idempotency or delivery state that can tolerate a lease
recovery after the provider accepted a message. Also do not send inside a
database Transaction expecting rollback semantics: SMTP is an external side
effect and cannot roll back with Capsule data.

### Portable SMTP and SMTP2GO

Standards-compatible providers use the same generic transport; Sporades does
not require a provider SDK. Set `vendor` to a lowercase identity such as
`generic` or `smtp2go`. SMTP2GO, for example, can use its ordinary SMTP
endpoint and credentials held in Sealed Server env:

```json
{
  "mail": {
    "smtp": {
      "vendor": "smtp2go",
      "host": "mail.smtp2go.com",
      "port": 2525,
      "tls": {
        "mode": "required-starttls",
        "rejectUnauthorized": true
      },
      "auth": {
        "method": "LOGIN",
        "usernameEnv": "SMTP2GO_USERNAME",
        "passwordEnv": "SMTP2GO_PASSWORD"
      },
      "defaultFrom": "Capsule <mail@example.com>"
    }
  }
}
```

### Mailjet SMTP

Mailjet uses its API key pair as SMTP credentials: the public API key is the
SMTP username and the private API key is the SMTP password. Keep both values
in Sealed Server env; do not put either key in `sporades.json`.

```json
{
  "mail": {
    "smtp": {
      "vendor": "mailjet",
      "host": "in-v3.mailjet.com",
      "port": 587,
      "tls": {
        "mode": "required-starttls",
        "rejectUnauthorized": true
      },
      "auth": {
        "method": "PLAIN",
        "usernameEnv": "MJ_APIKEY_PUBLIC",
        "passwordEnv": "MJ_APIKEY_PRIVATE"
      },
      "defaultFrom": "Capsule <mail@example.com>"
    }
  }
}
```

This is Mailjet's standard authenticated SMTP transport. It does not use the
Mailjet REST API or a provider SDK.

Generic providers may receive explicitly selected custom headers through
`provider.headers`:

```ts
await ctx.mail.send({
  to: "recipient@example.com",
  subject: "Welcome",
  textBody: "Welcome to the Capsule.",
  provider: {
    headers: {
      "X-Smtp2go-Campaign": "onboarding",
      "X-Smtp2go-Tag": ["welcome", "trial"]
    }
  }
});
```

Only custom `X-*` names containing ASCII letters, numbers, and hyphens are
accepted. Values are non-empty printable ASCII strings, or complete ordinary
arrays of those strings, without leading or trailing whitespace. Internal and
repeated spaces are emitted without normalization. Names are case-insensitively
unique, each complete header must fit SMTP's 998-character line limit, and one
message may contain at most 50 custom names and 50 repeated values per name.
Unknown provider fields, inherited/accessor/hidden data, control characters,
standard or protected headers, and message-level attempts to change addressing,
MIME content, authentication, or transport configuration fail before Sporades
opens an SMTP connection.

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

Tags, template names, and template versions use printable ASCII and may contain
single internal U+0020 spaces, but leading, trailing, repeated, and Unicode
whitespace is rejected before SMTP delivery so MIME folding cannot silently
change provider identifiers.

Tracking booleans become Mailgun `yes` or `no` values; click tracking also
accepts `htmlonly`. `deliveryTime` uses RFC 2822 format, `deliverWithin` ranges
from `5m` through `24h`, the optimization period ranges from `24h` through
`72h`, and timezone localization uses `HH:mm` or `hh:mmaa`.

## Provider delivery events

SMTP acceptance means the configured provider accepted a message for processing;
it does not prove that the destination mail server accepted it. Provider callbacks
report later lifecycle events such as delivery, opens, clicks, bounces, blocks,
complaints, and unsubscribes.

Sporades verifies each configured provider callback, normalizes it to a
`VerifiedEmailEvent`, and sends it through one provider-neutral dispatcher. A
Capsule may declare one provider-neutral subscription; it never needs a
Mailjet-specific app handler.

### Configure the Mailjet callback route

Enable the runtime-owned Mailjet route in `sporades.json`:

```json
{
  "mail": {
    "webhooks": {
      "mailjet": {
        "path": "/mailjet-webhook",
        "secretEnv": "MAILJET_WEBHOOK_SECRET"
      }
    }
  }
}
```

The path must be a same-origin absolute path without a query or fragment. Store
the referenced secret in Sealed Server env. Mailjet does not sign these
callbacks, so Sporades accepts the secret either as the `token` query parameter
or as the password in HTTP Basic authentication and fails closed when it is
missing.

Omitting `mail.webhooks.mailjet`, or setting its `enabled` field to `false`,
means Sporades exposes no Mailjet route. Enabling it exposes the runtime-owned
route even when the Capsule has no subscription.

Sporades does not yet register or reconcile the callback in the external Mailjet
account. Configure Mailjet to post its events to this route separately; automated
registration is a later operator workflow.

### Subscribe in Capsule server code

```ts
import { capsule, emailEvent } from "sporades/server";

export default capsule({
  name: "delivery-aware-capsule",
  emailEvents: emailEvent(async (ctx, event) => {
    ctx.log.info(
      "email lifecycle event",
      event.provider,
      event.kind,
      event.providerEventId
    );
  })
});
```

The handler receives the Privileged server role because provider callbacks have
no Sporades user identity. This gives durable Jobs a stable actor across provider
retries and makes privileged work explicit and auditable.

The normalized event includes `provider`, `kind`, `providerEventId`,
`occurredAt`, optional `correlationId` and `recipient`, plus the exact raw
per-event provider JSON under `raw`. Mailjet event names normalize as follows:

| Mailjet | `VerifiedEmailEvent.kind` |
| --- | --- |
| `sent` | `delivered` |
| `open` | `opened` |
| `click` | `clicked` |
| `bounce` | `bounced` |
| `blocked` | `blocked` |
| `spam` | `complained` |
| `unsub` | `unsubscribed` |

Sporades does not persist normalized events or raw payloads. With no Capsule
subscription, a verified callback is acknowledged and discarded. Raw payloads
can include recipient addresses, IP addresses, user agents, bounce diagnostics,
and provider-added fields; the Capsule owns any persistence, redaction, retention,
export, and erasure policy.

The subscription runs inline with callback acknowledgement. A successful handler
returns `200`; a handler error returns `500` so the provider can retry. Malformed
event bodies return `400`, bad credentials return `401`, and a missing configured
secret returns `503`. Unknown event types are acknowledged with `200` because
retrying cannot make them understood.

For durable processing, have the subscription enqueue a durable Job and use
`providerEventId` as part of the application's idempotency policy. Job execution
is at least once, and provider callbacks can also be retried, so the Job handler
must tolerate repetition.
