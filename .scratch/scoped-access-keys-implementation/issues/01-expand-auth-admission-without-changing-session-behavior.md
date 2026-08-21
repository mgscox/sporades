# 01 — Expand Auth admission without changing Session behavior

**What to build:** Give existing Session-backed Capsule work the final Auth admission interface before Bearer credentials are introduced. Capsules can declare their scope vocabulary, decorate handlers with credential requirements, use the clearer inline user check, and observe immutable Session Credential provenance without changing any existing Session, Anonymous Session, or unwrapped Custom-endpoint behavior.

**Blocked by:** None — can start immediately

**Status:** complete

- [x] `capsule({ accessKeys: { scopes } })` accepts a bounded, frozen copy of unique concrete scope names, treats omission as an empty vocabulary, accepts an explicit empty vocabulary, and rejects malformed, wildcard, duplicate, oversized, or unknown declaration fields at registration.
- [x] The shared wildcard matcher implements case-sensitive whole-string `*` matching for immutable grant expressions, while required scopes remain concrete declarations and multiple requirements use AND semantics.
- [x] Declarative `requireAuth(handler)` and `requireAuth(options, handler)` work for queries, mutations, Custom endpoints, and App messages; omitted credentials mean Session or Access key, omitted scopes mean none, and a Session satisfies declared scope requirements without grants.
- [x] A single literal credential requirement narrows the handler's Credential provenance type; malformed options, nested decorators, duplicates, empty arrays, wildcards, and undeclared required scopes fail closed.
- [x] `requireUserAuth(ctx, { linked? })` becomes the preferred synchronous inline user check, while every documented `requireAuth(ctx, { linked? })` call remains functional and is marked deprecated by name only.
- [x] Every ordinary Session-backed user context, including Anonymous Sessions and current-user Job execution, exposes frozen `{ kind: "session" }` Credential provenance to handlers, middleware, table ACLs, and File ACLs; non-user contexts do not fabricate it.
- [x] Context middleware may read but cannot remove, replace, or mutate the canonical AuthContext or Credential provenance; tampering fails with `INVALID_CONTEXT_MIDDLEWARE_RESULT` before protected work continues.
- [x] Unwrapped endpoints continue to leave Authorization headers to Capsule code, invalid or missing endpoint Session tokens retain their legacy Anonymous downgrade, and browser WebSocket transports remain Session-only.
- [x] Public declarations, source runtime, generated Bundle/runtime artifacts, package exports, documentation for the renamed inline helper, and focused parity/type tests remain synchronized and green.

## Completion evidence

- Implementation and repair commits culminate at `9496593` (`fix: preserve guarded handler type safety`).
- Focused runtime, HTTP, type-narrowing, generated-Bundle, denial-audit, wildcard-matching, and compatibility tests passed during the ticket implementation cycle.
- Independent Standards and Spec reviews were clean at `9496593`.
- The mandatory release gate at implementation commit `82ac350` subsequently passed the complete integrated suite with 1,858 passes, 0 failures, and only 37 reviewed optional live-smoke skips.
