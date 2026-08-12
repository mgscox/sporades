# Mailgun outbound webhook research

Research date: 2026-08-12. Documented facts use current, first-party Mailgun
sources. The dated account observations near the end are first-hand API evidence.
Neither `MAILGUN_API_KEY` nor `MAILGUN_WEBHOOK_KEY` was printed.

## Executive recommendation

Add Mailgun as another provider adapter behind the existing provider-neutral dispatcher. The runtime route should accept one JSON envelope, verify its `signature` with the Mailgun **Webhook Signing Key**, normalize `event-data`, retain the entire parsed envelope as `raw`, and dispatch exactly one `VerifiedEmailEvent`. Do not expose Mailgun API registration inside the application runtime.

Use the event-data `id` as the provider identity input. Mailgun documents it as
unique only within a day, so Sporades scopes `providerEventId` by account,
domain, and UTC event day rather than advertising the bare ID as indefinitely
global. [Event Structure](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-structure)

Recommended mappings:

| Mailgun subscription / event-data | Condition | Sporades kind |
| --- | --- | --- |
| `accepted` | — | `deferred` |
| `delivered` | — | `delivered` |
| `opened` | — | `opened` |
| `clicked` | — | `clicked` |
| `failed` | `severity: temporary` | `deferred` |
| `failed` | `severity: permanent`, `reason: suppress-complaint` | `complained` |
| `failed` | `severity: permanent`, `reason: suppress-unsubscribe` | `unsubscribed` |
| `failed` | `severity: permanent`, `reason: espblock` or policy/blocklist equivalent | `blocked` |
| `failed` | other permanent failure, including `bounce` and `suppress-bounce` | `bounced` |
| `complained` | — | `complained` |
| `unsubscribed` | — | `unsubscribed` |

The direct event mappings are documented facts. The finer permanent-failure classification is a Sporades recommendation based on Mailgun's documented `severity` and `reason` metrics. There is no outbound `resubscribed` Mailgun webhook, so that Sporades kind has no Mailgun mapping. [Webhook event types](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks), [Metric definitions](https://documentation.mailgun.com/docs/mailgun/user-manual/reporting/metric-definitions)

## Regions, scope, and registration

Mailgun's US and EU systems are isolated. API clients must select `https://api.mailgun.net` for US or `https://api.eu.mailgun.net` for EU, and configure webhooks independently in every region containing relevant accounts/domains. HTTPS callback certificates must be signed by a trusted CA, not self-signed. [Configuring Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks)

Mailgun offers two scopes:

- Account-level: `GET/POST /v1/webhooks`, `GET/PUT/DELETE /v1/webhooks/{webhook_id}`. One object can subscribe one URL to repeated `event_types`. Account changes can take up to ten minutes to take effect because of caching.
- Domain-level: `GET/POST /v3/domains/{domain}/webhooks` and `GET/PUT/DELETE /v3/domains/{domain}/webhooks/{webhook_name}`. The v3 representation is one event type at a time. V4 endpoints can create/update/delete a URL across several event types.

Both APIs use HTTP Basic authentication with username `api` and the Mailgun API key as password. Each event type permits at most three unique URLs. The same URL registered for the same event at account and domain scope is deduplicated by Mailgun, although distinct inherited URLs can both fire. [Account Webhooks API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/account-webhooks), [Domain Webhooks API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domain-webhooks/post-v3-domains--domain--webhooks), [Configuring Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks)

### Is temporary registration safe?

Yes, if it is reconciled rather than replacing existing configuration:

1. Read both US and EU account webhooks and the target domain's webhook URLs.
2. Select the region/domain actually owned by the supplied key.
3. Prefer creating a new account-level webhook with a unique description, retaining its returned `webhook_id`; do not call the delete-all endpoint and do not replace a domain event type's URL list.
4. Register only the temporary public URL and required event types.
5. Allow for the documented ten-minute cache delay.
6. Delete only the returned temporary ID, then list again and compare with the pre-test snapshot.

This is a recommendation. Mailgun documents the relevant list/create/delete operations and cache delay, but it cannot guarantee safe operator behavior. Account scope can also include subaccounts, so domain scope may be preferable when validation must be narrowly contained. [Account Webhooks API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/account-webhooks), [Configuring Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks)

## Authentication and replay handling

The callback JSON has this envelope shape:

```json
{
  "signature": {
    "timestamp": "1770920772",
    "token": "a random 50-character value",
    "signature": "hex HMAC",
    "parent-signature": "optional hex HMAC for a subaccount event"
  },
  "event-data": {
    "event": "delivered",
    "id": "provider event id",
    "timestamp": 1770920772.2684145
  }
}
```

Verify the ordinary `signature` by computing:

```text
hex(HMAC-SHA256(webhookSigningKey, signature.timestamp + signature.token))
```

There is no separator. Compare fixed-format hexadecimal values in constant time. A subaccount event may additionally contain `parent-signature`, allowing verification with the primary account key. The signing secret is the account's **Webhook Signing Key**, not `MAILGUN_API_KEY`. Mailgun exposes a read-only `GET /v5/accounts/http_signing_key`; `POST` to that path regenerates the account key and must never be part of validation. [Securing Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks), [Account Management API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/account-management)

Mailgun calls timestamp freshness checks and replay-token caching optional and warns against an overly aggressive time window because callbacks may be delayed. In addition, non-delivery callbacks can be retried for roughly eight hours. Recommended adapter behavior for this first implementation is therefore:

- require structurally valid signature fields and a constant-time-valid HMAC;
- do not impose a short timestamp window that would reject documented retries;
- do not consume a token before downstream dispatch succeeds;
- use the provider event ID for idempotency, acknowledging already-processed duplicates with `200` rather than redispatching them where the application implements persistence;
- leave persistent replay-token storage outside the stateless runtime until its retry interaction has been validated live.

The final three bullets are recommendations. The documentation does not specify whether retry attempts reuse the original token/timestamp, so that remains a live uncertainty. [Securing Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks), [Webhook Retries](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-retries)

## Payload and lifecycle contract

Mailgun sends `application/json`. The top-level request contains `signature` and `event-data`; account- and domain-level webhooks use the same event-data shape. Event examples contain `account.id`, `domain.name`, `event`, `id`, fractional Unix-seconds `timestamp`, `recipient`, `message.headers["message-id"]`, and `user-variables`. Event-specific data includes delivery status, failure `severity`/`reason`, open/click client data, and clicked `url`. Mailgun explicitly says examples are not exhaustive and new additive fields may appear, so validation should require only the fields Sporades consumes and preserve unknown fields in `raw`. [Webhook Payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads)

Supported outbound webhook subscriptions are `accepted`, `delivered`, `temporary_fail`, `permanent_fail`, `opened`, `clicked`, `unsubscribed`, and `complained`. Both failure subscriptions deliver event-data with `event: failed`; `severity` differentiates `temporary` and `permanent`. Open, click, and unsubscribe events require their corresponding tracking configuration; complaints depend on feedback loops. [Introduction to Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks), [Webhook Payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads)

Mailgun documents one event-data object per webhook POST and describes posting each time an event happens. It does not document batch arrays for Send event webhooks. Recommendation: accept only one envelope, reject arrays as malformed, and revisit only if provider-authored evidence contradicts the current contract. Batch **sending** is separate: it creates per-recipient events, plus an additional accepted event for the initial batch request. [Introduction to Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks), [Metric definitions](https://documentation.mailgun.com/docs/mailgun/user-manual/reporting/metric-definitions)

Optional PII redaction can replace recipient and IP fields with placeholders before webhook delivery, while leaving `message-id` intact. The adapter should not reject such placeholders and consumers should treat all `raw` payloads as sensitive. [Webhook Payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads#pii-redaction-for-webhook-payloads)

## Identity and correlation

Mailgun calls event-data `id` unique **within a day**. Use it, rather than the message ID, for event identity because open, click, delivery, and failure events for one message share `message.headers["message-id"]`. A conservative normalized ID is `mailgun:<event-data.id>` combined with provider domain/account scope in any durable dedupe index. [Event Structure](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-structure), [Webhook Payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads)

For Sporades correlation over SMTP, send:

```text
X-Mailgun-Variables: {"correlationId":"non-secret-application-id"}
```

Mailgun merges multiple valid JSON `X-Mailgun-Variables` headers and returns them under event-data `user-variables`. When absent, documented examples sometimes use `[]`; when present it is an object, so the adapter should tolerate both and read `correlationId` case-insensitively. The variables are visible in the delivered email's MIME and therefore must never contain secrets or sensitive data. Values above 4 KB can be truncated in events/webhooks; SMTP headers above 998 characters need folding. [Attaching Metadata](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-attachments), [Send via SMTP](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp)

## Responses, retries, and failure semantics

Mailgun's contract is unusually exact:

- `200`: success, do not retry.
- `406`: deliberately rejected, do not retry.
- any other status: retry non-delivery webhooks at 5 minutes, 10 minutes, 15 minutes, 1 hour, 2 hours, and 4 hours, over roughly eight hours.
- Delivery notification webhooks are excluded from retries.

The adapter should therefore return exactly `200` for accepted or intentionally ignored authenticated events, `406` for malformed/invalid-signature requests that can never succeed unchanged, and a retryable non-200 such as `500`/`503` for downstream or temporary configuration failures. A failed Delivery dispatch cannot be recovered by Mailgun retry, so the application must make handlers fast/reliable and use the provider Logs/Events API for reconciliation. [Webhook Retries](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-retries)

## Test facilities and safe live-validation plan

Mailgun Send has no documented general-purpose “send sample webhook” API. `/v1/alerts/webhooks/test` belongs to the separate Alerts product and is not evidence for Send event webhooks. Mailgun recommends `bin.mailgun.net` for temporary debugging endpoints, but that would disclose payloads to another service and is unnecessary when a controlled Funnel endpoint exists. [Configuring Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks)

The safest provider-authored event seam is Send test mode: HTTP `o:testmode=yes` or SMTP `X-Mailgun-Drop-Message: yes`. Mailgun accepts and processes the message without delivering it, then emits a `delivered` event with SMTP status `650`. Test-mode messages are still charged. [Sending options](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/pass-sending-options), [Test mode](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/test-mode)

Recommended validation sequence, without printing either secret:

1. Start a local capture endpoint through the existing Tailscale Funnel. Record only sanitized request metadata and test assertions; never log the `signature` object, API Authorization header, or full raw payload to terminal output.
2. Source `~/.zshrc` inside a short-lived shell and assert only that `MAILGUN_API_KEY` and `MAILGUN_WEBHOOK_KEY` are non-empty.
3. Read both regional account webhook lists and domain lists, emitting only counts, webhook IDs created by this test, event names, and URL host/path. Never echo credentials or pre-existing query strings.
4. Determine the active region and sending/sandbox domain read-only. Confirm `MAILGUN_WEBHOOK_KEY` against `GET /v5/accounts/http_signing_key` by comparing a hash/equality boolean in memory; never print either value. Do **not** call the POST regeneration endpoint.
5. Create one uniquely described temporary account webhook for all eight event subscriptions, retaining its returned ID. Alternatively use v4 domain URL-oriented registration if account scope would be too broad. Never replace existing URL arrays.
6. Locally prove a valid HMAC and invalid-signature `406` using synthetic payloads whose signature is computed in memory.
7. Send exactly one `o:testmode=yes` message to the user's authorized recipient/domain with a unique non-secret `X-Mailgun-Variables` correlation ID. Validate the provider-authored envelope, HMAC, `delivered` normalization, raw preservation, status `650`, and correlation round trip. This does not prove recipient-server delivery.
8. If the account UI offers provider-authored test callbacks for the other subscriptions, exercise them and label the results distinctly. Otherwise rely on current official fixtures for open/click/failure/complaint/unsubscribe, because manufacturing complaints, unsubscribes, or failures would mutate suppression state or require real recipient actions.
9. For retry proof, use a non-delivery provider test event only if available. Test-mode Delivery cannot prove retry semantics because Mailgun explicitly does not retry Delivery callbacks.
10. Delete only the created webhook ID, relist both regions/scopes, stop Funnel, delete temporary captures, and confirm the pre-test webhook snapshot is restored.

### Live uncertainties and limits

- The API key owns an active US sandbox domain; the account has no EU domain.
- The supplied `MAILGUN_WEBHOOK_KEY` matches the account key returned by the
  US account API.
- Account-level webhooks and test-mode sending are available on this account.
- No provider-authored Send test surface for every event family was used;
  lifecycle coverage beyond accepted and delivered remains based on current
  first-party fixtures.
- Whether callback retries preserve or regenerate signature token/timestamp.
- Test mode generated both `accepted` and `delivered`; the delivered callback
  carried status `650`.

## Live account audit — 2026-08-12

Read-only US and EU API calls established the current validation surface:

- the supplied API key authenticates successfully in both regional account
  APIs;
- the account has one active US sandbox domain and no EU domains;
- both regional account-webhook lists initially contain zero webhooks;
- `GET /v5/accounts/http_signing_key` returned a key that matches the supplied
  `MAILGUN_WEBHOOK_KEY` in memory;
- `GET /v5/sandbox/auth_recipients` returned zero authorized recipients.

No webhook was created and no message was submitted during this initial audit.

## Live provider validation — 2026-08-12

After the user activated one sandbox recipient, a controlled live run provided
first-hand account and callback evidence:

- one uniquely described US account webhook was registered using Mailgun's
  multipart form encoding and reconciled as exactly eight lifecycle event
  subscriptions;
- the run waited the documented ten-minute account-webhook cache window before
  sending;
- exactly one charged `o:testmode=yes` API message was accepted; it was not
  delivered to the recipient;
- Mailgun emitted one signed `accepted` callback, which the Sporades runtime
  verified and normalized to `deferred`;
- Mailgun emitted one signed `delivered` callback, which the same runtime
  verified and normalized to `delivered`; its delivery status was `650`;
- both events retained the parsed Mailgun envelope under `raw`, round-tripped
  the non-secret correlation value, matched the activated recipient, and had
  distinct account/domain/day-scoped provider event identities;
- the temporary webhook was deleted by its returned identifier, the US account
  webhook list returned to its initial count of zero, and Tailscale Funnel was
  reset to an empty configuration.

This proves the provider-authored authentication, accepted/delivered mapping,
raw-envelope, correlation, and cleanup seams. It does not prove recipient-server
delivery, the remaining lifecycle mappings, or retry token behavior. Delivery
callbacks are not retried by Mailgun, so this test could not exercise retry
stability without manufacturing a different provider event.

## Primary sources

- [Introduction to Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks)
- [Configuring Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks)
- [Securing Webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks)
- [Webhook Payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads)
- [Webhook Retries](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-retries)
- [Event Structure](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-structure)
- [Event Types](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-types)
- [Metric Definitions](https://documentation.mailgun.com/docs/mailgun/user-manual/reporting/metric-definitions)
- [Account Webhooks API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/account-webhooks)
- [Domain Webhooks API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domain-webhooks/post-v3-domains--domain--webhooks)
- [Account Management API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/account-management)
- [Attaching Metadata](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-attachments)
- [Sending options](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/pass-sending-options)
- [Test mode](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/test-mode)
