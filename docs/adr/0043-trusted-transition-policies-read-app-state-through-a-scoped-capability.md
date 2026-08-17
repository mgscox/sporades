# Trusted transition policies read app state through a scoped capability

Sporades sometimes owns a state transition whose admission depends on Capsule-owned app state. A Team Join is the first demonstrated case: Sporades validates and consumes the Join link and inserts the membership, while a Capsule may need its subscription row to decide whether another accepted member is allowed. Applying the joining user's ordinary row ACL to that policy read creates a circular dependency, because an ACL may correctly require existing Team membership.

Sporades will provide one internal `withTrustedRead` module for these policies. It accepts an active runtime-owned transaction, a purpose from a closed runtime vocabulary, subject metadata, cancellation state, and one callback. The callback receives only the familiar read-only app-table interface. Its reads use an unforgeable runtime capability to bypass normal actor row ACLs, observe earlier app writes in the same transaction, and never open a nested transaction or separate snapshot.

The capability is not the Privileged server role. Subject metadata records who or what the transition concerns; it neither grants membership nor becomes execution authority. Trusted reads cannot inspect runtime-owned auth, Team, Job, log-index, schema-metadata, or storage implementation tables, and expose no insert, insert-or-ignore, update, delete, raw SQL, schema, adapter, or transaction operation.

The trusted-read lifetime is the callback lifetime. Sporades revokes the capability in `finally` after success, failure, or cancellation. Retained database, table, and composed-query handles fail closed, and asynchronous adapter reads recheck authority before delivering their result so a detached promise cannot return protected rows after settlement.

`withTrustedRead` remains an internal implementation interface rather than a public ACL-bypass operation. Each legitimate use has a purpose-specific runtime seam, such as Team Join admission, which decides when the capability may exist, supplies the transaction and purpose, maps policy failures to its own opaque public result, and owns the state transition that follows. Capsule and browser code cannot request a purpose or invoke the generic module through supported public exports.

A future consumer qualifies only when every condition holds:

1. Sporades owns the state transition.
2. Trusted Capsule policy must decide whether that transition may occur.
3. The decision depends on app-owned state hidden by the transition subject's ordinary ACL.
4. The decision and transition must be atomic inside one runtime-owned transaction.
5. Browser callers cannot choose, omit, or widen the policy.
6. Read-only app-table access is sufficient.
7. A purpose-specific seam can define opaque failure and audit or security-event behavior.
8. Capability authority can end when the policy callback settles.

This keeps the dangerous mechanics local and reusable without teaching ordinary ACL rules about pending identities, adding caller-supplied intent flags, coupling Sporades to one Capsule domain such as billing, or creating a general public `bypassACL` escape hatch. Normal app-table ACL enforcement and audited Privileged server-role work continue through their existing interfaces.
