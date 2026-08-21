# Fix the public contract and completion proof

Status: closed
Label: wayfinder:grilling
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** [Prototype the requireAuth Access-key interface](./03-prototype-the-requireauth-access-key-interface.md); [Design runtime storage and transaction invariants](./05-design-runtime-storage-and-transaction-invariants.md); [Design owner management and operator surfaces](./06-design-owner-management-and-operator-surfaces.md); [Integrate Credential provenance with runtime authority](./07-integrate-credential-provenance-with-runtime-authority.md)

## Question

What exact configuration, public types, runtime interfaces, structured errors, documentation, generated surfaces, compatibility guarantees, focused tests, adapter conformance, security denials, and real HTTP acceptance evidence must the implementation-ready specification require before user-owned scoped Access keys can be called complete?

## Comments

### Resolution — 2026-08-20

Completion means one coherent Access-key module reaches every shipped Sporades seam and is proved through those interfaces. A source-only implementation, a green logic prototype, SQLite-only storage, generated output copied by hand, or a mocked HTTP handler is incomplete.

#### Capsule declarations

The exact top-level scope declaration is:

```ts
capsule({
  accessKeys: {
    scopes: ["requests:read", "requests:write"],
  },
});
```

Its public type is `accessKeys?: { scopes: readonly string[] }`. Omitting `accessKeys` is equivalent to an empty vocabulary; an explicit empty `scopes` array is valid. The object accepts no unknown properties. The runtime validates and freezes a copied declaration at Capsule registration using the limits and concrete-scope rules already decided. `sporades.json`, Server env, owner management, CLI management, and database rows cannot declare or mutate the vocabulary.

Private File admission remains deliberately separate:

```ts
files: {
  accessKeys: {
    read: { scopes?: readonly string[] },
  },
}
```

`files.accessKeys.read` is the opt-in; its `scopes` property is optional and omission requires no scope. An explicit empty array, undeclared scope, wildcard, duplicate, unknown property, or malformed nesting is a Capsule-registration error. This is not inferred from the presence of a scope named `files:*`.

#### Public server interface

`sporades/server` exports the following canonical concepts:

```ts
export type CredentialKind = "session" | "access-key";

export type CredentialProvenance =
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "access-key"; id: string; name: string }>;

export type RequireUserAuthOptions = { linked?: boolean };

export type RequireAuthOptions = {
  linked?: boolean;
  credentials?: readonly CredentialKind[];
  scopes?: readonly string[];
};
```

Ordinary user handler, middleware, table ACL, File ACL, and captured-user Job contexts expose required frozen `credential` provenance beside the existing `auth`. Non-user Privileged, Schedule, lifecycle, and verified provider-callback context types omit it rather than making it misleadingly nullable. Type tests must prove that a single literal `credentials` requirement narrows the decorated handler's provenance and that omitted or multiple credential kinds preserve the union.

`requireAuth(handler)` and `requireAuth(options, handler)` are the declarative decorator overloads. Their returned definition retains private runtime-readable guard metadata without making callers learn a second guard object or endpoint option. `requireUserAuth(ctx, options?)` is the preferred synchronous inline user check. The existing `requireAuth(ctx, options?)` overload remains functional indefinitely and is marked `@deprecated` only at the type/documentation surface; its behavior is not deprecated or removed. The inline overload accepts only `RequireUserAuthOptions` and never activates Bearer parsing.

The public Access-key lifecycle types are shared in meaning across server and client declarations:

```ts
export type AccessKeyStatus = "active" | "expired" | "revoked";
export type AccessKeyRevocationCause =
  | "owner" | "operator" | "password-reset"
  | "owner-unlinked" | "owner-deleted";

export type AccessKeySummary = {
  id: string;
  name: string;
  grants: string[];
  effectiveScopes: string[];
  status: AccessKeyStatus;
  createdAt: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  revocationCause: AccessKeyRevocationCause | null;
  lastUsedAt: string | null;
  lifecycleRevision: number;
};

export type AccessKeyListOptions = {
  cursor?: string;
  limit?: number;
  status?: AccessKeyStatus;
};

export type AccessKeyListResult = {
  accessKeys: AccessKeySummary[];
  declaredScopes: string[];
  nextCursor: string | null;
  totalCount: number;
};

export type AccessKeyIssueInput = {
  name: string;
  grants?: readonly string[];
  expiresAt?: string | Date;
};

export type AccessKeySecretResult = {
  accessKey: AccessKeySummary;
  token: string;
};
```

The trusted current-user `ctx.accessKeys` interface has only `list`, `issue`, `rotate`, `revoke`, and `delete`. Rotation takes `{ lifecycleRevision: number }`; issue and rotate return `AccessKeySecretResult`; revoke returns `{ accessKey: AccessKeySummary }`; delete returns `{ id, deleted: true }`. Methods return Promises, throw structured runtime errors, and are runtime-gated to a live linked Session in query, mutation, Custom-endpoint, or App-message work. Their presence never lets Access-key, Job, lifecycle, Schedule, or Privileged execution use the current-user projection.

The explicit `PrivilegedContext.accessKeys` projection is a different interface with `list`, `inspect`, `revoke`, `revokeAll`, and `delete`. Its summary adds only `ownerUserId`; it has no issue or rotate method and no secret-bearing result. Every call enters the existing Privileged audit seam.

`JobState.enqueuedBy` adds `credential: CredentialProvenance` only to its user variant. `actor` remains the authority identity. Job storage and generated runtime declarations carry the captured `AuthContext` and credential snapshot described by the integration ticket.

#### Public client interface

`sporades/client` exports a framework-neutral `accessKeys` singleton and the corresponding lifecycle types. It has the same five current-user methods and result values as `ctx.accessKeys`, but every method returns `Promise<SporadesResult<...>>`. It does not store the disclosed token, add an Access-key subscription, attach methods to framework-specific Auth adapters, or expose a universal management component. A management-page example explicitly keeps the returned token only in transient component memory and clears it when the one-time disclosure UI closes.

#### Errors and HTTP contract

Public `SporadesError` gains optional `code?: string`; server errors retain `error.code`. Exporting an `AccessKeyErrorCode` string union is allowed for discoverability, but callers must continue handling unknown future codes safely. Registration uses `INVALID_ACCESS_KEY_DECLARATION`, `INVALID_ACCESS_KEY_SCOPE`, `INVALID_FILE_ACCESS_KEY_POLICY`, and `INVALID_AUTH_REQUIREMENTS`. Owner management uses the stable vocabulary already fixed: `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_ACCESS_KEY_NAME`, `INVALID_ACCESS_KEY_GRANTS`, `INVALID_ACCESS_KEY_EXPIRY`, `ACCESS_KEY_NAME_CONFLICT`, `ACCESS_KEY_LIMIT_REACHED`, `ACCESS_KEY_NOT_FOUND`, `ACCESS_KEY_NOT_ACTIVE`, `ACCESS_KEY_REVISION_CONFLICT`, and `ACCESS_KEY_DELETE_REQUIRES_REVOKED`. Admission throttling uses `RATE_LIMITED`.

Bearer admission exposes only `UNAUTHENTICATED` for missing/invalid credentials and `FORBIDDEN` for a valid credential rejected by kind or scope. Every Access-key-path 401 has the appropriate `WWW-Authenticate: Bearer realm="sporades"` challenge; invalid material adds only `error="invalid_token"`. A 403 reveals neither required nor granted scopes and carries no misleading challenge. Access-key 401, 403, 429, issue, rotate, and successful authenticated responses use the agreed no-store defaults. No response, error, audit record, trace, test snapshot, or log includes a bearer value or token fragment.

#### CLI and operator contract

The shipped CLI family remains exactly:

```text
sporades access-keys list --user-id <user-id>
sporades access-keys inspect <key-id>
sporades access-keys revoke <key-id>
sporades access-keys revoke-all --user-id <user-id>
sporades access-keys delete <key-id>
```

It implements the confirmation, `--json`, target-session, exact-ID, redaction, and running-Capsule rules from the management ticket. The generated Bundle action seam adds versioned `access-keys.list`, `access-keys.inspect`, `access-keys.revoke`, `access-keys.revoke-all`, and `access-keys.delete` envelopes. Dev, Container, and Host-helper paths invoke those actions; none opens auth tables or duplicates lifecycle SQL. CLI help, human output, JSON validation, hostile/malformed envelope handling, unknown-action upgrade guidance, and destructive confirmation each need focused tests.

#### Compatibility contract

This is additive for existing Capsules and databases. An unwrapped Custom endpoint never interprets an Access-key-looking Authorization header and keeps existing Session/Anonymous behavior. Missing or invalid endpoint Session tokens keep their legacy downgrade behavior outside an opted-in decorator. Queries, mutations, App messages, OAuth routes, and browser WebSockets do not gain Bearer transport. Existing private File reads remain Session-only unless `files.accessKeys.read` is present. Existing inline `requireAuth(ctx, ...)` calls compile and behave identically. Existing Capsule definitions need no new property; Auth-storage migration is additive and idempotent; existing Job rows receive a deterministic Session-provenance compatibility migration.

The implementation may tighten undocumented misspelled security-option objects by rejecting them, but it must not remove or silently reinterpret documented calls. `ctx.auth` remains the user actor. No key becomes a Team member, record owner, provider identity, or separate user. Scopes continue to be developer-declared narrowing checks rather than framework-inferred authorization.

#### Shipped and generated surfaces

The change is incomplete until source, generated, packaged, and documented surfaces agree. At minimum it updates `src/server.ts`, `src/types/server.d.ts`, `src/client.ts`, `src/types/client.d.ts`, the client runtime template, auth/database/HTTP/File/ACL/Job/log runtimes, Capsule registration, server Bundle entry and module graph, CLI, Host helper, help text, and every affected declaration/map in `dist/` plus both generated `bin/` files. `npm run build` must regenerate rather than hand-edit outputs, and `dist/generated-source-manifest.json` must pass its retained input/output digest check. An `npm pack` smoke must import both package exports from the packed tarball and prove the Access-key values and declarations are present.

Canonical documentation includes the Access key, scope, lifecycle, management, Credential provenance, and Session provenance glossary terms in `CONTEXT.md`; the authority and lifecycle contract in `docs/PRD.md`; one ADR recording the user-owned credential/provenance decision; the Auth guide; server-runtime reference; client Auth reference; Files reference; Jobs/background-work reference; operations/hosting reference; SDK documentation map; README/CHANGES discoverability; CLI help; and regenerated TypeDoc/API and docs navigation. Examples use obvious placeholders rather than syntactically valid secrets and show both a Session-capable endpoint and an Access-key-only scoped endpoint.

#### Required proof

Focused proof is organized at the module interfaces rather than testing private helpers as a substitute:

1. Declaration and type tests cover the top-level vocabulary, File opt-in, bounds, duplicates, wildcard rejection, live wildcard grants across definition changes, decorator overloads/narrowing, deprecated inline compatibility, protected context fields, client/server lifecycle values, and package-export parity.
2. Credential tests cover exact `spk_1` parsing, entropy lengths, version rejection, unknown-selector dummy comparison, fixed digest encoding, constant-time equal-length comparison, one-time disclosure, no-overlap rotation, expiry, terminal/idempotent revocation, owner eligibility, reset/unlink/delete revocation, quota serialization, current-name reuse, and fail-closed malformed values.
3. Authorization tests cover missing, dual, wrong-kind, missing-scope, Session-satisfies-scope, omitted requirements, middleware ordering/tamper rejection, table/File ACL provenance, owner-first Teams authority, no automatic scope-to-ACL mapping, no downgrade, 401/403/429 status and headers, caching defaults, and bounded diagnostics.
4. Management tests cover every browser and trusted-server operation, Session-only enforcement, one-time response loss recovery, optimistic rotation conflict, owner opacity, pagination/filtering, effective-scope calculation, operator restrictions, audits, and absence of token material from state, subscriptions, results after first disclosure, and generic capture.
5. Job tests cover snapshot persistence, restart/retry/child propagation, rotation/revocation/profile change/unlink/owner deletion after enqueue, current resource and Team membership checks, detailed/operator inspection, stable attribution after name reuse, and legacy-row migration on every adapter.
6. CLI tests cover Dev, Container, and Hosted action routing, the running-Capsule requirement, exact selectors, confirmations, `--yes`, JSON envelopes, hostile output, redaction, and no issuance/rotation commands.
7. Security tests seed a unique canary token and assert it is absent from runtime logs, Privileged audits, error objects, HTTP bodies/headers other than its intentional one-time response, generated Bundles, CLI output, snapshots, metrics labels, and retained files. Failure-throttle tests prove both bounded LRUs, expiry, successful-bucket clearing, 429, and no attacker-driven persistent rows.

The existing auth-storage conformance surface is extended, or a dedicated Access-key surface is added, so every new adapter method is exercised by the same cases against SQLite, service-backed libSQL, and the dedicated PostgreSQL test database. The method-coverage guard may not exempt an Access-key method merely because an engine overrides it. Required cross-engine cases include additive bootstrap, restart persistence, lookup/index parity, uniqueness, quota rollback and concurrency, rotation CAS, revocation scrubbing, password-reset atomicity, owner transitions, telemetry coalescing, historical deletion, Job snapshots, and stored-row normalization. The PostgreSQL run is a completion requirement, not an optional green-suite skip, and the emitted-SQL quoting audit must include every new table, index, statement, and migration.

Finally, one purpose-built acceptance Capsule must prove real network behavior through both a Dev runtime and a freshly generated Container Bundle. Using a real linked Session, its public management module issues a read-only key once; actual HTTP requests then prove the same owner with distinct `ctx.credential`, Session admission, Access-key-only and mixed-kind decorators, allowed scope, opaque 403 for a missing scope, opaque 401 for malformed/unknown/dual/old/revoked credentials, challenge and cache headers, unwrapped Authorization pass-through, explicit private File admission and the absent-config denial, rotation, revocation, password-reset bulk revocation, middleware/ACL/Team attribution, and a pre-revocation Job completing after restart with captured provenance. The canary secret must be scanned out of all resulting logs and artifacts.

A live Hosted deployment is not required for feature correctness because Hosted runs the same generated Bundle. Hosted completion instead requires end-to-end CLI/Host-helper contract proof through the real action envelope and container-exec seam; a live Hosted smoke remains release evidence. Completion reporting names the commit, Node version, exact commands, adapter endpoints by non-secret identity, Dev and Container ports, test counts/skips, generated-manifest result, packed-tarball result, and redacted acceptance evidence. A skipped PostgreSQL run, an ungenerated artifact, a mocked-only HTTP flow, or an unexplained environment skip prevents the feature from being called complete.
