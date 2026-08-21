# Integrate Credential provenance with runtime authority

Status: closed
Label: wayfinder:grilling
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** [Define Credential provenance and authority invariants](./01-define-credential-provenance-and-authority-invariants.md); [Define scope declaration, grant, and matching semantics](./02-define-scope-declaration-grant-and-matching-semantics.md); [Prototype the requireAuth Access-key interface](./03-prototype-the-requireauth-access-key-interface.md); [Research bearer Access-key security contracts](./04-research-bearer-access-key-security-contracts.md)

## Question

How should the owning user and named Access-key provenance flow through AuthContext, Custom endpoints, private File reads, table and File ACLs, Teams, Jobs, logs, audit attribution, middleware, and revocation so scopes only narrow authority and Capsule activity can distinguish interactive from named API access?

## Comments

### Resolution — 2026-08-20

Every ordinary user context carries two separate, runtime-owned facts: `ctx.auth` is the sole Sporades user actor, while `ctx.credential` records how that actor entered the work. The public provenance type is one frozen discriminated union:

```ts
export type CredentialProvenance =
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "access-key"; id: string; name: string }>;
```

`ctx.credential` is required on ordinary user contexts, including Anonymous Sessions. Session-backed queries, mutations, App messages, and Custom endpoints receive `{ kind: "session" }`; an admitted Bearer request receives the Access key's stable attribution ID and admission-time immutable name. Privileged, Schedule, lifecycle, and verified provider-callback contexts do not pretend to have ordinary Credential provenance. Public and generated declarations must model that distinction rather than placing a misleading optional value on every system context.

Credential admission freezes both the current owning `AuthContext` snapshot and `CredentialProvenance`. Access-key work keeps the existing user ID and profile fields, but sets the compatibility field `ctx.auth.provider` to `"access-key"`: there is no Session whose provider could truthfully be copied, and the owner's legacy/provider-identity data is not request provenance. `ctx.credential` is authoritative for distinguishing interactive and named API access. Session contexts retain their existing per-Session `provider` value.

Only the declarative `requireAuth(handler)` or `requireAuth(options, handler)` Custom-endpoint wrapper activates Bearer transport. Admission completes before Capsule context middleware. Existing unwrapped endpoints and all other browser transports retain Session or Anonymous behavior. The deprecated inline `requireAuth(ctx)` alias and its clearer replacement `requireUserAuth(ctx)` remain user-context checks; they do not parse or revalidate Bearer credentials. The Session-only Access-key management APIs remain Session-only even inside an otherwise Access-key-enabled endpoint.

`ctx.auth` and `ctx.credential` are protected context fields. Middleware may inspect them and may add or replace ordinary Capsule fields, but it cannot mutate, remove, or replace either protected value. Both values and their nested public data are frozen. After every middleware return, the runtime validates identity against the canonical admitted references; a changed or missing protected field fails with `INVALID_CONTEXT_MIDDLEWARE_RESULT` rather than being silently repaired. The runtime context holder used by handlers, ACLs, services, logging, and Job enqueue always retains the canonical values.

Table ACL contexts receive the same frozen `auth` and `credential` values as their invoking ordinary context. File ACL contexts must explicitly add the same pair rather than reconstructing them from user ID. Existing ACL evaluation continues to derive authority from the owning user and current resource state. Scopes do not grant a row, File, Team, role, or membership, and a key name or ID never maps implicitly to one. Capsule ACL code may deliberately inspect `ctx.credential` to impose additional provenance-sensitive policy; that policy is Capsule code, not a second Sporades authority model.

Team operations likewise run as the owning user and evaluate the user's current membership and role. Access keys are never Team members, never Team-owned, and never receive independent Team authority. Calling a Team API through admitted Access-key work is allowed wherever the owning user and Capsule policy already allow it; Sporades adds no mandatory scope or provenance rule beyond explicit guards and ACLs.

Private File reads gain one separate Capsule opt-in:

```ts
files: {
  accessKeys: {
    read: { scopes?: ["files:read"] }
  }
}
```

The concrete scope names must come from the Capsule's central declaration. Omitted `scopes` means no scope requirement, preserving the rule that Sporades does not invent Capsule policy. Without `files.accessKeys.read`, the existing private File route remains Session-only. With it, a request may present exactly one existing Session header or one `Authorization: Bearer ...` Access key. Presenting both, or presenting a malformed or invalid Bearer value, produces the opaque Bearer `401` contract with no Session or Anonymous fallback. Successful Bearer admission resolves and snapshots the owner before the existing File lookup and File ACL run. Access-key File responses use `Cache-Control: private, no-store`; failures use the previously specified no-store, challenge, and opaque-error contract. File URLs and their distribution remain Capsule concerns, and this does not add Access-key WebSocket authentication.

Jobs preserve the admitted boundary. Enqueue from ordinary user work persists a bounded canonical snapshot of the complete owning `AuthContext` plus `CredentialProvenance`; it never persists the Bearer token, selector, verifier, grant expressions, or matched scopes. Retries, restart recovery, and child Jobs inherit that snapshot. Rotation, revocation, key-history deletion, user profile changes, unlinking, and owner deletion do not rewrite or cancel already committed Job work. During execution, table, File, and Team authorization still evaluates current resource and membership state, so the snapshot neither resurrects removed membership nor widens the captured user's authority. Child Jobs deliberately keep the same provenance, matching the rule that work admitted before a lifecycle transition may proceed.

The durable Job schema therefore needs adapter-neutral actor-snapshot and credential-provenance storage in addition to the existing actor user ID. Legacy rows migrate to a Session provenance snapshot using their retained actor provider and current compatibility fallback. Current-user dispatch rehydrates the persisted snapshot rather than requiring the owner row still to exist; Privileged and Schedule execution keeps its existing non-user actor model. Cross-engine restart, retry, migration, deletion, and generated-runtime parity tests must cover this behavior.

Detailed Job inspection keeps authority and provenance distinct:

```ts
enqueuedBy:
  | { mode: "user"; userId: string; credential: CredentialProvenance }
  | { mode: "schedule"; scheduleName: string; scheduledFor: string };

actor:
  | { mode: "current-user"; userId: string }
  | { mode: "privileged-server-role" };
```

The credential belongs on user-mode `enqueuedBy`, not on `actor`: `actor` answers whose authority executes, while `enqueuedBy` answers how that authority entered the durable work. Owner-scoped summary lists may remain bounded `JobSummary` values without provenance; detailed and operator inspection expose it. Stable key IDs disambiguate historical name reuse.

Runtime and Capsule log events emitted inside an ordinary context automatically receive reserved, non-overridable structured attribution fields `{ actor: { userId }, credential }`. ACL, Team, File, middleware, and handler denials use that same admitted envelope. Historical events retain the admission-time key ID/name after rotation, revocation, deletion, or later reuse of the name. Events produced before successful admission cannot safely claim key provenance: failed Bearer admission logs only a bounded reason, route, and transport metadata, never the token, selector, selector fingerprint, key ID, key name, digest, grants, or generic headers/body.

Access-key lifecycle is checked once at each top-level Bearer admission. Downstream runtime APIs consume the frozen snapshot and do not repeatedly query the key record mid-handler, mid-transaction, while streaming admitted File bytes, or during a committed Job attempt. A rotation or revocation committed before a new lookup begins is observed by that admission; a later lifecycle commit affects subsequent admissions only. This supplies stable attribution and transaction behavior without turning scopes or Credential provenance into a second authorization system.
