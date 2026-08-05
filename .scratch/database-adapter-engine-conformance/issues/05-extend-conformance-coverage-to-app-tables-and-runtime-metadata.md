Status: ready-for-agent

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

Schema migration is partly engine-specific — libSQL has its own migration path —
so cover the additive migration outcome that code above the adapter depends on,
adding a table and adding a field with a default, and leave dialect-level DDL
emission to the existing per-engine tests.

Any divergence found is fixed at the single shared definition rather than by
overriding the method on one engine's adapter.

## Acceptance criteria

- [ ] App row insertion, lookup by identifier, update, owner-scoped update, and deletion are covered.
- [ ] The row selection shapes the runtime relies on are covered, including column projection and filtering by field.
- [ ] Reference integrity is asserted for both a reference that resolves and one that does not.
- [ ] System metadata and schema metadata round trip correctly on every engine.
- [ ] Log index write, recent read, and prune are covered.
- [ ] Additive schema migration is covered for adding a table and adding a field with a default value; dialect-level DDL emission remains in per-engine tests.
- [ ] Any divergence found is fixed at the shared method definition, not by adding a per-engine override.
- [ ] Each case that exposed a divergence remains in the specification as a regression case.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/02-run-conformance-specification-against-every-adapter.md
