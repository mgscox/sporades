# Add session expiry and rotation controls

Status: done

## What to build

Add lifecycle controls for Sporades session tokens so anonymous, email-linked, Google-linked, and locally simulated sessions are not immortal. Sessions should have clear expiry metadata, expired sessions should resolve safely, and sign-in/sign-up flows should rotate or refresh tokens in a predictable way.

This slice should keep the client SDK behavior simple: apps still receive normal auth state, but stale tokens should stop silently granting access forever.

## Acceptance criteria

- [ ] Session records store expiry or equivalent lifecycle metadata.
- [ ] Expired session tokens no longer authenticate as the linked user.
- [ ] The client auth flow recovers from an expired token by receiving a fresh anonymous session.
- [ ] Email and Google sign-in/sign-up flows rotate or refresh session tokens according to documented rules.
- [ ] Local identity simulation creates sessions that follow the same lifecycle model, with any dev-specific differences documented.

## Blocked by

None - can start immediately
