Status: ready-for-agent

# requireAuth Handler Helper

## Parent

.scratch/built-in-auth-helper/PRD.md

## What to build

A `requireAuth` helper exported from `sporades/server`, callable inside any
query, mutation, endpoint, or message handler. Called with the handler
context, it returns the session's `AuthContext` when the session is
authenticated; with `{ linked: true }` it additionally requires a linked,
non-guest user. On failure it throws a structured auth error with the stable
`UNAUTHENTICATED` code, rendered to the client through the existing handler
error pipeline in the established structured error shape with opaque public
text; detailed denial context goes to structured server logs. Ship the
TypeScript types and document the helper as the canonical auth gate.

## Acceptance criteria

- [ ] `requireAuth(ctx)` returns the `AuthContext` for an authenticated session in queries, mutations, endpoints, and message handlers.
- [ ] `requireAuth(ctx, { linked: true })` rejects guest sessions and admits linked users.
- [ ] Denials reach the client in the existing structured error shape with the stable `UNAUTHENTICATED` code and no internal detail in public text.
- [ ] Denials emit a structured server-side log entry with diagnostic context.
- [ ] TypeScript types cover the helper signature and options.
- [ ] Docs present `requireAuth` as the canonical way to gate handlers on auth.
- [ ] Capsule-session tests cover success pass-through, unauthenticated denial, guest-vs-linked behavior, and denial shape, across handler kinds.

## Blocked by

None - can start immediately
