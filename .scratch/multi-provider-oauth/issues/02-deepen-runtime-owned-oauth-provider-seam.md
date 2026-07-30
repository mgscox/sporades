# 02 — Deepen runtime-owned OAuth behind a provider seam

**What to build:** Route the existing Google full-page sign-in through one runtime-owned OAuth module whose small interface can support multiple provider adapters. Sporades continues to own authorization, callbacks, token verification, identity extraction, Linked-account resolution, and Session updates while app code only expresses provider sign-in intent.

**Blocked by:** 01 — Establish stable Provider identities and Session provenance.

**Status:** done

- [x] The browser-facing interface remains provider-generic and existing `auth.signIn("google")` callers require no changes.
- [x] One runtime-owned OAuth flow selects an enabled provider adapter, starts authorization, completes callbacks, produces a verified Provider identity, and passes that identity to common linking behavior.
- [x] Callback routing supports provider-specific paths and both query and form-post responses without exposing callback mechanics to Capsule code.
- [x] OAuth state records the provider, current Session token, safe return location, exact redirect URI, creation and expiry times, plus nonce or PKCE material where the provider supports it.
- [x] Callback handling rejects missing, expired, replayed, or provider-mismatched state before linking an identity.
- [x] Consumed OAuth state remains spent after cancellation, exchange failure, verification failure, linking failure, or Session failure so the user must restart OAuth.
- [x] Return locations remain restricted to the initiating origin.
- [x] Google authorization-code completion verifies the returned identity token's signature, issuer, audience, expiry, nonce, and stable subject before trusting profile claims.
- [x] Provider access, identity, authorization, or refresh tokens are not returned to clients, written to normal logs, or persisted beyond a provider-specific requirement.
- [x] Provider HTTP failures, cancellation, invalid callbacks, and misconfiguration produce bounded structured errors with actionable hints and no secret-bearing response bodies.
- [x] Protocol-faithful test providers exercise successful redirect completion, query and form-post callbacks, invalid tokens, state expiry and replay, provider confusion, safe return URLs, Auth transaction rollback, and generated Bundle parity.
- [x] Google completes a real full-page browser tracer through the new seam before the old Google-specific orchestration is considered superseded.
