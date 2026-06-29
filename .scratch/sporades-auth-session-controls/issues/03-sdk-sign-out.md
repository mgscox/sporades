Status: ready-for-agent

# SDK Sign-Out

## What to build

Add `auth.signOut()` to the Sporades client SDK so app code can end the current session and receive a pass/fail result that can drive routing or UI state. On success, the SDK should clear the stored session token and refresh auth state so the browser behaves like a fresh anonymous visitor.

This should be a test-driven design task. Tests should verify behavior through the SDK and runtime protocol, not by reaching into private storage helpers.

## Acceptance criteria

- [x] The SDK exposes `auth.signOut()` and returns a structured pass/fail result.
- [x] Successful sign-out clears the stored Sporades session token from client persistence.
- [x] After sign-out, a subsequent auth lookup yields a fresh anonymous session rather than the previous linked identity.
- [x] Sign-out failure returns a structured JSON error and leaves client state consistent.
- [x] Existing anonymous, Google, and future email auth flows can all use the same sign-out surface.
- [x] Tests cover SDK behavior, WebSocket/runtime behavior, and app-facing auth state refresh after sign-out.
- [x] Documentation includes a short example showing routing after a successful sign-out.

## Blocked by

None - can start immediately

## Comments

Implemented in `ad12f39087716690bd777480a8d590b92133e465`. Focused client/runtime tests and the full `npm test` suite pass.
