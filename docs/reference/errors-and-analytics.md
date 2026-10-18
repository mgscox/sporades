# Errors and analytics

Sporades 0.9.x supports opt-in Sentry-envelope error tracking and Umami or
Plausible pageviews. Existing Capsules remain unchanged when these settings are
omitted. These integrations are independent of OTLP Telemetry profiles.

Add to `sporades.json`:

```json
{
  "observability": {
    "errors": {
      "protocol": "sentry",
      "dsnEnv": "ERROR_DSN",
      "environment": "production",
      "sampleRate": 1,
      "client": true
    }
  },
  "analytics": {
    "provider": "umami",
    "endpointEnv": "ANALYTICS_ENDPOINT",
    "websiteIdEnv": "ANALYTICS_WEBSITE_ID",
    "redactQuery": true
  }
}
```

Only env **names** belong in config. Store their values in Server env, using
Sealed Server env for Hosted Capsules. Missing or empty env leaves that
integration dormant; malformed URLs in a complete configuration fail startup with an opaque
configuration error. Production collection URLs require HTTPS; HTTP is accepted
only for loopback development receivers. Provider redirects are never followed.
No requests are sent when neither integration is active.

## GlitchTip or Sentry-compatible error tracking

1. Create a project in GlitchTip, Sentry, Bugsink, or another service accepting
   the [Sentry envelope protocol](https://develop.sentry.dev/sdk/envelopes/).
2. Copy its DSN into the Server env value `ERROR_DSN`, for example
   `https://public-key@errors.example.com/42`. A path prefix is supported.
3. Set `observability.errors` as above and rebuild/restart the Capsule.

Uncaught query, mutation, Custom endpoint and Job failures produce envelopes
with redacted messages and parsed stack frames, tagged with Capsule, release
(`SPORADES_RELEASE_ID` when available), environment and runtime surface.
Expected auth/ACL denials (`DENIED`, `UNAUTHENTICATED`, `FORBIDDEN`, and
`REAUTHENTICATION_REQUIRED`) and Job/resource cancellations do not create error
events. The browser filters these codes before counting its error budget. Job
attempt failures may each create an event; reporting never changes rollback,
commit or retry decisions. `sampleRate` is an error probability from 0 to 1,
defaulting to 1. Set 0 to suppress errors.

Browser errors are separately opt-in with `client: true` (default false).
The first-party loader captures `error`, `unhandledrejection`, and error results
received by the Sporades client transport. This is basic collection: it does not
upload source maps, capture console output, record sessions, or track users.

## Umami pageviews

1. Add the Capsule's site in Umami and copy its website ID into the Server env
   value `ANALYTICS_WEBSITE_ID`.
2. Set `ANALYTICS_ENDPOINT` to the full collection URL, for example
   `https://analytics.example.com/api/send`. For Umami Cloud use
   `https://gateway.umami.is/api/send`.
3. Set `analytics` as above and rebuild/restart. Remove the app's old analytics
   script to avoid duplicate pageviews.

The tunnel implements Umami's [HTTP collection protocol](https://docs.umami.is/docs/api/sending-stats).
For Plausible, set `provider: "plausible"`, put the configured site domain into
`ANALYTICS_WEBSITE_ID`, and use an endpoint such as
`https://plausible.io/api/event`. See its [Events API](https://plausible.io/docs/events-api).

## Same-origin collection and privacy

On document navigation, active browser integrations add the first-party
`/__sporades/observe.js` loader before Capsule scripts. It sends JSON to
`POST /__sporades/collect`. Both routes follow normal request admission.
`script-src 'self'` and `connect-src 'self'` suffice for collection; no provider
script, DSN, endpoint or website identifier reaches the page. Browser blocking
rules can still block any URL, so delivery cannot be guaranteed.

Pageviews cover initial load, `pushState`, `replaceState`, `popstate` and hash
changes. Hash routing creates pageviews for the outer pathname; the fragment
itself is never exported. Queries and fragments are removed from page/referrer
URLs, error messages and stack filenames at the runtime boundary, including
for callers bypassing the loader. `redactQuery` defaults to true and cannot be
set to false. Capability links such as `?request=<token>` never reach providers.
Do not put capabilities in URL path segments or ordinary diagnostic prose.
Messages and frames reuse the log diagnostic redaction policy for Server env
values and recognizable credentials, including quoted JSON fields, quoted
passwords with spaces, Basic/Bearer credentials and complete Cookie headers.
Sensitive arrays and objects are concealed as a whole, including every token
and Set-Cookie entry; malformed containers conceal the remaining text.
URL queries/fragments are stripped from absolute, protocol-relative (`//host/path`),
root-relative (`/path`) and explicit relative (`./path`, `../path`) URLs, including
stack filenames. Relative URLs are recognized after punctuation and key/value
delimiters, including `url=/path`, `[//host/path]`, and `<./path>`.
Embedded apostrophes such as `?filter=O'Reilly&cap=...` or `?filter=O'-Reilly&cap=...`
cannot end stripping or expose later query values or fragments. Apostrophes beside
URI punctuation or query separators remain private; ambiguous quotation conceals
the remainder until a structural boundary or line end. Quoted query values may include
repeated apostrophes such as `?filter=O', Reilly's&cap=...` or another opening
apostrophe after punctuation. These quotes cannot hide a later query/fragment
continuation from redaction. Separately quoted/assigned URL fields, surrounding
JSON fields and following public lines retain their structural boundaries.
Quoted query values may also include
leading/trailing spaces or tabs, including JSON-escaped quotation such as
`?filter=\" O'Reilly phrase \"&cap=...`. The runtime scans quoted values and escapes
through the URL boundary, then removes everything from the first `?` or `#`
(including percent-encoded `%3F` / `%23`) to that boundary. Encoded query values
remain private. Surrounding JSON fields are preserved;
an unterminated quoted value conceals the remaining line.
Genuine surrounding quotation, punctuation and ordinary prose such as `Investigate
#234 collection` and `Ready? Continue debugging.` are preserved.
There are no custom analytics properties,
page titles, request bodies, cookies or authorization headers in provider events.

The tunnel accepts only same-origin JSON requests and a fixed event schema.
Provider destinations and identities come exclusively from Server env. It
forwards only the authenticated Hosted client address: analytics receive
`X-Forwarded-For`, and browser Sentry events receive `user.ip_address`. User-Agent
is forwarded for analytics. Untrusted forwarding headers are ignored. Outside a
verified Hosted boundary, no client IP is forwarded; provider visitor/location
counts may consequently reflect the collector rather than individual visitors.

Delivery is best effort, with no persistent queue or retries. Each runtime
admits at most 120 collection/delivery reservations per minute and eight active
reservations; browser error delivery uses a second reservation inside the
request. The browser also caps errors at 20 per minute. Request bodies are
limited to 16 KiB, messages to 2,048 characters and stacks to 20 frames. Reads and outbound
requests have two-second timeouts. Saturation drops errors or returns 429 for
collection. Provider failures and responses stay opaque and never alter Capsule
transactions. Closing the runtime revokes further delivery.
