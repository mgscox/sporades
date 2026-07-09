Status: done

# Add Auth Throttling For Email Sign-In Attempts

## What to build

Throttle repeated failed email sign-in attempts so attackers cannot brute-force credentials through the Sporades client transport. The throttling should protect by account and caller context while preserving normal successful sign-in behavior and keeping failure responses opaque.

## Acceptance criteria

- [ ] Repeated failed email sign-in attempts for the same email become throttled after a conservative threshold.
- [ ] Throttling accounts for caller/session context so one abusive caller cannot run unlimited attempts.
- [ ] Successful sign-in behavior and session rotation remain unchanged for normal users.
- [ ] Client-facing errors do not disclose whether an email is registered beyond the existing credential failure contract.
- [ ] Tests cover allowed attempts, throttled attempts, cooldown or reset behavior, and successful sign-in after non-abusive use.

## Blocked by

None - can start immediately
