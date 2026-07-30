# 06 — Sign in and register with Facebook

**What to build:** Let a Capsule visitor choose Facebook, complete a server-owned authorization-code and profile flow, and return as a Linked account identified by Facebook's stable provider ID. Sign-in remains valid when Facebook does not return an email address.

**Blocked by:** 02 — Deepen runtime-owned OAuth behind a provider seam; 03 — Configure providers without replacing enabled siblings.

**Status:** ready-for-agent

- [ ] Operators can configure the Facebook App ID and App Secret without exposing secret values.
- [ ] Facebook appears in runtime provider availability and generated sign-in controls only when enabled and fully configured.
- [ ] Sign-in uses a full-page authorization-code flow, exact registered callback URI, opaque state, and the minimum profile permissions needed for login.
- [ ] The runtime exchanges the code server-side and obtains profile information through an explicitly supported, versioned Meta Graph interface.
- [ ] The returned Facebook provider ID is required and used as the stable Provider identity subject.
- [ ] Missing, declined, or unavailable email does not prevent sign-in; email, name, and picture remain optional profile attributes.
- [ ] First sign-in links Facebook to the current Anonymous Sporades user, while a returning Facebook identity resolves its existing Sporades user.
- [ ] `ctx.auth`, client auth reads, auth subscriptions, sign-out, preferences, and Journey retirement observe the resulting Facebook-authenticated Session consistently.
- [ ] Cancellation, app development-mode restrictions, permission denial, redirect mismatch, exchange failure, Graph errors, missing provider ID, identity conflict, and downstream Auth transaction failure produce structured safe outcomes.
- [ ] Provider tokens and raw Graph error bodies are absent from client messages, persisted auth profile data, normal logs, and inspection output.
- [ ] Protocol-faithful integration tests and a real browser redirect tracer prove Facebook sign-in without importing a Facebook SDK into Capsule client code.
- [ ] App registration, supported Graph version, permissions, callback setup, development/live mode, testing, and troubleshooting are documented.
