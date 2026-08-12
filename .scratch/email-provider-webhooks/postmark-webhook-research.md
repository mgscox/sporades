# Postmark outbound email webhook research

Research date: 2026-08-12

Scope: Postmark outbound email lifecycle webhooks for Transactional Message
Streams. Inbound webhooks are out of scope. All documented facts below come
from current first-party Postmark developer or support documentation.
Recommendations are labelled explicitly. The dated live-account observations
near the end are first-hand evidence from the user's Postmark test-mode Server.

## Executive conclusion

Postmark is a viable adapter for Sporades' consolidated email-event dispatcher.
One modular webhook can receive six JSON event families: `Delivery`, `Bounce`,
`Open`, `Click`, `SpamComplaint`, and `SubscriptionChange`. Registration is
available through the Server-token Webhooks API, and Postmark can attach either
Basic HTTP credentials or arbitrary static request headers to callbacks.
[Webhooks API](https://postmarkapp.com/developer/api/webhooks-api),
[modular webhooks](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work)

Postmark does **not** support HMAC webhook signatures. Its current recommended
protection is HTTPS with Basic HTTP Authentication and optional allowlisting of
Postmark's source IP ranges. Sporades can instead configure a high-entropy
Bearer value as a static `Authorization` custom header, but that is shared-secret
authentication, not payload signing or replay protection. Postmark documents
arbitrary header name/value pairs but does not enumerate reserved header names,
so acceptance of `Authorization` specifically must be confirmed by the live
create/test pass.
[Webhook protection](https://postmarkapp.com/developer/webhooks/webhooks-overview#protecting-your-webhook)

`MessageID` is a useful Postmark message-level correlation value, but it is not
a general event identifier: one message can produce multiple opens and multiple
unique clicks. Bounce and spam complaint payloads have a separate numeric `ID`,
while delivery, open, click, and subscription-change payloads do not document a
provider event ID. Sporades therefore needs an event-specific deterministic
identity derivation rather than deduplicating every callback on `MessageID`.
[Open webhook](https://postmarkapp.com/developer/webhooks/open-tracking-webhook),
[click webhook](https://postmarkapp.com/developer/webhooks/click-webhook),
[bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook)

## Registration, listing, editing, and deletion

### Documented API contract

- `GET https://api.postmarkapp.com/webhooks` lists all webhooks for a Server.
  The optional `MessageStream` query parameter filters by stream; an unknown
  stream produces an error rather than an empty list.
- `GET /webhooks/{Id}` fetches one webhook.
- `POST /webhooks` creates one webhook. If `MessageStream` is omitted, Postmark
  uses the default transactional stream, `outbound`.
- `PUT /webhooks/{Id}` edits one webhook. Partial trigger updates leave omitted
  triggers unchanged.
- `DELETE /webhooks/{Id}` removes one webhook and returns an `ErrorCode` and
  message.
- All five operations require `X-Postmark-Server-Token`; create/edit also
  require JSON request bodies. The API calls this “server level privileges.”
  [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)

A webhook resource contains:

- integer `ID`, string `Url`, and string `MessageStream`;
- optional `HttpAuth: { Username, Password }`;
- optional `HttpHeaders: [{ Name, Value }]`;
- `Triggers` containing `Open`, `Click`, `Delivery`, `Bounce`,
  `SpamComplaint`, and `SubscriptionChange` settings. `Open` adds
  `PostFirstOpenOnly`; Bounce and SpamComplaint add `IncludeContent`.
  [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)

The Postmark UI supports up to ten modular webhooks, each with any combination
of the six event types. Bounce and SpamComplaint hooks are unavailable for
Broadcast Message Streams. Up to 30 static custom callback headers may be
attached. With no overrides, callback requests use `Content-type:
application/json` and `User-agent: Postmark`.
[Modular webhooks](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work)

### Server-token scope

Postmark distinguishes Server tokens from Account tokens. Webhook management
and email sending both require a Server token. Server tokens are visible to an
Account Owner, Account Admin, or a user with Server Admin privileges for that
Server. The documented API does not expose a webhook-only permission scope, so
the supplied `POSTMARK_API_KEY` should be treated as a full Server secret and
must never be reused as the public callback secret.
[API authentication](https://postmarkapp.com/developer/api/overview#authentication),
[Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)

### Recommended Sporades registration policy

- Keep registration/reconciliation separate from runtime parsing and dispatch;
  manually configured webhooks must remain supported.
- Before a live test, list the Server's existing webhooks and do not edit or
  delete any webhook not created by the test.
- Create one temporary webhook on the `outbound` stream, recording its returned
  integer `ID` for exact cleanup.
- Set `Bounce.IncludeContent` and `SpamComplaint.IncludeContent` to `false`.
  Raw mail bodies and abuse reports are unnecessary sensitive data for lifecycle
  normalization.
- Prefer `Open.PostFirstOpenOnly: false` in contract testing so distinct opens
  are observable. Product documentation should explain that users may choose
  first-open-only to reduce volume.

## Callback verification and authentication

### Documented facts

- Postmark requires a publicly accessible URL and recommends HTTPS.
- Basic HTTP Authentication is configured either as `HttpAuth` through the API
  or as URL userinfo in the older setup description.
- Arbitrary static callback headers can be configured with `HttpHeaders`.
- Postmark explicitly says it does not currently support HMAC webhook signature
  verification. There is no documented timestamp signature, public signing key,
  or replay window.
- Postmark publishes source IP ranges for optional firewall allowlisting, but an
  origin IP may change between retry attempts.
  [Webhook protection](https://postmarkapp.com/developer/webhooks/webhooks-overview#protecting-your-webhook),
  [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)

### Recommended Sporades verification contract

- Configure a distinct, high-entropy callback token—not the Postmark Server
  token—as `HttpHeaders: [{ "Name": "Authorization", "Value": "Bearer …" }]`.
  This uses Postmark's documented arbitrary-static-header facility and matches
  the existing provider-neutral Sporades callback secret model. Confirm that
  Postmark accepts the `Authorization` name during live registration; if it
  rejects reserved headers, a provider-neutral custom secret header would need
  an explicit dispatcher/configuration decision rather than a hidden fallback.
- Compare the expected Bearer value in constant time before parsing or
  dispatching the JSON body.
- Describe the result as an authenticated or verified callback, never a signed
  callback.
- Treat IP allowlisting as optional defence in depth. Do not make it the sole
  verifier because deployments behind proxies require trusted-forwarding
  configuration and Postmark can change origin IP between attempts.
- Since Postmark supplies no replay timestamp/signature, downstream consumers
  still need idempotency on the derived `providerEventId`.

## Callback shape and event taxonomy

Postmark sends JSON documents with an ISO 8601 event timestamp. `RecordType`
selects the event family. The current first-party examples are single JSON
objects, and the UI sends one selected test event. No first-party documentation
found for this research describes array/batch callback bodies. The initial
adapter should therefore accept one plain object and reject arrays as malformed.
[Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview),
[modular webhook testing](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work#test-your-webhook)

| `RecordType` | Principal documented fields and types | Event time | Recipient | Recommended Sporades kind |
| --- | --- | --- | --- | --- |
| `Delivery` | `MessageID: string`, `Recipient: string`, `Details: string`, `Tag?: string`, `ServerID: number`, `Metadata: object`, `MessageStream: string` | `DeliveredAt: ISO 8601 string` | `Recipient` | `delivered` |
| `Bounce` | `ID: int64`, `MessageID: string`, `Type: string`, `TypeCode: number`, `Name: string`, `Description: string`, `Details: string`, `Email: string`, `From: string`, `Inactive: boolean`, `CanActivate: boolean`, optional `Content`, plus tag/server/metadata/stream fields | `BouncedAt: ISO 8601 string` | `Email` | `bounced` |
| `Open` | `MessageID: string`, `Recipient: string`, `FirstOpen: boolean`, client/OS/platform/user-agent/geo objects or strings, tag/metadata/stream fields | `ReceivedAt: ISO 8601 string` | `Recipient` | `opened` |
| `Click` | `MessageID: string`, `Recipient: string`, `OriginalLink: string`, `ClickLocation: string`, client/OS/platform/user-agent/geo fields, tag/metadata/stream fields | `ReceivedAt: ISO 8601 string` | `Recipient` | `clicked` |
| `SpamComplaint` | `ID: number` in the example, `MessageID: string`, `Type: "SpamComplaint"`, `TypeCode: 512`, `Email: string`, `From: string`, `Inactive: boolean`, `CanActivate: false`, optional `Content`, plus bounce-like details/tag/server/metadata/stream fields | `BouncedAt: ISO 8601 string` | `Email` | `complained` |
| `SubscriptionChange` | `MessageID: string \| null`, `Recipient: string`, `Origin: string`, `SuppressSending: boolean`, `SuppressionReason: string \| null`, `Tag: string \| null`, `Metadata: object`, `ServerID: number`, `MessageStream: string` | `ChangedAt: ISO 8601 string` | `Recipient` | conditional; see below |

Sources for the exact example payloads and field explanations:
[Delivery](https://postmarkapp.com/developer/webhooks/delivery-webhook#delivery-webhook-data),
[Bounce](https://postmarkapp.com/developer/webhooks/bounce-webhook#bounce-webhook-data),
[Open](https://postmarkapp.com/developer/webhooks/open-tracking-webhook#open-webhook-data),
[Click](https://postmarkapp.com/developer/webhooks/click-webhook#click-webhook-data),
[Spam complaint](https://postmarkapp.com/developer/webhooks/spam-complaint-webhook#spam-complaint-webhook-data),
[Subscription change](https://postmarkapp.com/developer/webhooks/subscription-change-webhook#subscription-change-webhook-data).

All parsed properties, including unknown future additions, should be retained
unchanged in `VerifiedEmailEvent.raw`. Bounce and spam `Content` should be absent
under the recommended registration settings, but the parser must tolerate it.

### Subscription-change semantics

`SubscriptionChange` is broader than “unsubscribe.” Postmark emits it whenever
an address is added to or removed from a Message Stream suppression list. An
address may be added because of a hard bounce, spam complaint, unsubscribe, or
manual suppression. `SuppressSending: false` means reactivation. Recipient
unsubscribes use `SuppressionReason: "ManualSuppression"`; `Origin` distinguishes
Recipient, Customer, and Admin actions. `MessageID` is null for manual Customer
or Admin suppressions and for reactivations.
[Subscription change](https://postmarkapp.com/developer/webhooks/subscription-change-webhook)

Recommended loss-minimising mapping:

- `SuppressSending === false` → `resubscribed`;
- `SuppressSending === true && Origin === "Recipient" &&
  SuppressionReason === "ManualSuppression"` → `unsubscribed`;
- other suppressions should not be mislabeled as recipient unsubscribes. Map
  them to `blocked` only if the generic contract defines that as address-level
  suppression; otherwise acknowledge and ignore them while preserving the raw
  callback. Separate Bounce and SpamComplaint callbacks already express those
  specific lifecycle causes.

This conditional behavior needs fixtures for recipient unsubscribe, customer
manual suppression, hard-bounce suppression, and reactivation.

## Identity and correlation

### Documented identifiers

- `MessageID` is Postmark's own message identifier and is returned by the Email
  API on send. Postmark explicitly distinguishes it from the outbound RFC
  `Message-ID` mail header; the Postmark `MessageID` is what appears in webhook
  JSON.
- Bounce `ID` is an `int64` and can be used with the Bounce API. Spam complaints
  use the bounce-like payload and include numeric `ID` in the official example.
- Open tracking can emit every open when `PostFirstOpenOnly` is false.
- Click tracking emits one event per unique recipient/link combination within
  the retention period. Multiple recipients and multiple links therefore
  produce distinct callbacks associated with the same sent message.
- Every event-family example includes `Metadata`, allowing Capsule-owned
  correlation data sent with the message to return in callbacks.
  [Email API](https://postmarkapp.com/developer/api/email-api),
  [SMTP MessageID distinction](https://postmarkapp.com/developer/user-guide/send-email-with-smtp#troubleshooting-smtp-problems),
  [Bounce ID](https://postmarkapp.com/developer/webhooks/bounce-webhook#bounce-webhook-data),
  [Open behavior](https://postmarkapp.com/developer/webhooks/open-tracking-webhook),
  [Click behavior](https://postmarkapp.com/developer/webhooks/click-webhook)

### Recommended event identity

Do not use `MessageID` alone as `providerEventId`. It would collapse legitimate
opens and clicks, and `SubscriptionChange.MessageID` can be null.

Use a deterministic provider-scoped digest of a typed tuple of stable fields:

- Delivery: `RecordType`, `MessageID`, `Recipient`, `DeliveredAt`;
- Bounce: `RecordType`, the exact `ID` representation, `MessageID`, `Email`,
  `BouncedAt`;
- Open: `RecordType`, `MessageID`, `Recipient`, `ReceivedAt`, `FirstOpen`, and
  stable request context such as Geo IP/UserAgent when present;
- Click: `RecordType`, `MessageID`, `Recipient`, `ReceivedAt`, `OriginalLink`,
  and `ClickLocation`;
- SpamComplaint: `RecordType`, exact `ID`, `MessageID`, `Email`, `BouncedAt`;
- SubscriptionChange: `RecordType`, nullable `MessageID`, `Recipient`,
  `ChangedAt`, `Origin`, `SuppressSending`, and nullable `SuppressionReason`.

The bounce documentation's example `ID` (`4323372036854775807`) exceeds
JavaScript's safe integer range. A normal `JSON.parse` rounds such a numeric
lexeme before `String(ID)` can preserve it. Do not claim lossless numeric-ID
identity from the parsed number. Either capture the raw numeric token with a
parser that preserves large integers, or rely on the deterministic stable-field
tuple above while preserving the ordinary parsed object as the public `raw`
value. This edge needs a fixture using Postmark's documented int64 example.

Live tests must verify that a forced retry repeats the same identity inputs.
Postmark's overview recommends checking `MessageID` for retry idempotency, but
that broad advice is insufficient for multi-open and multi-click handlers.

### Sporades correlation metadata

For Email API sends, include an unguessable value such as
`Metadata: { "sporades-correlation-id": "…" }`. For SMTP sends, Postmark maps an
`X-PM-Metadata-<key>` mail header to the corresponding metadata field, so use
`X-PM-Metadata-sporades-correlation-id`. Map that returned metadata value to
`VerifiedEmailEvent.correlationId`.
[API metadata](https://postmarkapp.com/developer/user-guide/send-email-with-api#json-message-format),
[SMTP metadata](https://postmarkapp.com/developer/user-guide/send-email-with-smtp#metadata-support)

## Acknowledgement, retries, and batching

### Success semantics and retries

Postmark's developer overview says it retries when it does not receive HTTP
`200`, and stops retries on `403`. Its newer modular-webhook support article says
any `2xx` response is successful. The narrow interoperable behavior is to return
`200` only after the consolidated dispatcher has accepted the event; return
`401` for invalid callback authentication and reserve `403` for a permanent
rejection because Postmark documents it as non-retryable.
[Retry attempts](https://postmarkapp.com/developer/webhooks/webhooks-overview#retry-attempts),
[modular webhook testing](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work#test-your-webhook)

Documented retry schedules after the initial failure are:

- Bounce and Inbound: 1 minute, 5 minutes, 10 minutes three times, 15 minutes,
  30 minutes, 1 hour, 2 hours, and 6 hours.
- Click, Open, Delivery, and SubscriptionChange: 1 minute, 5 minutes, and 15
  minutes.
- The overview does not place SpamComplaint in either schedule. Treat its retry
  timing as undocumented rather than assuming the Bounce schedule.
  [Retry attempts](https://postmarkapp.com/developer/webhooks/webhooks-overview#retry-attempts)

Sporades currently dispatches before acknowledging, so a handler failure should
produce a retryable non-200 response. Consumers must still be idempotent because
network loss after successful processing can cause a redelivery.

### Batching

Every first-party event example is a single object. Click documentation
explicitly says Postmark sends one event per unique click and describes separate
calls for separate recipients. The UI test selects one event type per test.
No official source reviewed here documents batched outbound webhook arrays.
Accept a single object initially and add batch support only if a live callback
or future first-party contract proves it exists.
[Click webhook](https://postmarkapp.com/developer/webhooks/click-webhook),
[modular webhook testing](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work#test-your-webhook)

## Testing facilities

- Before saving a webhook in the Postmark UI, **Send test** sends one selected
  event type to the entered URL. If multiple triggers are selected, a dropdown
  chooses which type to test. The hook must return 2xx for the UI to call it
  successful.
- Every individual developer webhook page also provides a documented `curl`
  fixture for local parser testing.
- Postmark provides a black-hole domain for safe fake bounce generation, but
  that would violate the user's current account restriction that live sends may
  only target `matt.c@mattgscox.com`.
- No first-party test-webhook API endpoint was found in the Webhooks API. The
  synthetic **Send test** facility is a UI operation, not a documented Server
  API operation.
  [Modular webhook testing](https://postmarkapp.com/support/article/1115-how-do-modular-webhooks-work#test-your-webhook),
  [webhook curl testing](https://postmarkapp.com/developer/webhooks/webhooks-overview#testing-your-webhook),
  [bounce testing](https://postmarkapp.com/developer/webhooks/bounce-webhook)

`POSTMARK_API_TEST` validates an Email API request without delivering mail, but
it is not a webhook trigger and should not be mistaken for callback validation.
[Email API testing](https://postmarkapp.com/developer/user-guide/send-email-with-api#authentication-headers)

## Safe live-validation plan

Constraints: never print or persist `POSTMARK_API_KEY`; never send to any address
other than `matt.c@mattgscox.com`; do not mutate existing webhooks or suppression
state; remove all temporary resources afterward.

1. Source the refreshed key only inside a short-lived process and call
   `GET /webhooks?MessageStream=outbound`. Record only non-secret structural
   facts. Abort rather than modify an existing webhook.
2. Start an ephemeral HTTPS callback tunnel and local receiver. Generate a
   distinct random callback Bearer token and do not log the Authorization
   header. Capture bodies in a mode that redacts recipient values and metadata
   secrets in terminal output.
3. In the Postmark UI's unsaved Add Webhook form, configure the temporary URL,
   static `Authorization: Bearer …` header, and all six triggers. Use **Send
   test** once for Delivery, Bounce, Open, Click, SpamComplaint, and
   SubscriptionChange. This validates exact provider-generated synthetic
   shapes without sending forbidden mail or changing suppressions.
4. Repeat one safe synthetic event with the receiver intentionally returning a
   retryable failure once, then `200`, if the UI test facility participates in
   retry delivery. Compare the derived identity inputs. If UI tests do not
   retry, explicitly record retry identity as unvalidated rather than creating
   a production failure merely to satisfy a checklist.
5. If a real event is required, create the temporary webhook through
   `POST /webhooks`, recording only its returned ID. Enable Delivery, Open, and
   Click, with content inclusion disabled for Bounce/SpamComplaint.
6. Send exactly one tracked message through `POST /email` to
   `matt.c@mattgscox.com`, using a confirmed sender on the Server, a unique
   `sporades-correlation-id` Metadata value, `TrackOpens: true`, and
   `TrackLinks: "HtmlOnly"`. The body should contain one harmless unique link.
   Validate Delivery, then have the user open and click the message to validate
   Open and Click. Do not CC/BCC or use the bounce black-hole domain.
7. Do not live-generate SpamComplaint or suppression changes against the user's
   allowed address. Synthetic UI callbacks are sufficient for those destructive
   event families.
8. `DELETE /webhooks/{temporary ID}`, then list webhooks again to prove the
   account returned to its original state. Stop the tunnel/receiver and delete
   temporary capture files and tokens.

## Live account validation — 2026-08-12

A temporary modular webhook was created through `POST /webhooks` on the
`outbound` Transactional Message Stream, exercised with Postmark's own **Send
test** control for all six selectable event families, then removed through
`DELETE /webhooks/{ID}`. A final `GET /webhooks` returned zero webhooks and
Tailscale Funnel was reset. The Server API token and the independently generated
callback secret were never printed or persisted in the repository.

Observed account and authentication behavior:

- The Server API exposed `outbound` as a Transactional stream and initially had
  zero webhooks.
- Postmark accepted `X-Sporades-Webhook-Token` in `HttpHeaders` and included it
  on every provider-authored synthetic callback. The Sporades route rejected
  unauthenticated requests in automated coverage and accepted all six live test
  requests through the same verifier and dispatcher.
- The test-mode account accepted exactly one approved API send from and to
  `matt.c@mattgscox.com`. Postmark retained it as `Sent` with no recorded
  Delivery event during the four-minute observation window, so it emitted no
  real Delivery callback. No second message was sent.

Observed provider-authored callback behavior:

- `Delivery`, `Bounce`, `SpamComplaint`, `Open`, `Click`, and
  `SubscriptionChange` were each single JSON objects, not arrays.
- Each object matched its documented field family and also demonstrated why
  `raw` must remain forward-compatible. For example, Open included the
  additional numeric `ReadSeconds` field, which the adapter preserved without
  needing to understand it.
- All six objects normalized successfully through the provider-neutral
  dispatcher. Postmark's Subscription Change test used
  `SuppressSending: true`, `SuppressionReason: "HardBounce"`, and
  `Origin: "Recipient"`; the adapter correctly emitted `bounced`, not
  `unsubscribed`.
- The custom-header verifier, event timestamps, recipients, deterministic
  identities, exact raw-object preservation, and all six kind mappings were
  exercised. The UI's test facility did not provide a retry control.

Remaining live limits are explicit: the accepted real message did not reach a
provider Delivery state during the bounded run, so provider retry timing and
byte-equivalent retry payloads were not observed live. Deterministic replay
identity remains covered by automated duplicate-fixture tests. Generating a
real bounce, complaint, unsubscribe, or suppression against the user's approved
recipient was deliberately out of scope.

## Implementation acceptance checklist

- [x] Configuration is optional and exposes a provider route only when enabled.
- [x] Runtime verifies the configured callback secret before JSON parsing and
      dispatch.
- [x] Arrays, null, malformed JSON, missing/invalid timestamps, missing event
      identity inputs, and invalid auth have explicit responses.
- [x] All six exact official fixtures are represented in tests, including the
      documented out-of-safe-range bounce `ID`.
- [x] `SubscriptionChange` has fixtures for unsubscribe, reactivation, and
      non-recipient/manual suppression without semantic mislabeling.
- [x] Unknown `RecordType` values are acknowledged and ignored so provider
      expansion does not create a retry storm.
- [x] `VerifiedEmailEvent.raw` is the exact parsed provider object.
- [x] `providerEventId` is deterministic per occurrence and does not collapse
      multiple opens or distinct clicks onto `MessageID`.
- [x] API and SMTP correlation metadata map to `correlationId`.
- [x] A single Capsule subscription receives Postmark events through the shared
      dispatcher; no Postmark-specific Capsule callback exists.
- [x] User documentation distinguishes shared-secret authentication from
      signing, documents retries/privacy, and gives the Postmark registration
      shape.
- [x] Live validation records which event families were synthetic versus real,
      and cleanup proves no temporary webhook remains.

## Explicit uncertainties to retain

- Postmark's overview contains recently added TypeScript examples that refer to
  signature verification, but the same page explicitly says HMAC signatures are
  not supported. The explicit product note governs; do not implement an
  `X-Postmark-Signature` verifier without a new first-party contract.
- No unique provider event identifier is documented for Delivery, Open, Click,
  or SubscriptionChange.
- SpamComplaint retry timing is omitted from the published retry schedule.
- No outbound callback batching contract is documented.
- Whether synthetic UI tests are retried after a non-2xx response requires live
  validation.
