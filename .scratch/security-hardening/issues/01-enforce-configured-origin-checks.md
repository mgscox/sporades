Status: done

# Enforce Configured Origin Checks For HTTP And WebSocket Transport

## What to build

Make Sporades-owned HTTP CORS checks and WebSocket upgrade checks use the same configured-origin authority. Hosted Capsules should accept browser origins that match the configured Hosted Capsule public origin, while local Dev and Public Dev keep their existing localhost-oriented ergonomics. Client-supplied forwarded headers must not be enough to satisfy same-origin checks unless they match the configured hosted authority.

## Acceptance criteria

- [ ] Hosted Capsule HTTP requests only receive CORS approval when `Origin` matches the configured public Capsule origin or explicitly configured allowed origins.
- [ ] Hosted Capsule WebSocket upgrades reject missing or cross-site `Origin` values before activating the client transport.
- [ ] Client-supplied `X-Forwarded-*` headers cannot make an attacker origin pass same-origin checks unless the resulting authority matches the configured Hosted Capsule origin.
- [ ] Local Dev localhost and explicit Public Dev behavior continue to work as documented.
- [ ] Regression tests cover HTTP CORS and WebSocket upgrade rejection for spoofed forwarded headers and cross-site origins.

## Blocked by

None - can start immediately
