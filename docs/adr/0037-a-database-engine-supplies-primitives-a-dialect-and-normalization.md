# A Database engine supplies statement primitives, a dialect and normalization

A Database engine supplies three things and nothing else. It supplies **statement
primitives**: connection handling, `exec`, and `prepare` yielding `all`, `get`,
`run` and `columns`, together with the transaction session mechanics that go with
them. It supplies a **dialect**: the closed set of places where the engines
genuinely cannot agree on the text of a statement. And it supplies **row and
value normalization**: how a result row's column names map back to the ones the
runtime declared, and how a value out of the engine's wire format becomes the
JavaScript the runtime expects.

Every behavioural method body comes from one shared module. An engine's adapter
is that shared method set spread over the five things above, and an engine
supplies no method body of its own. SQLite is an engine like the others rather
than the thing the others borrow from.

## What this replaces

ADR-0034 described a codebase in which the method set was an object literal on
the SQLite adapter, and the Postgres and libSQL adapters built themselves by
constructing a throwaway in-memory SQLite adapter, spreading its methods, and
overriding the statement primitives with asynchronous ones. "Engine-agnostic"
therefore meant "whatever SQLite's implementation happens to contain", and the
overriding did not stop at the primitives: Postgres replaced roughly 23 further
methods and libSQL roughly 18. Those parts of ADR-0034 describe a state of the
code that no longer exists; its invariant, its dual-mode return convention and
its three categories of override are unchanged and are what this decision is
built on.

The borrowing was not merely untidy. The shared bodies were written against
synchronous primitives because they *were* the SQLite implementation, which is
the mechanism that produced every defect the conformance work fixed. And they
emitted SQLite's dialect, so an engine that could not speak it had to override
rather than inherit — which is how a difference of one quoting character or one
catalog table came to cost a whole second copy of a method.

## Why the difference goes in a dialect rather than in a method body

ADR-0034 licenses exactly one kind of per-engine difference: an override may
change the statement text a method emits, and may never change the answer the
method gives. Reading an override cannot establish which of those it did, which
is why ADR-0035 runs the same specification against each of them.

A dialect entry makes the licence structural instead of a promise a reviewer has
to check. `upsertSql` can only produce statement text; it has no way to answer a
question differently. The seam therefore does what the conformance specification
verifies, one layer earlier: the specification catches an engine that disagrees
about an answer, and the seam removes the place an engine would have written the
disagreement.

The dialect is closed rather than open-ended, and each entry earned its place by
being the sole reason a method was duplicated:

- **`quoteIdentifier`** — Postgres folds an unquoted identifier to lower case;
  MySQL quotes with backticks.
- **`columnType`** — the declared field type as the engine names it.
- **`upsertSql`** — `INSERT OR REPLACE` against `ON CONFLICT ... DO UPDATE`.
- **`listTables`** and **`describeColumns`** — the catalog. `sqlite_schema` and
  `PRAGMA table_info` are SQLite's alone; `information_schema` is the standard.
- **`addMissingColumn`** — `ADD COLUMN IF NOT EXISTS` on Postgres against an
  ALTER whose duplicate-column error is swallowed on SQLite, which has no such
  clause.

`addMissingColumn` is the entry that pays for itself twice. Swallowing a
duplicate-column error on Postgres aborts the enclosing transaction, so every
statement after it fails with `current transaction is aborted`; storage bootstrap
runs outside the migration transaction to keep that hazard out of reach. Asking
Postgres not to raise the error removes the hazard rather than routing around it,
while SQLite keeps the only strategy it has. That is what a dialect entry is for,
and it is not a difference either engine could have expressed as "the same SQL,
awaited".

The unbounded-limit form was on the list of expected entries and is not on this
one. `LIMIT -1 OFFSET ?` was SQLite's alone, and ADR-0036 removed the need for it
by expressing the Log index bound as the retained set rather than as an offset. A
dialect entry with no caller would have been a seam for a difference the codebase
no longer has.

## What is required, and what happens when it is missing

Both the dialect and the normalization are constructed through a factory that
requires every entry and throws if one is absent. A new engine cannot
half-answer the seam: the gap is a failure at adapter construction rather than at
the first statement that needed the entry, which on this seam means the first
Capsule boot on the engine nobody ran the suite against.

Normalization derives `row` from `columnName` and `value` rather than taking it,
so an engine cannot apply one and forget the other. That closes the shape of
issue 03's defect one level up — a missing `verifierHash` spelling rejected every
valid password Reset code on Postgres — without claiming to close the defect
itself. A spelling absent from the Postgres map is still a silent wrong answer,
and the check that catches it is still the derived completeness test issue 08
added. Making a missing spelling impossible rather than visible needs the runtime
to stop emitting DDL that folds, which is issue 12's remit and not this
decision's.

## What a new engine implements

Enough to start one without reading the SQLite adapter.

**Statement primitives.** A factory that opens a connection and returns an object
carrying `engine`, `exec(sql)`, and `prepare(sql)` yielding `all(...params)`,
`get(...params)`, `run(...params)` and `columns()`. `run` answers
`{ changes, lastInsertRowid }`. `all` answers an array of rows. `get` answers a
row, or an absent value for no row — SQLite's answers `undefined` and the service
engines' answer `null`, and shared bodies `?? null` over the difference rather
than relying on either; a new engine may answer whichever its driver gives.
`columns` answers `[{ name }]` for the statement's result shape without reading
its rows. Every one of these may answer a value or a Promise of one — the
dual-mode convention ADR-0034 retains, and the reason ADR-0034's invariant
exists.

`columns` is the primitive most likely to catch out a new engine, because an
engine that cannot ask for a result shape directly has to embed the caller's SQL
in something else, and embedding is not syntax-transparent. Postgres wraps the
statement in a subquery bounded to no rows, and a trailing semicolon or trailing
line comment — both legal input that the inspection validator deliberately
admits — turns the wrapped form into a syntax error. Strip the statement
terminator and any trailing trivia before embedding;
`sqlWithoutTrailingTerminator` does that with the same string-and-comment walk the
validator uses, so a `;` or `--` inside a string literal stays text. Whether a
query answers must not depend on whether the human typed a semicolon.

An engine that describes by embedding issues two statements where one might do,
and that is accepted deliberately. Merging them would mean caching a result on
the prepared-statement object so `columns()` and a later `all()` share it, which
the other engines' statements do not do — a statement held across two reads would
then answer stale rows on one engine and fresh rows on the others, which is a new
per-engine behavioural difference bought inside the seam that exists to remove
them. The bound makes the trade cheap: against a 200k-row table the `LIMIT 0`
probe measures 0.3ms against the read's 79.5ms, because the engine plans the
statement and stops before materializing a row.

**Transaction session mechanics.** `withTransaction(fn)`, which calls `fn` with
an adapter whose statements run inside the transaction, and
`withReadOnlySnapshot(fn)`. Plus `close()`. These five — `exec`, `prepare`,
`withTransaction`, `withReadOnlySnapshot`, `close` — are the whole of what an
engine may define for itself, and they are exactly the five the conformance
coverage gate exempts under ADR-0035's three mechanics.

**A dialect**, built with the dialect factory, answering every entry listed
above.

**A normalization**, built with the normalization factory, answering `name`,
`columnName` and `value`. If the engine preserves declared case and hands back
JavaScript values, both are the identity, and writing the identity down is the
point: an identity mapping that is declared is checkable where an absent one is
not.

**Nothing else.** The adapter is
`{ ...createSharedDatabaseAdapterMethods(dialect), engine, dialect, normalization, ...primitives }`.
Spread rather than inherited, because the conformance coverage gate enumerates
own enumerable function properties and must see the same method names on every
engine. If a shared body cannot be made to work on the new engine, the answer is
a dialect entry, not a method body: a method body is how a behavioural divergence
gets in, and how the shared definition it shadows stays wrong and dormant until
the next engine borrows it.

The specification to build against is ADR-0035's, not a reading of any adapter.
Add the engine to the conformance engine list and the suite tells you what is
still missing, which is what a new engine wants and what reverse-engineering the
SQLite adapter never gave.

## How the seam is kept

`test/database-adapter-engine-seam.test.js` asserts the structure rather than
counting it: every engine overrides exactly the five mechanics and no behavioural
body, every dialect and normalization answers the whole seam, and the SQLite
adapter is the shared method set plus those five mechanics and nothing else. A
count in a commit message is something a later reader has to recompute; this is
the same claim written so the build keeps it.

That also settles a finding from issue 09's review. `migrateAppSchema` reaches
the in-transaction table rebuild directly rather than through
`migrateExistingAppTable`, because libSQL's transaction adapter throws on a
nested `withTransaction`, and the reviewer asked what happens when an engine
overrides that method — the migration would bypass the override, silently. Under
this seam an engine has nowhere to put such an override, so the direct call skips
a transaction wrapper and nothing else.

## Relationship to existing decisions

This extends ADR-0021, which establishes the Database adapter as an internal
runtime boundary and states that code above it remains agnostic to the selected
engine. ADR-0021 asserts the agnosticism, ADR-0034 states what a method has to do
to deliver it, ADR-0035 states how that is verified, and this decision states how
an engine is built so that the agnosticism has one place to live. It does not add
a public Database adapter or plugin API, which ADR-0021 defers; the dialect and
normalization factories are internal.

Nothing here weakens ADR-0035. The conformance specification is unchanged, runs
against the same three engines, and issue 06's coverage gate keeps its rule that
being overridden by an engine is never a reason to exempt a method from a case.
That rule now has less to do, which is the point of it having existed.

Nothing here changes `ctx.db`, the Sporades DB API, or any Capsule authoring
surface.
