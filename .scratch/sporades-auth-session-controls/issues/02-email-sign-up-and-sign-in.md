Status: done

# Email Sign-Up And Sign-In

## What to build

Add a client-facing `email` auth provider so app code can sign users up and sign users in with email/password while Sporades continues to own all server-side auth handling. App code should see this as `auth.signUp("email", ...)` and `auth.signIn("email", ...)`; it should not depend on Better Auth internals.

This should be a test-driven design task. Start with one end-to-end behavior through the public SDK or WebSocket protocol, make it pass, then add the next behavior.

## Acceptance criteria

- [ ] The SDK exposes `auth.signUp("email", { email, password, name? })` and returns a structured pass/fail result.
- [ ] The SDK supports `auth.signIn("email", { email, password })` and returns a structured pass/fail result.
- [ ] Successful email auth creates or resolves a normal Sporades session and populates `ctx.auth` with `provider: "email"`, authenticated state, email, and display name where available.
- [ ] Failed sign-up and sign-in attempts return structured JSON errors with actionable hints and do not crash the dev session.
- [ ] Google redirect sign-in continues to work through the same provider-generic sign-in surface.
- [ ] Tests cover sign-up, sign-in, failed credentials, SDK result shape, and server-side `ctx.auth` behavior.
- [ ] Documentation explains the public `email` provider API without exposing server auth implementation details.

## Blocked by

- .scratch/sporades-auth-session-controls/issues/01-multi-provider-auth-configuration.md

## Comments

- Implemented email sign-up and sign-in through the provider-generic SDK/WebSocket auth surface. Added runtime tests for successful sign-up, duplicate email, failed credentials, sign-in, and `ctx.auth` population.
