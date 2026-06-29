# Sporades Auth Session Controls

## Overview

This work extends Sporades auth beyond the current anonymous and Google OAuth flow by adding email/password authentication, SDK sign-out, and local identity simulation for agent-driven browser testing.

The design keeps the existing trust boundary: Sporades owns auth on the server, app clients call the Sporades SDK, and app developers never interact with Better Auth, provider SDKs, OAuth internals, or raw WebSocket plumbing.

## Goals

- Add a client-facing `email` auth provider for email/password sign-up and sign-in.
- Add `auth.signOut()` with a pass/fail result so apps can route after logout.
- Support multi-provider auth configuration while preserving existing `auth.mode` compatibility.
- Add local-only identity simulation so agents can seed browser sessions without navigating through login UI.
- Allow identity simulation to update connected browser clients by sending an internal SDK-owned session replacement message.
- Let agents list connected auth clients before selecting a browser session to seed.

## Non-Goals

- Do not expose Better Auth directly to app code.
- Do not make deployed apps accept identity simulation commands.
- Do not accept arbitrary JWTs for simulated identity in this iteration.
- Do not let app code spoof internal auth session replacement messages.
- Do not add production user-management UI.

## Desired SDK Shape

```ts
await auth.signUp("email", { email, password, name });
await auth.signIn("email", { email, password });
await auth.signIn("google");
await auth.signOut();
```

All calls should return structured pass/fail results that app code can use for routing and error display.

## Identity Simulation

Agents should be able to ask a running local dev server to simulate a linked identity and seed an open browser client with the normal Sporades session token stored in localStorage.

Example:

```sh
sporades auth as email --email alice@example.test --name "Alice" --client current --json
```

The command should create or resolve a normal server-owned simulated session, return the localStorage key/value needed by the SDK, and optionally deliver that session to connected client(s) through an internal WebSocket message that the SDK handles.

Identity simulation is a local dev testing feature, not an auth bypass for deployed apps.
