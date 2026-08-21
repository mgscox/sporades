# PROTOTYPE — `requireAuth` Access-key interface

This throwaway logic prototype asks whether a backward-compatible `requireAuth`
interface can make Access-key activation explicit before Capsule middleware and
handler execution while preserving the existing synchronous inline user gate
under a clearer name. It does not authenticate real credentials or modify the
runtime.

Run it with:

```sh
npm run prototype:require-auth-interface
```

The interface under discussion is:

```ts
// Preferred inline form — synchronous and concerned only with user auth state.
const auth = requireUserAuth(ctx, { linked: true });

// Existing inline spelling remains as a deprecated compatible alias.
const legacyAuth = requireAuth(ctx, { linked: true });

// Declarative wrapper — opts this handler into pre-handler Access-key admission.
endpoint(
  { method: "POST", path: "/requests" },
  requireAuth(
    { credentials: ["access-key"], scopes: ["requests:write"] },
    (ctx) => ({
      userId: ctx.auth.userId,
      credential: ctx.credential,
    }),
  ),
);
```

The shared option shape is:

```ts
type CredentialKind = "session" | "access-key";

type RequireUserAuthOptions = {
  linked?: boolean;
};

type RequireAuthOptions = {
  linked?: boolean;
  credentials?: readonly CredentialKind[];
  scopes?: readonly string[];
};
```

Omitted credential kinds admit either kind and omitted scopes require none.
Explicit empty arrays are invalid. Declarative wrapper requirements are checked
when the Capsule is registered. `requireUserAuth` and the deprecated inline
`requireAuth` alias accept only the existing `linked` option.

Admitted ordinary user work exposes attribution separately from authority:

```ts
type CredentialProvenance =
  | { kind: "session" }
  | { kind: "access-key"; id: string; name: string };
```

`ctx.auth` remains the owning user's existing `AuthContext`, `ctx.credential`
is always present, and `requireUserAuth` returns `AuthContext`. Grants
are intentionally absent from provenance; Capsule code requests enforcement
through `requireAuth` instead of rebuilding it from metadata.

Sporades interprets an Access-key credential only for a declaratively wrapped
Custom endpoint (and separately for runtime-owned private File reads). An
unwrapped Custom endpoint retains its existing Session/Anonymous behavior and
receives its `Authorization` header untouched. On an opted-in route, malformed
or invalid Access keys never downgrade, and simultaneous Session plus
Access-key presentation is ambiguous and denied. Successful admission happens
before Capsule context middleware, which therefore sees the admitted user and
Credential provenance.

The wrapper is a handler decorator carrying runtime-readable guard metadata. It
is not Capsule context middleware and does not add another global middleware
list. Missing or invalid credentials retain the opaque `UNAUTHENTICATED`
denial. A valid admitted credential of a disallowed kind or a valid Access key
without a required scope receives opaque `FORBIDDEN`; bounded platform
diagnostics may record the internal reason without exposing scopes or
credential metadata publicly.

The decorator may wrap query, mutation, Custom endpoint, or App-message
handlers. Only an opted-in Custom endpoint gains Access-key transport; the
other transports continue to supply Sessions and deny an Access-key-only
guard. A single literal credential kind narrows `ctx.credential` for the
wrapped handler, while omitted or multiple kinds retain the provenance union.
Scope declarations are validated at registration rather than threaded through
elaborate Capsule-definition generics.

Nested declarative wrappers are invalid. One wrapper owns the complete
pre-handler credential requirement; a handler may perform a later
`requireUserAuth` check when it needs to require linked user state. Wrapper
options and their arrays are normalized, copied, and frozen when declared so
later caller mutation cannot change the guard.

Inline `requireUserAuth(ctx, options)` and its deprecated `requireAuth` alias
remain ordinary synchronous checks at their exact call site. They inspect the
already-established user context; they do not activate or validate a raw
Access key, inspect Credential provenance, scan source, or move ahead of
earlier work. Capsule authors call the check before protected operations;
database work in the handler transaction rolls back on a later denial, while
already-triggered external side effects cannot be undone. The declarative
wrapper is the only pre-handler credential-admission guarantee.

Guard options fail closed. Unknown option names or credential kinds, duplicate
entries, empty arrays, wildcard required scopes, and undeclared required scopes
are invalid. A declarative error prevents Capsule registration; an invalid user
check throws `INVALID_AUTH_REQUIREMENTS` at the call site. Supported legacy
inline forms retain their behavior, while undocumented JavaScript properties
no longer disappear silently when they may be misspelled security requirements.
