# 05 — Sign in and register with Apple

**What to build:** Let a Capsule visitor choose Apple from an HTTPS origin, complete Apple's server-owned web authorization flow, and return as a Linked account. Sporades handles Apple's form-post callback, generated client credential, first-authorization profile data, verified identity, and normal Anonymous-account linking.

**Blocked by:** 02 — Deepen runtime-owned OAuth behind a provider seam; 03 — Configure providers without replacing enabled siblings.

**Status:** ready-for-agent

- [ ] Operators can configure the Apple Services ID, Team ID, Key ID, and private-key reference without placing private-key material in project configuration or normal output.
- [ ] Sporades generates Apple's short-lived client-secret JWT at runtime from Server env material and never writes the generated secret to normal logs or client responses.
- [ ] Apple appears in runtime provider availability and generated sign-in controls only when enabled, fully configured, and the effective public origin can satisfy Apple's callback requirements.
- [ ] Plain HTTP, IP-address, and localhost Dev origins reject Apple sign-in before redirect with actionable guidance to use an HTTPS domain, tunnel, or Hosted Capsule.
- [ ] Authorization requests use state, nonce, the configured Services ID, the exact HTTPS callback URI, and only the name and email scopes needed for sign-in.
- [ ] The runtime accepts Apple's form-post success and cancellation responses with bounded body parsing and consumes state before downstream completion.
- [ ] Code exchange verifies the Apple identity token's signature, issuer, audience, expiry, nonce, and stable subject before creating a Provider identity.
- [ ] Apple's first-authorization name payload is validated, sanitized, and persisted immediately; later sign-ins succeed when Apple no longer returns that name.
- [ ] Private-relay email, changed email, or absent email for a managed Apple account does not replace the stable Apple subject as the identity key.
- [ ] First sign-in links Apple to the current Anonymous Sporades user, while a returning Apple identity resolves its existing Sporades user.
- [ ] `ctx.auth`, client auth reads, auth subscriptions, sign-out, preferences, and Journey retirement observe the resulting Apple-authenticated Session consistently.
- [ ] Cancellation, invalid client credential, redirect mismatch, token verification failure, identity conflict, and downstream Auth transaction failure produce structured safe outcomes with spent OAuth state.
- [ ] Protocol-faithful integration tests plus an HTTPS browser tracer prove the form-post flow without importing Apple JS into Capsule code.
- [ ] Services ID, website association, callback, private-key, private-relay, HTTPS development, and troubleshooting requirements are documented.
