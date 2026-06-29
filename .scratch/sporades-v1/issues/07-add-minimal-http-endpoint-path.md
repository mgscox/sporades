# Add a minimal HTTP endpoint path

Status: done

## What to build

Introduce the smallest useful `endpoint()` API so a Capsule can expose a custom HTTP route for integrations that cannot use WebSockets. This slice should prove that endpoint definitions are registered by `capsule()`, routed by the server runtime, and callable in both Dev sessions and Container sessions.

## Acceptance criteria

- [ ] `endpoint()` can be imported from `sporades/server` and registered in a Capsule definition.
- [ ] A Capsule can expose a custom HTTP route with an explicit method and path.
- [ ] The server runtime routes matching HTTP requests to the registered endpoint handler.
- [ ] Non-matching requests continue to use the existing Sporades HTTP behavior.
- [ ] The endpoint path works in both Dev sessions and Container sessions.
- [ ] Endpoint handler failures produce structured server errors without crashing the session.

## Blocked by

None - can start immediately
