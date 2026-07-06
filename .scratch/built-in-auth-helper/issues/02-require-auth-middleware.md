Status: ready-for-agent

# Attachable requireAuth Middleware

## Parent

.scratch/built-in-auth-helper/PRD.md

## What to build

A middleware factory that packages the `requireAuth` check as a standard
context middleware attachable through the existing Capsule middleware surface.
It accepts the same `{ linked?: boolean }` options as the helper, runs the
identical core check before the handler, and produces the identical structured
denial — so a Capsule author can protect handlers declaratively without
touching handler bodies. Ship types and extend the docs with the declarative
variant alongside the helper.

## Acceptance criteria

- [ ] A middleware produced by the factory, attached via the existing Capsule middleware surface, blocks unauthenticated calls before the handler runs.
- [ ] The `linked` option behaves identically to the helper's.
- [ ] Denials are byte-for-byte the same structured shape and code as helper denials.
- [ ] Protected handlers require no body changes; unprotected handlers in the same Capsule are unaffected.
- [ ] TypeScript types cover the factory and its options.
- [ ] Docs show the middleware variant next to the helper and when to prefer each.
- [ ] Capsule-session tests cover middleware denial, pass-through, `linked` behavior, and coexistence with unprotected handlers.

## Blocked by

- .scratch/built-in-auth-helper/issues/01-require-auth-handler-helper.md
