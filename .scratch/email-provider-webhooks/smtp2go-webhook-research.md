# SMTP2GO outbound email webhook research

Research date: 2026-08-12

Scope: SMTP2GO outbound **email** event callbacks. SMS webhook events are out of
scope. Documented facts below come from SMTP2GO's current first-party developer
or support documentation; a separately labelled section records dated live
observations from the user's account. Recommendations and remaining limitations
are labelled explicitly.

## Executive conclusion

SMTP2GO is a viable next adapter for Sporades' consolidated email-event
dispatcher. It can create and manage callbacks in the SMTP2GO App or through
the v3 API, can send a configurable Bearer or Basic `Authorization` header, and
can emit JSON. Its email callbacks are documented as a flat set of parameters
for one event rather than an array. SMTP2GO documents a unique callback `id`, a
message-level `email_id`, the sender's `message-id`, and optional forwarding of
selected custom email headers. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)

The live account test confirmed single-object JSON callbacks, Bearer
authentication, exact event-specific body shapes, string event `id` values,
stable identity across repeated synthetic delivery, and observable `200`/`500`
handling. The synthetic facility does not enqueue failures into the production
retry queue and emitted no `resubscribe` sample, so production automatic-retry
identity/timing and the exact resubscribe body remain explicit limitations.

## Configuration and registration

### Documented facts

- Webhooks can be configured under **Settings > Webhooks > Manage Webhooks** in
  the SMTP2GO App or via the API. A webhook can be limited to selected SMTP
  Users, API Keys, or Authenticated IPs. [Setup a webhook](https://developers.smtp2go.com/docs/setup-a-webhook)
- The App asks for URL, optional Authorization header, users, output type,
  email events, optional email headers, and SMS events. Output may be JSON or
  form encoded. The App offers a **Test this webhook** button after saving.
  [Setup a webhook](https://developers.smtp2go.com/docs/setup-a-webhook)
- `POST https://api.smtp2go.com/v3/webhook/add` creates a webhook. Its request
  supports `url`, `events`, `headers`, `usernames`, `output_format`, optional
  `subaccount_id`, `auth_header_type`, and `auth_header_value`. The API itself
  authenticates with `X-Smtp2go-Api-Key`. `output_format` is `form` by default
  and may be `form` or `json`. [Add a new webhook](https://developers.smtp2go.com/reference/add-webhook)
- `auth_header_type` may be `bearer`, `basic`, or empty. SMTP2GO describes
  `auth_header_value` as a custom token for Bearer or `base64(user:pass)` for
  Basic. [Add a new webhook](https://developers.smtp2go.com/reference/add-webhook)
- The v3 API also exposes `POST /webhook/view`, `/webhook/edit`, and
  `/webhook/remove`. Edit and remove identify a configured webhook by its
  integer `id`. [View webhooks](https://developers.smtp2go.com/reference/view-webhook),
  [edit webhook](https://developers.smtp2go.com/reference/edit-webhook),
  [remove webhook](https://developers.smtp2go.com/reference/remove-webhook)
- Free accounts are limited to one configured webhook; paid accounts can
  create up to ten. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)

### Recommendations for Sporades

- Register `output_format: "json"`; do not inherit SMTP2GO's `form` default.
  This preserves provider JSON naturally in `VerifiedEmailEvent.raw` and keeps
  the first adapter implementation narrow.
- Prefer a high-entropy Bearer token stored in a sealed Server environment
  variable. Basic is also viable, but accepting URL userinfo, query secrets, or
  secret path components would unnecessarily expand the public authentication
  surface.
- Treat automated registration/reconciliation as a separate concern from
  callback parsing and dispatch. The runtime adapter should be useful with a
  webhook configured manually in the SMTP2GO App.
- If Sporades later automates registration, use `/webhook/view` to reconcile an
  existing callback before adding one. Do not assume an account has a spare
  webhook slot.

## Callback request and payload shape

### Documented facts

- SMTP2GO sends an HTTP or HTTPS **POST**, not GET. The body output is either
  JSON or form encoded according to the webhook configuration.
  [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- The email callback is documented as one flat parameter set containing:
  `event`, `time`, `sendtime`, `sender`, `from`, `from_address`, `from_name`,
  `rcpt`, `recipients`, `auth`, `host`, `message`, `context`, `email_id`, `id`,
  `message-id`, `bounce`, `subject`, `user-agent`, `read-secs`, `client`,
  `client-device`, `client-os`, `geoip-continent`, `geoip-country`,
  `geoip-city`, and `srchost`. Several fields are event-dependent or only
  present where data is available. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- `bounce` occurs on bounce events and is `hard` or `soft`. `host` is described
  for bounce events. Open/click fields may include user agent, client/device/OS,
  geo-IP data, and source IP. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- Subject and Message-ID headers are forwarded by default. A webhook can request
  additional custom email headers, but each named header must already exist on
  the sent email. [Add a new webhook](https://developers.smtp2go.com/reference/add-webhook)
- SMTP2GO says every open and every click can trigger a new event. Its setup
  guide refers to receiving webhook "requests" when webhook "events" occur.
  [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview),
  [setup a webhook](https://developers.smtp2go.com/docs/setup-a-webhook)

SMTP2GO does not publish a concrete callback JSON document or JSON Schema in
the cited webhook documentation. It also does not explicitly say "callbacks
are never batched." The singular flat parameter contract and per-occurrence
open/click language indicate one event object per request, but that is an
**inference**, not a documented no-batching guarantee.

### Recommended parser contract

- Initially accept a plain JSON object only and reject arrays as malformed.
- Preserve that exact parsed object as `VerifiedEmailEvent.raw`.
- Be permissive about unrecognised extra properties; optional custom headers
  make payload expansion an intentional provider feature.
- Require valid strings for `event`, `time`, and the identifier selected for
  `providerEventId`; validate `rcpt` only when present.
- Add an explicit array fixture only if the live Test facility or a captured
  real callback proves SMTP2GO batches requests.
- If form output is supported later, parse
  `application/x-www-form-urlencoded` into an object in an encoding-specific
  adapter. SMTP2GO calls it "Form encoded" but does not state the exact MIME
  type in the cited documentation, so this content type is a conventional
  expectation that requires validation.

## Identifiers and correlation

### Documented facts

- Callback `id` is described as "the unique id for the webhook."
- `email_id` uniquely identifies the email and can retrieve further delivery
  details.
- `message-id` is the unique identifier supplied by the sender.
- Selected custom email headers can be returned in callback data.
  [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- When sending through the API, `custom_headers` applies custom headers to the
  email. The standard send API returns an `email_id`; scheduled messages return
  a `schedule_id` that SMTP2GO also adds as `X-Smtp2go-Schedule-Id` for use with
  webhooks. [Send a standard email](https://developers.smtp2go.com/reference/send-standard-email)

The callback wording for `id` is ambiguous: the configuration API also calls
the configured webhook's integer identifier `id`. The callback docs do not say
whether callback `id` is stable across redelivery attempts.

### Recommendations for Sporades

- Tentatively map callback `id` to `providerEventId`, after live validation
  confirms it is a per-event identifier and remains constant across retries.
  If it does not, derive a deterministic identifier from stable event fields
  rather than inventing a fresh UUID on every delivery.
- Treat `email_id` as SMTP2GO's message-level provider identifier, useful for
  grouping lifecycle events but not as the event id: one email may produce
  delivered, repeated open, and repeated click events.
- Have Sporades-generated mail carry an unguessable custom header such as
  `X-Sporades-Correlation-Id`, and include that header name in the webhook's
  `headers` setting. Map its returned value to `correlationId`.
- Keep `message-id` only as a secondary compatibility correlation value. It is
  sender-controlled, and repeated lifecycle events share it.

## Email event taxonomy and Sporades mapping

SMTP2GO documents these event meanings in its
[webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview):

| SMTP2GO event | Documented meaning | Recommended `VerifiedEmailEvent.kind` | Notes |
| --- | --- | --- | --- |
| `processed` | Accepted by SMTP2GO's incoming servers and being processed; may remain processed during delivery attempts | `deferred` | Closest existing non-final Sporades kind, although "deferred" is not SMTP2GO's own term. |
| `delivered` | Recipient server returned `250` | `delivered` | Server acceptance, not proof a human read it. |
| `open` | Recipient opened tracked mail; each open may emit another event | `opened` | Tracking has known limitations; preserve raw client fields. |
| `click` | Recipient clicked a tracked link; each click may emit another event | `clicked` | Preserve raw URL/client context when supplied. |
| `bounce` | Recipient server bounced delivery; classified hard or soft | `bounced` | Preserve `bounce` classification and diagnostics in `raw`. |
| `spam` | Recipient marked/moved mail as spam; address is suppressed | `complained` | Direct semantic match. |
| `unsubscribe` | Recipient used SMTP2GO's Unsubscribe Footer; address is suppressed | `unsubscribed` | Direct semantic match. |
| `reject` | Sending rejected due to suppression, unverified sender, or sandboxed credential | `blocked` | Directly prevented before recipient-server delivery. Preserve reason in `raw`. |
| `resubscribe` | Recipient resubscribed or address was removed from Suppressions | **no current lossless mapping** | Recommend extending the public kind union with `resubscribed`; do not mislabel it `delivered` or silently treat it as `unsubscribed`. |

There is a first-party documentation discrepancy: the overview and support
article include `resubscribe`, while the `/webhook/add` and `/webhook/edit` API
event enums omit it. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview),
[add webhook](https://developers.smtp2go.com/reference/add-webhook),
[edit webhook](https://developers.smtp2go.com/reference/edit-webhook)
Until SMTP2GO clarifies this, the receiver should recognise `resubscribe` if it
arrives, while automated registration should not send it in the API `events`
array without live API validation.

## Authentication and verification

### Documented facts

- The App and registration API can configure a Bearer or Basic Authorization
  header on callback requests. [Setup a webhook](https://developers.smtp2go.com/docs/setup-a-webhook),
  [add webhook](https://developers.smtp2go.com/reference/add-webhook)
- SMTP2GO also documents URL user/password, query-password, and unguessable-path
  approaches. It says the endpoint can additionally restrict source addresses
  by resolving the A record for `webhooks.smtp2go.com`.
  [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- The webhook docs do not describe payload signatures, timestamp signatures,
  rotating signing keys, or replay protection.

### Recommendations for Sporades

- Verify a configured Bearer token with constant-time comparison before parsing
  or dispatching an event. Never use the account API key as the callback token.
- Do not advertise callbacks as cryptographically signed; this is shared-secret
  authentication only.
- IP checking can be optional defence in depth, but should not be the primary
  verifier. SMTP2GO instructs users to resolve a DNS A record rather than
  publishing a static signed range contract.
- Because there is no documented replay window, app-level idempotency keyed by
  the verified `providerEventId` remains necessary.

## Acknowledgement, retries, and testing

### Documented facts

- Failed webhook attempts retry for up to 48 hours and at most 35 attempts:
  five attempts in the first 30 minutes, hourly for the next 24 hours, every six
  hours for the next 24 hours, every twelve hours for the next 24 hours, and one
  final attempt after 24 hours. Failed Notifications in the App exposes request
  data and attempts and permits view, retry, and cancel.
  [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- The default timeout is ten seconds. SMTP2GO calls it a timeout if it receives
  no response headers in that period. [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- The App has **Test this webhook** for selected events. SMTP2GO's general
  testing advice also points users to request-capture services.
  [Setup a webhook](https://developers.smtp2go.com/docs/setup-a-webhook),
  [webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview)
- No first-party test/ping API endpoint is identified in the webhook API
  reference; the documented API surface is add, view, edit, and remove.
  [API features overview](https://developers.smtp2go.com/docs/api-features-guide)

SMTP2GO refers to webhook "failures" but the cited documentation does not define
which HTTP status codes count as success, whether redirects are followed, or
whether reading only response headers completes acknowledgement.

### Live account validation — 2026-08-12

A temporary webhook was created through `/v3/webhook/add`, exercised through
the App's **Test this webhook** facility, removed through `/v3/webhook/remove`,
and `/v3/webhook/view` then confirmed that the account again had zero webhooks.
The API key and fresh callback token were sourced only at runtime and were not
written to this repository.

Observed contract:

- `output_format: "json"` produced one `application/json` object per HTTP POST,
  never an array. All eight API-selectable email events were sent as separate
  concurrent requests: `processed`, `delivered`, `bounce`, `open`, `reject`,
  `spam`, `unsubscribe`, and `click`.
- `auth_header_type: "bearer"` produced a correctly cased Bearer Authorization
  header that matched the configured token. An unauthenticated public probe was
  rejected by the receiver with `401`; every provider test request authenticated.
- Every synthetic body had a lowercase string `event`, a 32-character lowercase
  hexadecimal string `id`, ISO-8601 string `time` and `sendtime`, a string
  `email_id`, and exact event-specific fields. `processed` used `recipients` as
  an array and omitted `rcpt`; recipient-specific events used string `rcpt`.
  Open/click diagnostics included hyphenated keys such as `opened-at`,
  `clicked-at`, `read-secs`, `user-agent`, and `geoip-country`.
- Requesting `X-Sporades-Correlation-Id` returned that exact case-sensitive body
  key as a string. The synthetic facility used the value `Headers Unavailable`,
  so a real sent-message correlation value was not exercised.
- Repeating **Test this webhook** reused the same `id` and byte-equivalent JSON
  object for each repeated event. A controlled `500` was displayed by the App
  as `HTTP Code (500)` with the receiver's response body, while the other seven
  `200` responses were successful.
- Synthetic test failures are not inserted into the production Failed
  Notifications queue, so the App could not manually retry the controlled
  failure. This validates stable identity across repeated provider-authored test
  delivery, but not the documented production automatic-retry schedule. A real
  message event would be required to prove retry timing and identity end to end.
- The App groups unsubscribe and resubscribe behind one
  **Unsubscribed/Resubscribed** selection, while the test facility emitted only
  `unsubscribe`. The receiver therefore keeps defensive `resubscribe` support,
  but no live resubscribe body was available.

### Recommendations for Sporades

- Return `200` promptly only after authentication, parsing, normalization, and
  inline subscription dispatch succeed. Return a non-2xx status on transient
  handler failure to request retry. This matches Sporades' existing provider
  contract but the exact SMTP2GO status handling must be live-validated.
- Enqueue durable work in the Capsule handler and use `providerEventId` for
  idempotency; the provider's 35-attempt retry schedule guarantees duplicates
  are an ordinary case, not an edge case wearing a fake moustache.
- Acknowledge unsupported event types with `200` after authentication so retries
  cannot amplify an adapter-version mismatch. Log only safe event metadata.

## Live validation checklist

Use the user's account without placing its API key or callback secret in source,
tests, shell history, logs, or this note.

1. Configure a temporary JSON webhook with a fresh Bearer callback token and
   select every available **email** event in the App.
2. Use **Test this webhook** for each selectable event and capture the exact
   method, `Content-Type`, Authorization header, body shape, value types, and
   optional-field omissions.
3. Confirm whether each callback body is one object or an array and whether the
   Test facility's synthetic payload matches real callbacks.
4. Force one callback to return a non-2xx status, inspect Failed Notifications,
   retry it manually, and compare callback `id` and the entire body between
   attempts.
5. Send a real message carrying `X-Sporades-Correlation-Id`; confirm the exact
   returned key spelling/value and compare callback `email_id` with the send
   response where applicable.
6. Exercise delivered plus repeated open/click events to confirm that callback
   `id` is event-specific while `email_id` remains message-specific.
7. Check whether the App permits selecting `resubscribe`; check whether
   `/webhook/add` accepts or rejects it despite the documented API enum.
8. Verify response behavior for `200`, another 2xx, `400`, `401`, `500`, and a
   response-header delay over ten seconds. Avoid waiting through the full retry
   horizon; App-level manual retry is sufficient to establish identity stability.
9. Remove the temporary webhook and revoke the temporary callback token after
   validation.

## Implementation acceptance evidence suggested by this research

- Provider fixtures should be copied from the exact captured JSON callbacks,
  with secrets and addresses replaced while retaining key names and value types.
- Unit/integration coverage should include all nine documented event names,
  hard and soft bounce variants, optional/missing fields, unknown event handling,
  authentication failure, malformed bodies, handler retry propagation, and
  deterministic duplicate delivery.
- The public docs should state that SMTP2GO registration defaults to form output,
  that Sporades requires/configures JSON, that authentication is a shared Bearer
  or Basic secret rather than a signature, and that raw payloads may contain
  recipient, IP, user-agent, subject, and diagnostic data.
