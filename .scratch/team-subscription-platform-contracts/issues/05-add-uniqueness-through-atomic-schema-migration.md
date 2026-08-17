# 05 — Add uniqueness through atomic Capsule schema migration

**What to build:** Let an existing Capsule table adopt an additional unique constraint without losing valid rows or schema state, while duplicate existing data causes one opaque atomic failure on every supported Database adapter.

**Blocked by:** 03 — Declare unique constraints on Capsule tables

**Status:** done

- [ ] Adding a new unique constraint to an existing table is accepted as an additive Capsule schema migration.
- [ ] Removing, weakening, changing, or replacing an existing unique constraint remains an unsupported schema change with a clear command error.
- [ ] Existing non-conflicting rows survive constraint installation unchanged and the committed schema metadata/hash records the new constraint.
- [ ] Existing duplicates make the migration fail atomically, preserving the original table, every original row, and the prior schema metadata/hash.
- [ ] Failed migrations leave no temporary tables, partial indexes, partial constraints, or other engine-specific debris.
- [ ] Engine duplicate diagnostics are translated into a stable opaque command error; PostgreSQL duplicate-key details and conflicting values never escape.
- [ ] Constraint collection ordering remains deterministic across equivalent declaration orderings without changing composite field order.
- [ ] SQLite, libSQL, and PostgreSQL prove identical migration outcomes through the shared conformance specification and real transaction mechanics.
