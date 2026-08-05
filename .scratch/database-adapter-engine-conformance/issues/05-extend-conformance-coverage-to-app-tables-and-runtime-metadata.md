Status: done

# Extend Conformance Coverage To App Tables And Runtime Metadata

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Bring the remaining runtime storage surfaces under the conformance
specification: app table operations, reference integrity, system and schema
metadata, and the Log index.

App table operations are what Capsule code reaches through `ctx.db`, so a
divergence here is the most directly visible to a Capsule author. Cover row
insertion, lookup by identifier, update with and without an owner scope, deletion,
and the query shapes the runtime uses when selecting rows — column projection and
filtering by field.

Reference integrity needs both sides exercised explicitly. The known defect
accepted every reference because it derived a boolean from an unresolved query,
so a case that only checks a reference that does exist would still pass against
the broken implementation.

Cover system metadata and schema metadata round trips, reading back what was
written. Cover the Log index: writing an event, reading recent events, and
pruning to a bound. The Log index is explicitly allowed to degrade rather than
roll back a workflow, so assert its storage behaviour rather than inventing
failure semantics for it.

Cover the inspection surface too: listing inspectable tables, dumping the
inspectable database, and running a read-only inspection query. These were added
to this ticket after ADR-0034 landed, because the shared definitions of
`runReadOnlyInspectionQuery`, `readRecentLogEvents`, `listInspectableTables` and
`dumpInspectableDatabase` all derive from unresolved results today and are
correct on Postgres and libSQL only because each engine happens to override
them. A conformance case must exist for the shared behaviour regardless of that
shadowing, or the suite will miss precisely the defect class it was built for.

One shape here is not a returned value and needs its own assertion style. The
shared `insertLogIndexEvent` and `pruneLogIndex` are write-only and discard
their statement result, so a caller cannot tell when the write has landed —
harmless on SQLite where it already has, wrong on the async engines where it has
not. ADR-0034's fourth rule limb requires a writing method to return its
statement result. Assert that a write is observable once the method's result has
been awaited, on every engine.

Schema migration is partly engine-specific — libSQL has its own migration path —
so cover the additive migration outcome that code above the adapter depends on,
adding a table and adding a field with a default, and leave dialect-level DDL
emission to the existing per-engine tests.

Any divergence found is fixed at the single shared definition rather than by
overriding the method on one engine's adapter.

## Acceptance criteria

- [x] App row insertion, lookup by identifier, update, owner-scoped update, and deletion are covered.
- [x] The row selection shapes the runtime relies on are covered, including column projection and filtering by field.
- [x] Reference integrity is asserted for both a reference that resolves and one that does not.
- [x] System metadata and schema metadata round trip correctly on every engine.
- [x] Log index write, recent read, and prune are covered.
- [x] Listing inspectable tables, dumping the inspectable database, and running a read-only inspection query are covered on every engine.
- [x] A write performed through a write-only adapter method is observable once that method's result has been awaited, on every engine — covering the shape where the shared definition discards its statement result.
- [x] Additive schema migration is covered for adding a table and adding a field with a default value; dialect-level DDL emission remains in per-engine tests.
- [x] Any divergence found is fixed at the shared method definition, not by adding a per-engine override.
- [x] Each case that exposed a divergence remains in the specification as a regression case.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/02-run-conformance-specification-against-every-adapter.md
- .scratch/database-adapter-engine-conformance/issues/07-open-a-conflict-free-conformance-extension-seam.md
