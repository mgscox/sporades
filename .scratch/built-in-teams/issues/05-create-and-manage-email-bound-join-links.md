# 05 — Create and manage email-bound Join links

**What to build:** Let a Team admin create, inspect, list, and revoke a short-lived single-use Join link targeted to one normalized email address, while Sporades owns cryptographic validation and returns the link without sending any message.

**Blocked by:** 03 — Create and rename additional Teams.

**Status:** ready-for-agent

- [ ] Only a current admin of the named Team can create a Join link for it through the browser or trusted server Team interface.
- [ ] Join-link creation requires a syntactically valid email normalized consistently with existing Sporades email auth.
- [ ] Join-link creation accepts a bounded integer TTL, uses a documented safe default when omitted, and rejects values outside documented limits.
- [ ] The returned URL uses the runtime's canonical Capsule origin and a validated same-origin absolute Join path with a safe default.
- [ ] Request Host, forwarded-host, and origin headers cannot redirect a genuine Join link to another origin.
- [ ] Sporades returns the complete Join URL and expiry only at creation and never invokes mail delivery, Email-event dispatch, or provider callbacks.
- [ ] The opaque versioned Join code is cryptographically unforgeable, binds the grant identity and expiry, uses a runtime-owned persistent per-Capsule signing secret, and verifies secret material in constant time.
- [ ] Persistent state stores only non-recoverable verifier material plus Team, normalized target email, creator, creation, expiry, consumption, and revocation metadata.
- [ ] Complete Join codes and URLs are never recoverable from runtime storage, normal inspection, logs, errors, or active-link listing.
- [ ] An admin can list bounded active Join-link management metadata only for Teams they administer.
- [ ] An admin can revoke an unused Join link for their Team; revocation is idempotent and cannot affect another Team.
- [ ] Safe pre-auth inspection exposes only bounded Team presentation state, expiry, and general usability, never the full target email, creator identity, membership list, or verifier details.
- [ ] Creation is throttled per admin and Team, outstanding grants are capacity-bounded, and expiry pruning performs bounded work.
- [ ] Tampered, malformed, unknown, expired, revoked, and consumed codes cannot be treated as usable by inspection.
- [ ] Structured security events record bounded creation and revocation outcomes without Join secrets, target emails, Session tokens, provider subjects, or raw request payloads.
- [ ] Tests cover canonical URL construction, hostile headers, path validation, entropy and HMAC tampering, non-recoverable storage, expiry edges, throttling, capacity, pruning, cross-Team authorization, no-mail behavior, public types, and generated-runtime parity.
