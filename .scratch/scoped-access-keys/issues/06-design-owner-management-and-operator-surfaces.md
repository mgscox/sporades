# Design owner management and operator surfaces

Status: closed
Label: wayfinder:grilling
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** [Define Credential provenance and authority invariants](./01-define-credential-provenance-and-authority-invariants.md); [Define scope declaration, grant, and matching semantics](./02-define-scope-declaration-grant-and-matching-semantics.md); [Research bearer Access-key security contracts](./04-research-bearer-access-key-security-contracts.md); [Design runtime storage and transaction invariants](./05-design-runtime-storage-and-transaction-invariants.md)

## Question

Which runtime-owned client SDK, trusted server SDK, and CLI/operator interfaces let a linked user issue, name, inspect, rotate, revoke, and delete owned Access keys, show a secret exactly once, and render Capsule-specific management UI without making Capsules reimplement credential security?

## Comments

### Resolution — 2026-08-20

Access-key management is strictly Session-only current-user authority. A linked, non-guest user may list, issue, rotate, revoke, and delete their own keys through an interactive Session. An Access-key credential is denied every owner-management operation even when the surrounding handler otherwise admits Access keys; possession of one key can never mint broader authority, rotate owner control, or erase history. V1 adds no password or provider step-up: the current linked Session is direct owner approval.

Sporades exposes one framework-neutral current-user module at two trusted seams: `accessKeys` from `sporades/client` and `ctx.accessKeys` in ordinary server contexts. Both present the same five lifecycle operations:

```ts
accessKeys.list(options?)
accessKeys.issue(input)
accessKeys.rotate(id, { lifecycleRevision })
accessKeys.revoke(id)
accessKeys.delete(id)
```

The browser methods return `SporadesResult<...>`. The trusted server methods return successful values directly and throw structured runtime errors, matching the existing client-versus-server convention. Server operations additionally require live Session provenance from a synchronous query, mutation, Custom endpoint, or App-message request. Lifecycle hooks, Jobs, Schedules, Privileged callbacks using the current-user projection, and Access-key-authenticated handlers are denied. In particular, Jobs cannot persist an issued token in their durable result.

The owner-visible projection is:

```ts
type AccessKeySummary = {
  id: string;
  name: string;
  grants: string[];
  effectiveScopes: string[];
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  revocationCause: "owner" | "operator" | "password-reset" | "owner-unlinked" | "owner-deleted" | null;
  lastUsedAt: string | null;
  lifecycleRevision: number;
};
```

It omits owner ID, name-reservation state, secret format version, selector, verifier digest, and token fragments. `effectiveScopes` is computed by the runtime against the current declaration, so management UI does not reimplement wildcard matching. The approximate nature of `lastUsedAt` is part of the interface.

`list({ cursor?, limit?, status? })` defaults to 50 records, caps at 100, orders newest-first by `(createdAt, id)`, and uses an opaque cursor. The optional status is `active`, `expired`, or `revoked`; omission means all records. Each page returns `accessKeys`, `declaredScopes`, `nextCursor`, and the filtered `totalCount`, making it independently renderable. Listing plus mutation results supplies inspection without adding a shallow `get()` method.

Issuance accepts `{ name, grants?, expiresAt? }`; omitted grants normalize to `["*"]` and omitted expiry means no expiry. Rotation requires the lifecycle revision observed by the caller. Each returns `{ accessKey: AccessKeySummary, token: string }`, where `token` is the complete `spk_1_...` bearer value. That token exists only in the resolving call: it never enters listing, subscriptions, framework adapters, audit events, generic response capture, client persistence, or later reads. Revocation is idempotent and returns the resulting summary. Deletion accepts only a revoked key and returns its stable ID with `deleted: true`.

One-time disclosure is deliberately not replayable or idempotently recoverable. If an issuance response is lost after commit, the owner finds the key by its unique name and rotates it. If a rotation response is lost, the owner refreshes metadata and rotates again with the new revision. Sporades never retains plaintext merely to replay an uncertain response.

Every owner lookup is scoped by `(ownerUserId, keyId)`. A missing ID and another owner's ID both produce `ACCESS_KEY_NOT_FOUND`. Once ownership is established, management errors may explain the caller's own state. The stable vocabulary is `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_ACCESS_KEY_NAME`, `INVALID_ACCESS_KEY_GRANTS`, `INVALID_ACCESS_KEY_EXPIRY`, `ACCESS_KEY_NAME_CONFLICT`, `ACCESS_KEY_LIMIT_REACHED`, `ACCESS_KEY_NOT_FOUND`, `ACCESS_KEY_NOT_ACTIVE`, `ACCESS_KEY_REVISION_CONFLICT`, and `ACCESS_KEY_DELETE_REQUIRES_REVOKED`.

Sporades ships no universal management page, modal, framework component, Access-key-specific hook, or reactive store. It ships the framework-neutral module, public types, structured errors, and a documented management-flow example. Capsules own layout, copy, secret-copy UX, confirmation UI, and list refreshes after mutations; they do not own credential generation, storage, matching, lifecycle, or transport security.

Operator authority is intentionally narrower. Inside an explicit audited `ctx.privileged.run(...)` callback, the Privileged context receives its own `ctx.accessKeys` projection that may list/inspect metadata across users, revoke one key or every current key for an exact owner, and delete revoked history. It cannot issue, rotate, or receive bearer tokens. The Privileged summary adds only `ownerUserId` to `AccessKeySummary`; it omits email, display name, linked identities, and all credential material. Bulk revocation includes both active and expired-current records and returns a bounded count and summaries.

The operator CLI is a distinct top-level `sporades access-keys` family rather than part of the OAuth configuration and Dev simulation commands under `sporades auth`:

```text
sporades access-keys list --user-id <user-id>
sporades access-keys inspect <key-id>
sporades access-keys revoke <key-id>
sporades access-keys revoke-all --user-id <user-id>
sporades access-keys delete <key-id>
```

Listing and bulk revocation require the immutable user ID; exact-key operations require the immutable key ID. Email and display name are never authority selectors, and there is no unfiltered all-user inventory command. Listing accepts the same cursor, limit, and status controls as the runtime interface. Human output is redacted metadata; `--json` uses the standard structured envelope and cannot contain bearer material.

The CLI selects Dev, Container, or Hosted execution explicitly with `--session dev|container|hosted`; Hosted additionally requires `--host <alias> --subname <name>`. It extends the existing generated-bundle runtime-action seam with shared `access-keys.*` request and response envelopes: Dev invokes the generated bundle with `--sporades-action`, Container uses `docker exec`, and Hosted reaches the same action through the Host helper over SSH and `docker exec`. No CLI or Host-helper path opens auth tables or duplicates lifecycle SQL. Operator actions require a running Capsule; supporting a stopped Capsule would require a new partial-runtime or maintenance-start lifecycle and is outside this specification.

Read-only list and inspect need no confirmation. Revoke and delete prompt interactively unless `--yes` is present. Bulk revocation requires both an exact user ID and either a typed matching user ID or `--yes`. `--json` never implies destructive consent, so non-interactive callers must explicitly pass `--yes`.

Owner issuance, rotation, revocation, and deletion emit security audit events. Every operator action, including inspection, runs through the existing Privileged audit seam. Events use stable owner/key IDs, the admission-time key name, grant expressions where relevant, operation, execution source, and outcome; they never contain bearer tokens, selectors, digests, token fragments, or generic request/response bodies. Ordinary owner listing is not audited per read.
