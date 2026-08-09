# Every identifier in emitted SQL is quoted through the dialect

Every identifier the Sporades runtime puts into a statement — table, column, alias,
index — is quoted through the Database dialect's `quoteIdentifier`. The runtime's
own DDL is not exempt, so Postgres never folds anything the runtime declared, and
every declared camelCase spelling is the spelling stored and the spelling returned
on every Database engine. The Postgres column-name map is deleted: with nothing
folded there is nothing to restore.

## The defect this settles

App table columns were already created quoted, because `appFieldColumnDefinition`
wraps each field name in `quoteIdentifier`, so Postgres stored `"ownerId"`
case-preserved. The owner-scope predicate in `updateAppRow` was emitted bare, and
Postgres folded it to `ownerid`. Every owner-scoped update on an app table
therefore failed outright there with `column "ownerid" does not exist` — and app
tables are what Capsule code reaches through `ctx.db`, so this was not a corner of
the runtime. It was found the first time ADR-0035's conformance specification ran
against a real Postgres.

The runtime-owned tables escaped by luck rather than by design: their DDL was
unquoted too, so both halves of every statement folded consistently. SQLite folds
nothing and libSQL folds nothing, which is why the inconsistency was invisible on
the default engine and on the one service engine anybody had run.

Patching the predicate would have left the codebase half-quoted, which is the
condition that produced the defect. Quoting everywhere removes the condition.

## Why the runtime's own DDL had to be quoted too

Because leaving it unquoted meant keeping the map, and the map was a registry with
no failure mode.

`postgresRuntimeColumnName` held the declared spelling of every camelCase column on
every runtime-owned table, so that a folded result key could be turned back into the
name the runtime reads. A column missing from it was not an error anywhere: the read
answered `undefined` for that field and the runtime carried on. That is how a missing
`verifierHash` entry rejected every valid password Reset code on Postgres while
presenting the user an ordinary "invalid code", with nothing in any log. Issue 08
found roughly a dozen more absences across the Job queue and Schedule tables and
closed them with a derived completeness check, which made an absence visible; it
could not make one impossible.

The map carried a second hazard that predated issue 08 and that issue 08 widened.
Normalization is applied per result key with no table provenance — the Postgres row
description parser discards the tableOID bytes — so the map was never scoped to
runtime tables. A Capsule field literally named `errorcode` or `jobid` was renamed on
the way out to `errorCode` or `jobId`: a field the Capsule wrote and could not read,
under a name it never chose. Nothing forbade such a field. Narrowing the map would
have shrunk that hazard; deleting it removes it, and deleting it is only possible
once nothing folds.

So Postgres's `columnName` normalization is now the identity, matching SQLite's and
libSQL's. ADR-0037's normalization seam is unchanged — the seam entry stays, and
writing the identity down is still the point, because an identity mapping that is
declared is checkable where an absent one is not. What is gone is the table behind
the entry.

## How a statement says "this is an identifier"

The runtime writes each identifier in its statement text as `[name]`, and
`dialect.sql` turns every marker into the engine's quoting before the statement is
emitted. `sql` is derived inside `createDatabaseDialect` from the `quoteIdentifier`
entry rather than supplied by an engine, for the same reason `createDatabaseNormalization`
derives `row` from `columnName` and `value`: an engine that answered the quoting entry
and then received statement text which had bypassed it would fold anyway.

The marker is deliberately not the answer. Writing `"ownerId"` directly into the
statement text would be correct on all three engines this runtime speaks, and would
silently bypass the one dialect entry that exists for the engine whose quoting
differs — ADR-0037 lists MySQL's backticks as that entry's reason. A marker that has
to be resolved cannot be resolved by accident.

It is a substitution rather than a parse, and that is safe because of where the text
comes from. Every marker-bearing statement is authored in the runtime source; no
Capsule value and no `sporades db query` input reaches one, since parameters are
bound and never interpolated. Where a statement does carry a dynamic identifier —
an app table's name, a Capsule field name — it is quoted with `dialect.quoteIdentifier`
directly and concatenated, never interpolated into a string that is then scanned.
A statement built without the dialect fails loudly on Postgres now rather than
quietly: an unquoted `createdAt` no longer matches a column stored as `"createdAt"`.

One statement the runtime hands an engine is not the runtime's to quote.
`runReadOnlyInspectionQuery` carries what a human typed at `sporades db query`, and
it reaches the engine as typed, because rewriting an operator's identifiers would
change the answer they asked for. That is the one exception, it is the only one, and
the check below names it rather than quietly tolerating anything query-shaped.

The audit that came with this covered every statement the runtime emits, not the one
that failed first: the shared adapter method set, the auth storage bootstrap and its
additive `ALTER TABLE` migrations, File metadata storage and its backfills and
indexes, the Log index bootstrap and ADR-0036's ordering backfill, the Job queue and
Schedule bootstraps and every runtime read and write against them, the system table,
user preferences, the upsert form, the catalog queries behind `listTables` and
`describeColumns`, and the health probe's alias. No site was exempt for being old or
rarely run; a half-quoted codebase is the disease.

## The migration that did not ship, and the window that closed here

No data migration ships with this decision, and that is a fact about when it was
made rather than a judgement that one was unnecessary.

At the time of this change there were no installed Capsules using a Postgres Capsule
service, so no deployed schema held folded-lowercase columns. A pre-release Postgres
database created by the old unquoted DDL is recreated rather than upgraded, and what
happens to one that is not was run rather than reasoned about: a table created there
by the old DDL holds `createdat` and `verifierhash`; the read the runtime now emits
raises `column "createdAt" does not exist`; and re-running the quoted
`CREATE TABLE IF NOT EXISTS` does not repair it, because the table already exists and
the statement is a no-op. Such a database fails on the first read rather than
answering wrongly, which is the right failure for a pre-release state — but it is a
failure, and the fix is to delete the Runtime state and let the Capsule bootstrap
again.

The same change made after the first deployed Postgres Capsule would have been a
migration project — a rename of every camelCase column on sixteen runtime-owned
tables, executed against live Capsule data, with a runtime that has to read both
shapes while it runs. It was not one only because the window was still open. A future
reader who wonders why a decision of this reach shipped without a migration should
find that answer here rather than infer that identifier casing is cheap to change.

## What keeps it

`test/postgres-runtime-column-names.test.js` is the successor to issue 08's
completeness check, and it asserts the stronger thing quoting makes true. It
bootstraps every runtime-owned table exactly as a Capsule start does, enumerates the
columns those tables actually declare on an engine that stores identifiers as
written, and asserts that every declared spelling survives the Postgres read path
with no lookup in between — in both directions, so a name Postgres returns that
nothing declared is reported as well. The check is exercised against its own failure:
a table created on the same live Postgres by a deliberately unquoted `CREATE TABLE`
is reported, and the same table created through the dialect is not.

The `errorcode`/`jobid` round-trip is a conformance case rather than a Postgres test,
because the claim is that every engine answers the same and only one of them ever
answered differently. It asserts the whole key set of the row, not the two fields:
a read that renamed `errorcode` to `errorCode` would collide with the camelCase
column declared beside it and satisfy any assertion that only looked for `errorCode`.

`test/postgres-emitted-sql-quoting.test.js` is the audit kept as a check. It captures
every statement the runtime hands an engine while it bootstraps its own storage —
twice, so the second pass emits the additive `ALTER TABLE ... ADD COLUMN` idiom and
the backfills that follow it against tables that already exist — and while it runs
the whole of the conformance specification, and reports any that names a
runtime-owned table or column unquoted. It reads the emitted text rather than the
source that produced it, so there is no parse to get wrong and a statement assembled
from three concatenated fragments is checked as the one thing the engine receives. Its
bound is the paths it drives, which is why it is a third net and not the only one.

`test/database-adapter-engine-seam.test.js` pins `sql` as a dialect entry and proves
the derivation by building a dialect whose `quoteIdentifier` answers backticks and
watching the same statement come out in them.

One engine difference this work surfaced is worth recording, because it constrains
what a Capsule schema may declare rather than what the runtime emits. SQLite and
libSQL compare identifiers case-insensitively even when they are quoted, so a table
declaring both `errorcode` and `errorCode` is a duplicate-column error there and a
valid table on Postgres. Quoting does not change that and was never going to; the
names round-trip under whatever case they were declared with on every engine, which
is the property this decision is about.

## Relationship to existing decisions

This extends ADR-0021, which makes the Database adapter an internal runtime boundary
that code above remains agnostic to, and ADR-0037, which says an engine supplies
statement primitives, a dialect and normalization and nothing else. ADR-0037 recorded
that making a missing spelling impossible rather than visible needed the runtime to
stop emitting DDL that folds, and left that outside its own remit; this is that
change. It adds no dialect entry — `sql` is derived from `quoteIdentifier`, not a new
place engines may disagree — so the dialect stays the closed set ADR-0037 defines.

Nothing here weakens ADR-0034's invariant or ADR-0035's specification, and the
conformance specification still runs against SQLite, libSQL and Postgres. Nothing
here changes `ctx.db`, the Sporades DB API, or any Capsule authoring surface; a
Capsule field named `errorcode` now reads back as `errorcode`, which is what a
Capsule author would have expected all along.
