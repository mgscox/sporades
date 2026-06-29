Status: done

# Local Identity Simulation Session Creation

## What to build

Add a local-dev-only identity simulation command so agents can ask the running Sporades dev server to create or resolve a simulated linked identity and return the normal localStorage session payload used by the SDK.

This is not real provider auth and should not accept arbitrary JWTs. It is a controlled way to seed browser/session state for local testing.

This should be a test-driven design task. Start with the CLI/server interaction returning a session payload, then add provider variants and error cases.

## Acceptance criteria

- [x] `sporades auth as <provider> ... --json` works against a running local dev server and returns `{ localStorage: { key, value }, auth }`.
- [x] The returned localStorage value is the same kind of session token the SDK already persists for normal auth refresh.
- [x] Simulated identities produce normal `ctx.auth` values, including user ID, provider, authenticated state, email, and display name where provided.
- [x] The command supports at least an `email` simulated provider and leaves room for simulating Google identity without claiming to complete real OAuth.
- [x] The command refuses when it is not talking to a dev server that supports identity simulation.
- [x] Tests cover successful simulation, structured errors, and using the returned session token in a subsequent auth lookup.
- [x] Documentation clearly labels this as local identity simulation for agents and browser tests.

## Blocked by

- .scratch/sporades-auth-session-controls/issues/01-multi-provider-auth-configuration.md
