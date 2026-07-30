# 06 — Sign in and register with Facebook

**What to build:** Let a Capsule visitor choose Facebook, complete a server-owned authorization-code and profile flow, and return as a Linked account identified by Facebook's stable provider ID. Sign-in remains valid when Facebook does not return an email address.

**Blocked by:** 02 — Deepen runtime-owned OAuth behind a provider seam; 03 — Configure providers without replacing enabled siblings.

**Status:** done

- [x] Operators can configure the Facebook App ID and App Secret without exposing secret values.
- [x] Facebook appears in runtime provider availability and generated sign-in controls only when enabled and fully configured.
- [x] Sign-in uses a full-page authorization-code flow, exact registered callback URI, opaque state, and the minimum profile permissions needed for login.
- [x] The runtime exchanges the code server-side and obtains profile information through an explicitly supported, versioned Meta Graph interface.
- [x] The returned Facebook provider ID is required and used as the stable Provider identity subject.
- [x] Missing, declined, or unavailable email does not prevent sign-in; email, name, and picture remain optional profile attributes.
- [x] First sign-in links Facebook to the current Anonymous Sporades user, while a returning Facebook identity resolves its existing Sporades user.
- [x] `ctx.auth`, client auth reads, auth subscriptions, sign-out, preferences, and Journey retirement observe the resulting Facebook-authenticated Session consistently.
- [x] Cancellation, app development-mode restrictions, permission denial, redirect mismatch, exchange failure, Graph errors, missing provider ID, identity conflict, and downstream Auth transaction failure produce structured safe outcomes.
- [x] Provider tokens and raw Graph error bodies are absent from client messages, persisted auth profile data, normal logs, and inspection output.
- [x] Protocol-faithful integration tests and a real browser redirect tracer prove Facebook sign-in without importing a Facebook SDK into Capsule client code.
- [x] App registration, supported Graph version, permissions, callback setup, development/live mode, testing, and troubleshooting are documented.
