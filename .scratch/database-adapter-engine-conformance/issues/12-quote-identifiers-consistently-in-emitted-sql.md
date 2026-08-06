Status: ready-for-agent

# Quote Identifiers Consistently In Emitted SQL

## What to build

Found by running the conformance specification against a real Postgres for the
first time. It is a live defect on the most Capsule-visible surface there is, not
a latent one.

App table columns are created **quoted**: `appFieldColumnDefinition` wraps each
field name in `quoteIdentifier`, so Postgres stores `"ownerId"` with its case
preserved. The owner-scope predicate is emitted **unquoted**: the app-row update
appends `" AND ownerId = ?"`, which Postgres folds to `ownerid`. That column does
not exist, so the statement fails with `column "ownerid" does not exist`.

The effect is that any owner-scoped app-table operation errors outright on
Postgres. App tables are what Capsule code reaches through `ctx.db`, so this is
not a corner of the runtime.

Runtime-owned tables are unaffected only by luck: their DDL is unquoted too, so
both halves fold consistently to lowercase and match. That is why the File
metadata and auth storage surfaces pass on Postgres while app tables do not.

The bug is the inconsistency, not the quoting. Two halves of the same feature
disagree about whether identifiers are quoted, and SQLite cannot tell the
difference because it folds nothing — so the divergence is invisible on the
default engine and fatal on Postgres. Fix it by settling the question one way for
all emitted SQL rather than by adding quotes at the one call site that failed;
patching the single predicate would leave the same trap set for the next one.

Whichever way it is settled, note that the DDL is already deployed in both
styles, so changing the quoting of existing tables is a migration question and
not merely a code change. Decide deliberately whether existing Capsules keep
working.

Check for the same shape elsewhere: any place emitted SQL names a camelCase
column without going through the shared quoting helper is a candidate.

## Relationship to issue 08

Issue 08 covers the read path — restoring camelCase names from Postgres's folded
result columns. This is the write path: what casing the SQL text asks for in the
first place. They are the same underlying question about identifier casing and
may be worth one coherent answer, so issue 08 was told about this finding and
asked whether its chosen mechanism resolves it. If issue 08 takes it, close this
as superseded rather than doing the work twice.

## Acceptance criteria

- [ ] Emitted SQL is consistent about identifier quoting; no statement names a column in a style the table was not created with.
- [ ] Owner-scoped app-table update and select work on Postgres, demonstrated by a conformance case that fails against the current code.
- [ ] The other places emitting bare camelCase column names are audited and brought into line, not just the predicate that failed.
- [ ] Any change to the quoting of already-created tables is accompanied by a deliberate decision about existing deployments, recorded in the issue or an ADR.
- [ ] The full conformance specification passes on SQLite, libSQL and Postgres.

## Blocked by

- None — can start immediately.
