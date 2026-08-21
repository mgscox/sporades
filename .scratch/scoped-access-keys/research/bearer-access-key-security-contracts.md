# Bearer Access-key security contracts

Date: 2026-08-20

## Question

Which primary-source security guidance should constrain Access-key entropy, wire format, lookup and hashing, constant-time verification, expiry, one-time disclosure, rotation, revocation, redaction, rate limiting, caching, and failure behaviour for Sporades' HTTP runtime?

## Scope and terminology

Sporades Access keys are opaque, user-owned credentials, not OAuth 2.0 access tokens. RFC 6750 is therefore not automatically normative for issuance, lifecycle, or scope semantics. Its `Authorization: Bearer` transport, threat model, and HTTP challenge conventions are nevertheless directly useful and are adopted below where stated. The capitalized **MUST**, **SHOULD**, and **MAY** terms in “Derived Sporades contract” are proposed Sporades requirements; they are not claims that an RFC directly governs Sporades.

The already-decided model remains intact: a key authenticates its linked, non-guest owner; immutable grants only narrow that user's authority; a declarative `requireAuth` wrapper opts a Custom endpoint into key admission; malformed or invalid key material never downgrades to Session or Anonymous; key metadata is immutable except for atomic secret rotation and terminal revocation; and work already admitted may proceed.

## Primary-source findings

### Bearer transport and TLS

- RFC 6750 requires OAuth bearer clients to use no more than one token transport per request, defines `Authorization: Bearer <b64token>`, recommends the Authorization header, and requires OAuth resource servers to support it ([RFC 6750 sections 2 and 2.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-2)). Its `b64token` alphabet permits letters, digits, `-`, `.`, `_`, `~`, `+`, `/`, and trailing `=`.
- The URI-query transport is specifically discouraged because URLs containing tokens are likely to be logged ([RFC 6750 section 2.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.3)). Sporades should not support query-string or form-body Access keys.
- Bearer possession is authority: RFC 6750 requires TLS confidentiality and integrity protection and identifies disclosure and replay as core threats ([RFC 6750 sections 5.1–5.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-5)). A bearer reference must be infeasible to guess, and token integrity must prevent modification ([RFC 6750 section 5.2](https://www.rfc-editor.org/rfc/rfc6750.html#section-5.2)).

### Entropy and generation

- Statistical appearance is not enough; the security property is unpredictability backed by sufficient input entropy ([RFC 4086 sections 2 and 3](https://www.rfc-editor.org/rfc/rfc4086.html#section-2)). Node's `crypto.randomBytes()` generates cryptographically strong pseudorandom bytes and fails if generation cannot be completed ([Node.js `crypto.randomBytes`](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback)).
- No cited standard dictates one exact API-key length. A 32-byte uniformly random verifier supplies 256 bits of search space and is comfortably above the “infeasible to guess” requirement. A separate 16-byte random selector supplies a 128-bit non-enumerable lookup space. Those sizes are a Sporades design choice derived from the sources, not an RFC mandate.

### Opaque lookup and verifier storage

- RFC 6750 explicitly permits an opaque bearer reference resolved by the server, provided the reference is infeasible to guess ([RFC 6750 section 5.2](https://www.rfc-editor.org/rfc/rfc6750.html#section-5.2)). This supports a selector-plus-verifier credential rather than a self-contained authority token.
- A uniformly random 256-bit verifier does not have a human-password dictionary problem. A slow password KDF is therefore unnecessary for offline guessing resistance and would add attacker-controlled CPU/memory cost to every request. Node describes `scrypt` specifically as a password-based, deliberately expensive KDF ([Node.js `crypto.scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)). This conclusion is an engineering inference from the verifier's entropy, not a direct standard requirement.
- Node provides SHA-256 hashing/HMAC primitives and a constant-time byte comparison. `timingSafeEqual` requires equal-length buffers and warns that surrounding code can still introduce timing leaks ([Node.js `crypto.createHash`, `crypto.createHmac`, and `crypto.timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)).

### Lifecycle and disclosure

- OWASP's Secrets Management guidance treats creation, rotation, revocation, and expiration as the secret lifecycle; recommends cryptographically robust generation, automated rotation, rapid revocation after exposure, and expiration where possible ([OWASP Secrets Management: lifecycle](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html#27-secret-lifecycle)).
- One-time display is established first-party practice for long-lived API keys: Stripe displays live secret keys once and requires rotation or replacement if lost ([Stripe API keys: live-mode key access](https://docs.stripe.com/keys#live-mode-key-access)). This is supporting operational precedent, not a normative standard.
- OWASP says plaintext secrets should exist only as briefly as possible and must never be logged; compromised secrets should be revoked promptly and rotated through a repeatable process ([OWASP Secrets Management: implementation and incident response](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html#6-implementation-guidance)).

### Redaction and audit

- OWASP explicitly lists access tokens, session identifiers, passwords, encryption keys, and primary secrets as values that should not be logged directly; they should be removed, masked, sanitized, hashed, or encrypted ([OWASP Logging: data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)).
- OWASP separately recommends auditing who requested, used, rotated, expired, or revoked a secret, along with authentication and authorization errors ([OWASP Secrets Management: auditing](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html#26-auditing)). The useful audit identity is therefore the durable Access-key ID and admission-time name, never the bearer value.

### Rate limiting

- OWASP recommends requiring an API key on every protected request, returning `429 Too Many Requests` for excessive rates, and supporting revocation ([OWASP REST Security: API keys](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#api-keys)).
- RFC 6585 defines `429` for rate limiting, permits `Retry-After`, deliberately leaves identification and counting policy to the server, and prohibits caching a 429 response ([RFC 6585 section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)). No primary source supplies universally correct thresholds; those must be operator-configurable and verified under load.

### Caching

- A shared cache must not reuse a response to a request containing `Authorization` unless the response explicitly enables shared caching with an applicable directive ([RFC 9111 section 3.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-3.5)). This does not prevent a private cache from storing the response.
- `Cache-Control: no-store` directs private and shared caches not to store any part of the request or response, although RFC 9111 cautions that it is not a complete privacy mechanism ([RFC 9111 section 5.2.2.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5)). RFC 6750's sample token response uses `Cache-Control: no-store` and `Pragma: no-cache` ([RFC 6750 section 4](https://www.rfc-editor.org/rfc/rfc6750.html#section-4)).

### Status and challenge semantics

- HTTP requires a `WWW-Authenticate` challenge on every `401 Unauthorized`. Invalid or missing credentials should produce 401, while valid but inadequate credentials ought to produce 403 ([RFC 9110 sections 11.4, 11.6.1, 15.5.2, and 15.5.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-11.4)).
- OAuth Bearer further recommends `401` plus `invalid_token` for expired, revoked, malformed, or otherwise invalid tokens, and `403` plus `insufficient_scope` for valid tokens with insufficient scope. A missing credential gets a bare Bearer challenge without an error code ([RFC 6750 sections 3 and 3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3)). It recommends `400 invalid_request` for malformed OAuth requests, but Sporades has already chosen the simpler opaque `401 UNAUTHENTICATED` contract for malformed Access-key credentials. That is a deliberate non-OAuth choice.

## Derived Sporades contract

### 1. Wire credential

The single accepted wire form **MUST** be:

```text
Authorization: Bearer spk_1_<selector>_<verifier>
```

- `selector` **MUST** be 16 bytes from `crypto.randomBytes(16)`, base64url encoded without padding (22 characters).
- `verifier` **MUST** be 32 independently generated bytes from `crypto.randomBytes(32)`, base64url encoded without padding (43 characters).
- The parser **MUST** accept exactly the fixed prefix/version and exact segment lengths, and **MUST** reject control characters, padding, extra segments, multiple Authorization fields, comma-combined credentials, and every non-base64url character before storage lookup.
- The authentication scheme comparison follows HTTP's case-insensitive scheme rules; the credential value remains case-sensitive.
- Query parameters, cookies, and request bodies **MUST NOT** carry a Sporades Access key.
- `spk_1_` is a versioned, recognizable prefix for validation and secret-scanning. Version changes **MUST** be explicit; parsers must not “best effort” unknown versions.
- Production Access-key transport **MUST** be confined to an authenticated TLS connection. A deployment behind a TLS terminator **MUST** establish a trusted configuration for the terminating hop rather than trust arbitrary forwarded headers. Local loopback development may be an explicitly documented exception.

The selector is not treated as the authenticating secret, but its 128-bit randomness prevents practical enumeration and lets the database locate one candidate without scanning all keys. The verifier is the bearer secret.

### 2. Storage and verification

- Sporades **MUST NOT** persist the plaintext verifier or complete wire token.
- The record **MUST** store the selector under a unique index and a fixed-size verifier digest. The v1 digest is SHA-256 over an unambiguous, domain-separated byte encoding of version, selector, and verifier, for example `SHA256("sporades-access-key-v1\0" || selectorBytes || verifierBytes)`.
- A server-side HMAC key is defense in depth, not required for v1: 256 bits of independent verifier entropy already makes offline search after a database-only compromise infeasible. Introducing an HMAC pepper would add a separately provisioned, rotatable Host secret and recovery obligations; that should be a conscious later storage decision, not theatre sprinkled into the schema.
- Authentication **MUST** strictly parse first, perform one indexed selector lookup, calculate a 32-byte candidate digest, and compare it with the stored digest using `timingSafeEqual` over equal-length buffers.
- For a well-formed but unknown selector, the verifier path **SHOULD** still calculate and compare against a process-held dummy 32-byte digest. This reduces an obvious early-exit signal but does not claim to make database existence timing perfectly uniform.
- Lifecycle, owner eligibility, and scope checks **MUST** occur only after verifier comparison and **MUST** converge on the agreed opaque public failures. Internal diagnostics may distinguish reasons without including token material.
- Parsing and header-size bounds **MUST** execute before database or cryptographic work.

### 3. Issuance, expiry, rotation, and revocation

- Issuance and rotation **MUST** return the complete token exactly once over the authenticated owner/operator response. Later reads return metadata only.
- Issuance and rotation responses **MUST** include `Cache-Control: no-store`; compatibility clients may also receive `Pragma: no-cache`.
- Plaintext **MUST** be discarded after constructing the response and **MUST NOT** enter database fields, events, exceptions, traces, analytics, fixtures, or snapshots.
- Expiry remains an optional, immutable issuance field. A supplied expiry **MUST** be a valid instant later than issuance. Admission fails once `now >= expiresAt`; expiry is terminal and cannot be extended. Security documentation **SHOULD** recommend the shortest practical lifetime, without imposing an unsuitable universal maximum on automation keys.
- Rotation **MUST** atomically replace both selector and verifier digest while preserving the Access-key ID, owner, name, grants, and expiry. At commit there is exactly one current secret; the old credential must fail all later admissions. There is no grace overlap.
- Revocation **MUST** be terminal, idempotent, and effective for every admission beginning after the revocation commit. It does not retroactively cancel work whose credential and scopes already passed admission.
- Suspected disclosure **SHOULD** lead to immediate revocation or rotation. A rate-limit event alone **MUST NOT** automatically revoke or lock a key, because an attacker who knows a selector could otherwise cause owner-visible denial of service.

### 4. Redaction, telemetry, and audit

- The complete `Authorization` field **MUST** be redacted at the earliest shared HTTP logging/tracing boundary, before Capsule middleware, error serialization, diagnostics, request dumps, and third-party telemetry.
- Code **MUST NOT** log the complete token, verifier, verifier digest, selector, prefix-plus-fragment, or “last four” token characters. Successful audit records use immutable key ID plus the admission-time name snapshot and owner user ID. Failed attempts use bounded reason categories, route identity, time, and a privacy-reviewed source bucket—not attacker-controlled token text.
- Secret-bearing issuance responses **MUST** be excluded from generic body capture. Exception objects and validation errors **MUST NOT** echo the supplied header.
- Sporades **SHOULD** audit issuance, successful rotation, revocation, expiry-use attempts, authentication failures, authorization failures, and operator actions. Audit storage requires tamper resistance and retention policy, but exact retention is outside this ticket.

### 5. Rate limiting

- Admission **MUST** have a source-level failure limiter that runs before unbounded database/crypto work and a second limiter keyed by the parsed selector (or a non-reversible bounded fingerprint of it). Both gates must permit the request.
- Successfully admitted request quotas are not part of Access-key authentication. Capsules or Host operators may impose them independently when their workload needs one; Sporades does not infer a usage policy from possession of a key.
- A limited request returns `429 Too Many Requests`, may include `Retry-After`, uses the same opaque public representation for known and unknown selectors, and **MUST** include `Cache-Control: no-store`.
- Limiters **MUST** have bounded memory/cardinality and must not use raw bearer values as keys or labels. Thresholds, windows, proxy-aware source derivation, and distributed coordination remain operator policy because the standards intentionally do not define them.

### 6. Caching

- Issuance, rotation, `401`, `403`, and `429` responses from Access-key admission **MUST** include `Cache-Control: no-store`.
- A successfully Access-key-authenticated response **SHOULD** default to `Cache-Control: private, no-store` unless the Capsule explicitly supplies a stricter or intentionally cacheable policy. Sporades **MUST NOT** synthesize `public`, `s-maxage`, or another shared-cache-enabling directive.
- If the product chooses to let a Capsule explicitly enable caching, the implementation must test identity separation and RFC 9111 Authorization handling. This is an application decision; the default merely prevents an accidental private-cache copy.

### 7. Public failures

| Condition | HTTP | Public code | Challenge |
|---|---:|---|---|
| Missing credential on an opted-in handler | 401 | `UNAUTHENTICATED` | `WWW-Authenticate: Bearer realm="sporades"` |
| Malformed, unknown, expired, revoked, rotated-away, ineligible-owner, or otherwise invalid key | 401 | `UNAUTHENTICATED` | `Bearer realm="sporades", error="invalid_token"` with no description |
| Simultaneous Session and Access-key credentials | 401 | `UNAUTHENTICATED` | Same opaque invalid-token challenge |
| Valid admitted credential kind excluded by the guard | 403 | `FORBIDDEN` | No challenge required |
| Valid Access key missing a required scope | 403 | `FORBIDDEN` | No required-scope list and no descriptive challenge |
| Admission rate limited | 429 | existing opaque rate-limit code | Optional `Retry-After`; no credential details |

Every 401 **MUST** carry a Bearer challenge to satisfy HTTP. Sporades adopts RFC 6750's `invalid_token` category but omits `error_description`, key state, owner state, name, ID, and scope data. It deliberately does not emit `insufficient_scope` or the required `scope` publicly, preserving the previously agreed opaque 403 contract. Detailed reason categories are platform diagnostics only.

An unwrapped endpoint does not invoke this contract: it does not parse an Access-key-looking Authorization value, and the Capsule retains ownership of its own Bearer/webhook schemes. Once wrapped admission is active, invalid Access-key material cannot fall back to a valid Session or Anonymous context.

## Security properties and limits

- Database-only compromise reveals metadata, selectors, and verifier digests, but not usable credentials; 256-bit random verifiers resist offline enumeration.
- Host-process compromise can observe live bearer values and any optional HMAC key, so hashing at rest is not a substitute for runtime isolation, TLS, redaction, or revocation.
- A bearer token can always be replayed by a party that steals it. Scopes, expiry, rotation, rate limiting, and monitoring reduce impact but do not provide proof of possession.
- Constant-time digest comparison narrows one oracle; it cannot equalize network, parser, database, lifecycle, or rate-limit timing by itself.

## Unresolved implementation choices

These are appropriately deferred to the storage/operations tickets:

1. Whether v1 uses plain SHA-256 as recommended or introduces a Host-managed HMAC pepper with an explicit rotation and disaster-recovery design.
2. Exact limiter thresholds/windows, trusted-proxy source derivation, distributed-store semantics, and metric cardinality budgets.
3. The stable production `realm` value if `sporades` is not sufficiently deployment-specific.
4. Whether successful Capsule responses may explicitly opt out of the safe `private, no-store` default, and the exact API for doing so.
5. Audit retention, alert thresholds, and privacy treatment of source network identifiers.

## Current Sporades seams to carry forward

These are observations from the current checkout, not implemented Access-key support:

- The runtime-owned Reset-code module already demonstrates the intended deep storage seam: a 16-byte selector, 32-byte verifier, stored SHA-256 verifier digest, indexed lookup, dummy digest for an unknown selector, equal-length `timingSafeEqual`, one-time disclosure, expiry, and opaque invalid/expired failure ([`auth-runtime.ts`](../../../src/auth-runtime.ts)). Access keys should reuse the invariant, not necessarily the Reset-code record or interface.
- Session tokens already use 32 bytes from `crypto.randomBytes`, but current Session lookup stores and queries the plaintext token. Access keys must not copy that storage representation merely because the entropy source is suitable ([`auth-runtime.ts`](../../../src/auth-runtime.ts)).
- The shared log policy already marks authorization, token, secret, cookie, and related field names as sensitive. Access-key tests must extend proof across raw HTTP header ingestion, errors, issuance results, and generated/runtime surfaces rather than inventing a second redactor ([`runtime-log-policy.ts`](../../../src/runtime-log-policy.ts)).
- The current Custom-endpoint error writer maps `UNAUTHENTICATED` to 401 but has no `FORBIDDEN` mapping, emits no `WWW-Authenticate`, and applies no general `no-store` policy. Later implementation must change the shared HTTP seam so 403 does not fall through to 500 and every Access-key 401 carries a challenge ([`http-runtime.ts`](../../../src/http-runtime.ts)).

## Primary sources

- [RFC 6750 — OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 6585 — Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585.html)
- [RFC 4086 — Randomness Requirements for Security](https://www.rfc-editor.org/rfc/rfc4086.html)
- [Node.js Crypto documentation](https://nodejs.org/api/crypto.html)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- [Stripe API keys documentation](https://docs.stripe.com/keys)
