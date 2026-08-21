# Prototype the requireAuth Access-key interface

Status: closed
Label: wayfinder:prototype
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** None — can start immediately.

## Question

What concrete compatible inline and declarative-wrapper forms should `requireAuth` expose for optional credential and scope requirements, and how should Access-key activation, Credential provenance, pre-handler rejection, inline ordering, errors, types, and middleware interaction behave so existing code remains valid without authenticating handlers that never opt in?

## Comments

### Resolution — 2026-08-20

The validated throwaway logic prototype is [the `requireAuth` Access-key interface prototype](../prototypes/require-auth-interface/README.md), runnable with `npm run prototype:require-auth-interface`.

`requireAuth(handler)` and `requireAuth(options, handler)` are declarative handler decorators. They may wrap query, mutation, Custom endpoint, or App-message handlers, but only a wrapped Custom endpoint activates Access-key transport. Other wrapped transports retain their Session credential and deny an Access-key-only requirement. An unwrapped Custom endpoint does not interpret an Access-key-looking `Authorization` header: it preserves existing Session/Anonymous behavior and leaves that header to Capsule code. Runtime-owned private File reads remain a separate Access-key-capable path.

The wrapper owns pre-handler credential admission. It resolves and snapshots the credential before Capsule context middleware runs, so middleware and the handler see the admitted owning user in `ctx.auth` and always-present Credential provenance in `ctx.credential`. Malformed or invalid Access keys fail without Session or Anonymous fallback; presenting both credential kinds is ambiguous and fails. A missing or invalid credential produces opaque `UNAUTHENTICATED`/HTTP 401. A valid credential of a disallowed kind or a valid Access key missing a required scope produces opaque `FORBIDDEN`/HTTP 403. Bounded platform diagnostics may retain the internal reason without exposing required scopes or credential metadata publicly.

The wrapper options are `{ linked?, credentials?, scopes? }`. Credential kinds are `"session" | "access-key"`; a credential list is OR, while required scopes are AND. Omitted credentials admit either kind, and omitted scopes require none. A permitted Session satisfies scope requirements without Access-key grants. One literal credential kind narrows the wrapped handler's `ctx.credential` type; otherwise it remains the provenance union. Scope strings use registration-time validation rather than Capsule-definition-dependent type machinery.

`ctx.auth` remains the existing owning-user `AuthContext`. `ctx.credential` is `{ kind: "session" } | { kind: "access-key"; id: string; name: string }`, with the Access-key name captured at admission. Grants are deliberately absent from public provenance so Capsules request scope enforcement instead of recreating it.

For clearer semantics, new inline user checks use synchronous `requireUserAuth(ctx, { linked? })`, which returns the existing `AuthContext` and inspects only the already-established user context. It neither activates nor validates a raw Access key nor inspects Credential provenance. The existing `requireAuth(ctx, { linked? })` inline form remains indefinitely compatible as a deprecated alias, while `requireAuth` remains the preferred declarative credential-admission name. If a wrapper already admitted an Access key, `requireUserAuth` returns its owning user; Session-only admission is expressed by the wrapper's `credentials: ["session"]` requirement.

Inline user checks execute exactly where called and should precede protected work; Sporades does not scan or reorder handler source. The declarative wrapper is the only pre-handler guarantee. Nested declarative wrappers are invalid because one wrapper expresses the complete credential requirement. Wrapper options are normalized, copied, and frozen when declared.

Guard declarations fail closed: unknown option names or credential kinds, duplicates, empty arrays, wildcard required scopes, and undeclared required scopes are developer errors. Declarative errors prevent Capsule registration; invalid inline user-check options throw `INVALID_AUTH_REQUIREMENTS`. Supported legacy inline calls retain their behavior, while undocumented extra JavaScript properties no longer disappear silently.
