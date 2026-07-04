Status: done

# Add Scoped ACL Context Helpers

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Provide a constrained read-only ACL context for policy rules with scoped helpers such as `ctx.acl.db.get()`, `ctx.acl.db.exists()`, `ctx.acl.storage.get()`, and `ctx.acl.storage.exists()`. The helpers should allow database and storage policies to inspect stable resources without exposing normal runtime APIs or allowing writes.

## Acceptance criteria

- [x] ACL rules receive `ctx.acl` with scoped read-only `db` and `storage` helper namespaces.
- [x] `ctx.acl.db` can inspect app tables by stable table name.
- [x] `ctx.acl.storage` exposes stable storage metadata resource names without leaking raw runtime table names.
- [x] Normal ACL helpers cannot inspect auth, system metadata, log index, or raw runtime-owned tables.
- [x] ACL helper reads do not recursively evaluate normal ACL rules.
- [x] Helper calls are bounded or guarded to avoid accidental policy waterfalls.
- [x] Tests cover cross-table checks, storage metadata checks, recursion avoidance, blocked runtime table access, and async helper usage.

## Blocked by

- .scratch/database-and-storage-acl-rules/issues/02-apply-read-acl-filtering.md
- .scratch/database-and-storage-acl-rules/issues/03-apply-write-acl-transactions.md
