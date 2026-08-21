# Define Credential provenance and authority invariants

Status: closed
Label: wayfinder:grilling
Parent: [Chart user-owned scoped Access keys](./00-chart-user-owned-scoped-access-keys.md)
Assignee: codex

**Blocked by:** None — can start immediately.

## Question

What exact invariants keep the linked Sporades user as the sole actor while exposing an interactive Session or named Access key as Credential provenance, and how should attribution, owner disablement or deletion, key disablement, revocation, expiry, and user-profile changes behave without creating a second identity or authority model?

## Comments

### Resolution — 2026-08-19

The sole actor remains one linked, non-guest Sporades user. An Access key is a named, scoped credential owned immutably by that user, not another user, Bot identity, service account, Team member, Capsule role, or authority source. The key can exercise only the intersection of its granted scopes and the owner's current authority.

Every ordinary user context carries separate Credential provenance identifying exactly one Session or Access key. The user actor remains in auth context; Access-key provenance carries the immutable key ID, current human-readable name, and admitted authority metadata. Presenting both credential kinds is ambiguous and fails. A malformed, unknown, expired, revoked, rotated-away, ownerless, or otherwise invalid Access-key attempt fails closed without Session or Anonymous downgrade. Handlers that do not opt into Access keys retain their existing Session and Anonymous behavior.

The Access-key ID, owner, name, grant expressions, and optional expiry never change. Its name is unique among the owner's current keys: active and expired keys reserve names, while revoked keys are historical and release names for reuse. User profile and key metadata are read at the credential check and fixed for the admitted work; subsequent checks see later changes. Durable Jobs and audit or log events retain the stable user ID, stable key ID, and admitted name snapshot needed for historical attribution.

The lifecycle is deliberately small: active, expired, or revoked, with no reversible disabled state. Expiry is optional, checked on authentication, and terminal once crossed. Revocation is irreversible. Rotation applies only to an active key and atomically replaces its secret while preserving its ID, owner, name, grant expressions, and expiry; the old secret fails checks begun after rotation commits, and concurrent rotations serialize to one current secret.

Account-recovery password reset, loss of linked-user status, and owner deletion revoke all owned keys. Relinking never revives them. Lifecycle or profile changes affect subsequent credential checks but do not cancel work that already passed its check; admitted requests may finish and committed Jobs may run or retry under their captured provenance. Job cancellation remains a separate action.
