Status: ready-for-agent

# Push Simulated Sessions To Connected Clients

## What to build

Extend local identity simulation so `sporades auth as ... --client current|all` can seed already-connected browser clients without navigating through login UI. The dev server should deliver an internal auth session replacement message over the existing client transport, and the SDK should update localStorage and auth state.

This should be a test-driven design task. Build the smallest demonstrable connected-client delivery path first, then add targeting and failure behavior.

## Acceptance criteria

- [ ] `sporades auth as ... --client current` delivers the simulated session to the most recently connected client for the app.
- [ ] `sporades auth as ... --client all` delivers the simulated session to all connected clients for the app.
- [ ] The SDK handles the internal session replacement message by writing the normal localStorage session token and refreshing app-facing auth state.
- [ ] App code cannot spoof or subscribe to the internal auth session replacement message as a normal app message.
- [ ] The CLI reports whether delivery succeeded and still returns the localStorage fallback payload in JSON output.
- [ ] Tests cover current-client delivery, all-client delivery, no-connected-client behavior, and auth state after replacement.
- [ ] Documentation shows how agents can switch browser users without navigating through login screens.

## Blocked by

- .scratch/sporades-auth-session-controls/issues/04-local-identity-simulation-session-creation.md
