# 04 — Sign in and register with Microsoft

**What to build:** Let a Capsule visitor choose Microsoft, complete a server-owned OpenID Connect authorization-code flow, and return as a Linked account whose stable Microsoft identity populates normal Sporades auth state. First sign-in registers by linking to the current Anonymous account; later sign-ins resolve the same Sporades user.

**Blocked by:** 02 — Deepen runtime-owned OAuth behind a provider seam; 03 — Configure providers without replacing enabled siblings.

**Status:** done

- [x] Operators can configure Microsoft client credentials and select `common`, `organizations`, `consumers`, or a specific tenant without exposing secret values.
- [x] Microsoft appears in runtime provider availability and generated sign-in controls only when enabled and fully configured.
- [x] Sign-in uses the Microsoft identity platform's discovered OpenID Connect endpoints and a full-page authorization-code flow.
- [x] The authorization request and code exchange use PKCE, state, nonce, the exact callback URI, and only the identity scopes needed for sign-in.
- [x] Completion verifies the identity token's signature, issuer, audience, expiry, nonce, tenant context, and stable subject before creating a Provider identity.
- [x] Microsoft subject identity includes the issuer or tenant context required to prevent cross-tenant subject collision.
- [x] Missing or mutable email and username claims do not prevent sign-in when the verified stable subject is present.
- [x] First sign-in links Microsoft to the current Anonymous Sporades user, while a returning Microsoft identity resolves its existing Sporades user.
- [x] `ctx.auth`, client auth reads, auth subscriptions, sign-out, preferences, and Journey retirement observe the resulting Microsoft-authenticated Session consistently.
- [x] Cancellation, tenant rejection, consent requirements, invalid credentials, redirect mismatch, token verification failure, identity conflict, and downstream Auth transaction failure return structured safe outcomes.
- [x] Protocol-faithful integration tests and a real browser redirect tracer prove Microsoft sign-in without importing a Microsoft SDK into Capsule client code.
- [x] Provider setup, tenant selection, callback registration, testing, and troubleshooting are documented.
