# Runtime-Owned Provider Auth

Sporades v2 implements provider auth in the server runtime rather than adding a
browser auth SDK or trusting client-supplied profile data. The browser client
sends only sign-in intent through `auth.signIn(provider)`. A runtime-owned
provider adapter starts and completes the provider protocol, then hands a
verified Provider identity to one common linker. The shared callback supports
both query and `form_post` response modes at
`/__sporades/auth/<provider>/callback`.

Each authorization attempt has opaque, single-use state bound to the provider,
current Sporades Session, exact callback URI, same-origin return URL, creation
and expiry times, nonce, and PKCE verifier. Callback state is atomically
consumed before cancellation, provider exchange, identity verification,
linking, or Session work, so every terminal failure requires a fresh attempt.
Provider errors are returned as bounded Sporades errors; provider response
bodies and tokens are not sent to clients, logged, or persisted.

The built-in Google adapter uses authorization-code flow with PKCE and nonce.
It verifies the returned ID token signature against Google's JWKS and requires
Google issuer, configured audience, unexpired `exp`, matching nonce, and a
non-empty string `sub` of at most 255 printable ASCII characters before
producing the verified Provider identity. Access tokens are not used as
identity evidence.

The built-in Facebook adapter uses a full-page authorization-code flow and the
exact callback URI stored with opaque, single-use state. It requests only
`public_profile` and `email`, exchanges the code with the App Secret on the
server, then reads `id,name,email,picture` from the explicitly supported Meta
Graph API `v23.0` `/me` interface. The stable string `id` is required and is
the Provider identity subject. Email, name, and picture are optional; a user
who declines email access can still sign in. Provider access tokens and raw
Graph response bodies remain local to the adapter and are never profile fields.
Facebook protocol endpoints are fixed HTTPS URLs in normal operation. Fetches
refuse redirects, have finite deadlines, and stream response bodies through a
64 KiB hard cap before JSON parsing. An explicit process-only test seam permits
plain HTTP solely for loopback protocol receivers; Capsule configuration cannot
select endpoints or enable that seam.
The same deadline remains authoritative while a response body is streaming;
timeout, oversize, malformed JSON, and other read failures cancel and release
the response reader before returning a bounded error.

The built-in Microsoft adapter discovers the selected Microsoft identity
platform tenant's OpenID Connect endpoints and uses authorization-code flow
with PKCE, state, nonce, an exact callback URI, and `openid profile email`
scopes. It verifies the ID token signature, discovered issuer, signing-key
issuer, configured audience, expiry, nonce, tenant policy, tenant ID, and stable subject. Provider
identity is keyed by the tenant-qualified subject, so equal `sub` values in
different tenants cannot collide. Email and `preferred_username` remain
optional mutable profile data and are never identity evidence.

Tenant selection accepts `common`, `organizations`, `consumers`, a tenant GUID,
or a verified tenant domain. `organizations` rejects the Microsoft consumer
tenant, `consumers` accepts only it, and specific-tenant tokens must agree with
the selected/discovered tenant context. Consent and interaction requirements,
tenant rejection, exchange failure, and token-verification failure use bounded
Sporades errors without reflecting provider response bodies or tokens.

Microsoft discovery, token, and signing-key requests reject HTTP redirects,
carry finite deadlines, and parse JSON only after enforcing response-byte
limits. Discovery metadata and JWKS documents are cached inside one runtime
database context for a bounded TTL. An unknown signing-key ID permits one
controlled JWKS refresh for key rollover. Concurrent cache fills and rollover
checks share one in-flight request per complete cache key; rejected requests
are removed so a later sign-in can retry, while generations prevent an older
response from replacing newer key material. A missing key receives its own
short, bounded retry cooldown rather than inheriting the positive document TTL,
allowing recently propagated keys to become available without request
amplification. Both document caches and per-key cooldown state have fixed
cardinality bounds, with expired and least-recently-used inactive entries
pruned while active requests remain protected. A new distinct cache key fails
with a bounded provider-unavailable error when every admitted slot is active;
it never starts an untracked overflow request. Cache tuples use structural JSON
encoding, so delimiter-bearing URL components cannot alias another tenant,
endpoint, configuration, or missing-key state. Malformed metadata, token JSON, JWT
objects, NumericDate claims, audience shapes, and matching JWK entries fail
with bounded provider errors rather than escaping as runtime type errors.

Provider identity is stored separately from the Sporades user. A verified
`(provider, subject)` pair identifies the Provider identity; provider email,
display name, and picture are nullable, mutable profile attributes and are not
identity keys. A single Sporades user may have multiple Provider identities.
Linking a new identity to an Anonymous session preserves that session's
Sporades user ID. Resolving an existing identity moves the current Anonymous
Session to its existing user while retaining the established anonymous
preference merge behavior.

Authentication provenance belongs to the Session rather than the shared user.
Each authenticated Session records the provider used for that Session, so
linking another Provider identity cannot rewrite the provider reported by
already-authenticated Sessions for the same user. Existing Session tokens and
Sporades user IDs survive the additive storage migration. The historical
`sporades_auth_users.provider` value remains only as migration input for old
databases; new linking and profile updates do not mutate it, and runtime
identity or Session decisions never read it after Session provenance has been
backfilled. New user rows write the constant `anonymous` migration marker
required by the legacy non-null schema; selected provider values live only on
Provider identities, Sessions, and other provenance-bearing records. The
runtime adapter no longer exposes a provider-and-email user lookup, and email
credential reads exclude the legacy column. Legacy Google rows
are claimed by the next verified Google subject during a compatibility window
only when Google reports the matching email as verified and exactly one
eligible legacy identity matches it. Unverified or ambiguous legacy matches
fail closed. New and claimed identities are subsequently resolved only by
stable subject.

An authenticated user cannot claim a Provider identity owned by another user.
That attempt returns a structured `AUTH_IDENTITY_CONFLICT`, and identity,
account, Session, and preference writes remain unchanged inside the Auth
transaction.

This issue does not add a general auth dependency. The existing runtime already owns anonymous sessions in SQLite, and the v2 requirement is a narrow provider-linking flow with a small public surface. Keeping the implementation in Sporades-owned tables avoids exposing provider SDKs or Better Auth internals to app code while preserving a future path to replace the internals behind the same `auth.signIn(provider)` client API.

Provider secrets remain in Server env. `sporades.json` stores the env var names, not secret values. The runtime reads the configured client ID and client secret from Server env during code exchange.

The provider-neutral configuration supports Anonymous, Email, Google,
Microsoft, Apple, and Facebook. Each provider reports enabled, configured, and
runtime-available states independently; a provider can therefore be fully
configured before its runtime protocol adapter is available. Updating one
provider merges it into the existing provider map and preserves siblings.
Facebook is runtime-available only when enabled, its App ID and App Secret env
entries are present, and its configured Graph version is supported.
When `graphVersion` is genuinely absent it is normalized once to `v23.0`, which
is then reported consistently by CLI status, runtime status, and client provider
state. An explicitly supplied invalid value never enters that defaulting path.

Legacy `auth.mode: "google"`, `auth.google`, and the top-level Google status
field are compatibility shims only. Normalization immediately maps them into
the common provider map, and runtime dispatch, callback completion, error
shaping, identity linking, and Session work continue through the same
provider-neutral seams as every other OAuth provider.

Production OAuth protocol endpoints are fixed by the built-in adapters.
Google and Apple endpoint overrides are admitted only when the process-only
`SPORADES_OAUTH_TEST_ENDPOINTS=1` seam is enabled and the replacement URL is an
exact IPv4 or IPv6 loopback URL without credentials or a fragment. Facebook
and Microsoft retain equally bounded process-only protocol test seams.
`sporades.json` and Server env cannot select production OAuth endpoints.
The shared Google/Apple token exchanger refuses redirects, applies one bounded
deadline across headers and body streaming, caps the response before JSON
allocation, and cancels and releases failed response readers. Status,
timeout, malformed, and oversized failures retain provider-owned safe messages
and codes without reflecting response bodies, authorization codes, or client
credentials.
Google and Apple signing-key loads use the same transport boundary: redirects
are refused, one finite deadline covers headers and streamed bodies, responses
are capped at 64 KiB before parsing, and failed readers are cancelled and
released. Network, HTTP, redirect, and timeout failures remain
`OAUTH_ID_TOKEN_KEYS_UNAVAILABLE`; malformed and oversized key documents remain
`OAUTH_ID_TOKEN_KEYS_INVALID`. The process-only provider test seam accepts exact
IPv4 or IPv6 loopback hosts, including URL-normalized `[::1]`, while rejecting
credentials and near-loopback or non-loopback hosts.

Durable Jobs capture provider provenance from the exact handler context at
enqueue time in `actorProvider`. Execution, retries, and restarts replay that
captured value rather than consulting another active Session or the user row.
Jobs created before this column existed migrate to the bounded `anonymous`
fallback. Privileged Jobs continue to use the reserved privileged actor branch.

Google OAuth can be configured either with explicit values:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

or from a downloaded Google OAuth client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

The JSON parser is provider-specific: Google reads Web application credentials,
Microsoft reads client ID, client secret, and tenant, Apple reads Services ID,
Team ID, Key ID, and private key, and Facebook reads app ID, app secret, and an
optional Graph version. All parsers remain behind the same `--client-json`
provider configuration seam. The seam validates JSON object shape and required
string fields before extracting values. Multiline Apple PEM values are escaped
reversibly into a single Server env entry.

Apple callbacks are never advertised as localhost or plain HTTP. Status exposes
the stable `/__sporades/auth/apple/callback` path and directs operators to
register it on the Capsule's Hosted HTTPS origin or an HTTPS development
tunnel; `callbackUrl` remains null until an eligible HTTPS origin is known.

Provider configuration and Server env changes use a shared same-directory file
transaction. Every replacement is fully staged before target mutation, commits
through atomic rename, and retains bounded recovery evidence if independent
restores do not all succeed.

The transaction rejects duplicate absolute lexical identities before inspection
or staging, including dot and parent-segment aliases. It deliberately does not
resolve symlinks, hard-link inode aliases, or filesystem-specific case folding:
generic callers must provide canonical non-symlink paths, must not repeat an
inode through hard links, and must use canonical filesystem case. The auth
workflow uses fixed `sporades.json` and `.env.sporades.server` targets satisfying
that boundary for normal project files.

After `sporades auth set <provider>`, any running dev session must be restarted.
The dev session loads Server env and auth configuration at startup, so a restart
is required before redirect and code-exchange behavior reflects the new
credentials.
