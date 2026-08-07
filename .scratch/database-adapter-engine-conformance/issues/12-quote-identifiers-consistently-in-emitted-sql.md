Status: done

# Quote Identifiers Consistently In Emitted SQL

## Decision

Made by the maintainer on 2026-08-06, so implement it rather than reopening it.

The runtime settles identifier casing by quoting everywhere: every identifier in
emitted SQL is quoted through the dialect, including the runtime's own DDL, so
Postgres never folds and every declared camelCase spelling is preserved on every
engine. The Postgres column-name map is then deleted — with nothing folded there
is nothing to restore, and the app-column collision hazard disappears by
construction rather than by narrowing.

No data migration ships with this. There are currently no installed Capsules
using a Postgres Capsule service, so no deployed schema holds folded-lowercase
columns; a pre-release Postgres database created by the old unquoted DDL is
recreated rather than upgraded. Record in the ADR that this window existed and
closed here — the same change after the first deployed Postgres Capsule would
have been a migration project, and a future reader deserves to know why it was
not one.

## What to build

The live defect that forced the question, found the first time the conformance
specification ran against a real Postgres: app table columns are created quoted
(`appFieldColumnDefinition` wraps each field name in `quoteIdentifier`, so
Postgres stores `"ownerId"` case-preserved), while the owner-scope predicate is
emitted unquoted and folds to `ownerid`. Any owner-scoped app-table operation
errors outright on Postgres with `column "ownerid" does not exist` — and app
tables are what Capsule code reaches through `ctx.db`, so this is not a corner
of the runtime. Runtime-owned tables escaped only by luck: their DDL was
unquoted too, so both halves folded consistently. SQLite folds nothing, which is
why the inconsistency was invisible on the default engine.

The fix is the decision above, applied everywhere, not a patch to the predicate
that happened to fail first. Audit every statement the runtime emits — DDL, DML,
predicates, indexes, catalog probes — and route every identifier through the
dialect's quoting. The known failing predicate is in the app-row update, but
three conformance cases fail today (`updateAppRow`, `selectAppRows`,
`dumpInspectableDatabase`), so establish the real set of offending sites before
fixing rather than assuming it is one.

Quoting the runtime's own DDL has consequences this ticket owns:

- **The Postgres column-name map is deleted.** ADR-0037's normalization seam
  stays — it is the seam entry, not the map — but Postgres's `columnName`
  becomes the identity, matching the other engines. The per-key rename hazard
  recorded below goes with it.
- **Issue 08's guard is reworked, not discarded.** Its completeness check
  asserted that no runtime table declares a camelCase column the map cannot
  restore. Its successor asserts the stronger thing quoting makes true: every
  runtime table's declared spellings round-trip through the Postgres read path
  with no lookup in between. The `verifierHash` regression case asserts the
  round-trip, not the mechanism, so it must stay green throughout.
- **Bootstraps and additive migrations quote too.** The duplicate-tolerant
  `ALTER TABLE ... ADD COLUMN` idiom and every `CREATE TABLE IF NOT EXISTS`
  follow the same rule; a half-quoted codebase is the disease this ticket cures,
  so no site is exempt because it is old or rarely runs.

## Second symptom, resolved by construction

The Postgres column-name map was applied per result key with no table
provenance, so a Capsule field literally named `errorcode` or `jobid` read back
renamed to `errorCode` or `jobId`. That hazard pre-existed issue 08 and was
widened by it; it is recorded here because deleting the map is the only fix that
removes it rather than shrinking it. With quoting settled and the map gone, an
app column round-trips under its own declared name whatever it is called —
prove that with the collision names that used to rename.

## Acceptance criteria

- [ ] Every identifier in emitted SQL is quoted through the dialect; no statement names a column in a style the table was not created with, on any engine.
- [ ] Owner-scoped app-table update and select work on Postgres, demonstrated by conformance cases that fail against the current code; the three known failing cases go green.
- [ ] The Postgres column-name map is deleted, and Postgres row normalization preserves declared spellings with no lookup.
- [ ] An app table column named `errorcode` or `jobid` round-trips under its own declared name on every engine.
- [ ] Issue 08's round-trip guard is reworked to assert declared spellings survive the Postgres read path, and is demonstrated to fail against a deliberately unquoted statement.
- [ ] The full conformance specification passes on SQLite, libSQL and Postgres.
- [ ] An ADR records the decision: quoting everywhere, the map's deletion, and that no installed Postgres Capsule existed so no migration shipped.

## Blocked by

- None — can start immediately.
