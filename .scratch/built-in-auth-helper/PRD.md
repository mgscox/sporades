# Built-in Authenticated Middleware/Helper

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "Built-in authenticated middleware/helper")
- `docs/adr/0022-acl-rules-are-runtime-policy-functions.md` (denial-shape conventions)

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

## Problem Statement

Capsule authors who need a handler to run only for an authenticated (or fully
linked, non-guest) user must hand-write the same `ctx.auth` checks in every
query, mutation, endpoint, and message handler. Each author invents their own
denial shape, so clients cannot reliably distinguish "not signed in" from other
errors, and it is easy to forget the check entirely on a new handler.

## Solution

Sporades provides a built-in server helper and a matching context middleware.
Inside any handler, `requireAuth(ctx)` returns the `AuthContext` when the
session is authenticated and throws a structured auth error otherwise;
`requireAuth(ctx, { linked: true })` additionally requires a linked, non-guest
user. The same check is available declaratively as a middleware that can be
attached through the existing Capsule middleware surface, so entire handler
groups are protected without touching handler bodies. Denials always surface
to the client in the existing structured error shape with a stable,
machine-readable code.

## User Stories

1. As a Capsule author, I want a `requireAuth` helper I can call at the top of a mutation, so that unauthenticated requests are rejected without hand-written checks.
2. As a Capsule author, I want `requireAuth` to return the `AuthContext` on success, so that I can use `userId` and profile fields without re-reading `ctx.auth`.
3. As a Capsule author, I want an option to require a linked (non-guest) user, so that guest sessions cannot perform account-level actions.
4. As a Capsule author, I want the same check as an attachable context middleware, so that I can protect groups of handlers declaratively instead of per-handler.
5. As a Capsule author, I want the helper to work identically in queries, mutations, endpoints, and message handlers, so that I do not need per-surface variants.
6. As a client developer, I want auth denials to arrive in the existing structured error shape with a stable code, so that I can route users to sign-in on that code alone.
7. As a client developer, I want denial messages to be opaque about server internals, so that no policy or session detail leaks to the browser.
8. As a Capsule author, I want denials logged with structured context server-side, so that I can diagnose why a request was rejected.
9. As a Capsule author, I want the helper exported from `sporades/server`, so that it is importable only in server code per the import rules.
10. As a Capsule author, I want TypeScript types for the helper and middleware, so that misuse is caught at compile time.
11. As a Capsule author, I want docs and scaffold guidance showing the helper as the canonical auth gate, so that new Capsules adopt it by default.
12. As an AFK agent, I want the helper to behave the same in Dev sessions, local Container sessions, and Hosted Capsules, so that verified behavior transfers across runtimes.

## Implementation Decisions

- The helper is a `sporades/server` export usable inside any handler kind
  (query, mutation, endpoint, message). It takes the handler context and an
  optional `{ linked?: boolean }` option object.
- On success it returns the context's `AuthContext`; on failure it throws a
  structured auth error carrying a stable machine-readable code
  (`UNAUTHENTICATED`) that the existing handler error pipeline renders in the
  established `{ ok: false, error: { message, hint } }` result shape plus the
  code. Public denial text stays opaque, matching the ADR 0022 denial
  convention; detailed context goes to structured server logs only.
- "Authenticated" means the session's `AuthContext.isAuthenticated` is true.
  "Linked" additionally requires `isGuest` to be false. The anonymous-session
  guest user is therefore rejected by `{ linked: true }` even where guests
  count as authenticated.
- The middleware variant is a standard `ContextMiddleware` produced by a
  factory (same options as the helper) and attached through the existing
  Capsule middleware surface; it runs the identical core check before the
  handler and produces the identical denial. No new middleware machinery is
  introduced.
- No new runtime state, schema, or configuration is added. The helper reads
  only the existing session-resolved `AuthContext`.
- Server-owned auth is preserved: nothing about the helper is trusted from or
  configurable by the client.

## Testing Decisions

- Tests exercise external behavior only, at the existing capsule-session seam:
  boot a Capsule through the established Dev-session/Container-session test
  harness and drive real queries, mutations, endpoints, and messages over
  websocket/HTTP.
- Good tests assert: denial result shape and stable code for unauthenticated
  callers; success pass-through returning the caller's `AuthContext`; the
  `linked` option rejecting guest sessions while plain `requireAuth` admits
  them; middleware attachment protecting a handler without body changes; no
  internal detail in public denial text.
- Prior art: the existing Dev-session websocket tests that call mutations and
  assert structured error results, and the endpoint tests that assert
  structured endpoint responses.

## Out of Scope

- Role- or permission-based authorization (see the roadmap "Root server role"
  and ACL follow-ups).
- Client-side helpers or `useAuth()` changes.
- New auth providers, session storage, or linking flows.
- Table/storage ACL rule changes (ADR 0022 covers those).

## Further Notes

- The helper is the natural precursor to future `sporades doctor` checks for
  unprotected handlers; keep the denial code stable for that use.
