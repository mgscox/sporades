Status: done

# Extract The Shared Method Set Behind An Engine Seam

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Make the engine-agnostic part of the Database adapter a real thing rather than an
implicit one, so a new engine implements only what is genuinely engine-specific.

Today there is no generic adapter. `createRuntimeDatabaseAdapter` looks like one
but is only a selector with three branches. The shared method set is the SQLite
adapter's own object literal: Postgres and libSQL each construct a throwaway
in-memory SQLite adapter, spread its methods, and swap the statement primitives
for asynchronous ones. "Generic" is therefore whatever SQLite's implementation
happens to contain.

That is not merely untidy, and this feature has already paid for it twice. The
shared bodies were written against synchronous primitives because they *are* the
SQLite implementation, which is what produced every defect this feature fixed.
And the shared bodies emit SQLite dialect, so an engine that cannot speak it must
override rather than inherit.

The second cost is the one that blocks new engines. `quoteIdentifier` is shared
and hard-codes double quotes; MySQL quotes with backticks, so nearly every
app-table method would need overriding purely to change a quoting character. The
shared set also contains `INSERT OR REPLACE`, `PRAGMA table_info`,
`PRAGMA query_only` and `sqlite_schema`. Under the current structure a MySQL
adapter would re-implement a large fraction of the method set, which is the
opposite of what the boundary is for.

Note before starting: Turso needs no new adapter. The libSQL adapter already
speaks the `/v2/pipeline` HTTP protocol with a bearer auth token, which is
Turso's API. Turso works today through `engine: libsql` with a Turso URL and
`SPORADES_SERVICE_DATABASE_AUTH_TOKEN`.

## The seam

Define the method set once, in its own module, parameterised by what actually
differs between engines. An engine supplies three things and nothing else:

**Statement primitives** — connection handling plus `exec` and `prepare`, where
`prepare` yields `all`, `get`, `run` and `columns`. This seam already exists and
works; it is the only part of the current design worth keeping as-is.

**Dialect** — the places where engines genuinely cannot agree on SQL text.
Identifier quoting; the upsert form; the unbounded-limit form that
`LIMIT -1 OFFSET ?` expresses on SQLite; column type mapping; the catalog queries
behind listing tables and describing columns; and the strategy for adding a
missing column, which is `ADD COLUMN IF NOT EXISTS` on Postgres and a
`PRAGMA table_info` probe on SQLite. ADR-0034 already licenses exactly this
category and no more.

**Row and value normalization** — how result rows map back to the runtime's
camelCase field names, and how typed values are coerced. This is where issue 03's
`verifierHash` defect lived and where issue 08 is working; the seam should make a
missing mapping impossible rather than merely visible.

Everything else — every behavioural method body — comes from the shared module.
SQLite becomes an engine like the others rather than the thing the others borrow
from. No adapter constructs a throwaway adapter of another engine to obtain its
methods.

## Constraints

The conformance specification is the acceptance oracle. It already defines what
correct adapter behaviour is, independently of engine, and issue 06's gate
already requires every method to have a case. A refactor of this size is only
safe because that exists: the suite must stay green throughout, and the coverage
gate must keep passing, with no case weakened or exempted to accommodate the new
structure.

The number of per-engine overrides must go down, not up. It is currently around
28 after this feature's deletions. An extraction that leaves it flat has moved
code without changing the property that matters.

ADR-0034's invariant still holds inside the shared module: no method may derive a
value, branch or guard from an unresolved query result, and a writing method must
return its statement result. The dual-mode return convention stays, for the ACL
reasons ADR-0034 records.

This is a large structural change to the runtime's persistence layer. Do it as an
expand-and-contract sequence with the suite green at every step, not as one
commit. Adding MySQL is explicitly **not** in scope — the deliverable is the seam
and the proof that it is a seam.

## Acceptance criteria

- [x] The engine-agnostic method set is defined once in its own module, not inside any engine's adapter.
- [x] No adapter obtains its methods by constructing and spreading another engine's adapter.
- [x] An engine is defined by statement primitives, a dialect, and row/value normalization; it supplies no behavioural method bodies of its own except where ADR-0034 licenses a dialect override.
- [x] Identifier quoting, the upsert form, the unbounded-limit form, catalog queries and add-column strategy come from the dialect rather than from shared SQL text.
- [x] The total count of per-engine behavioural overrides is lower than before this change, and the remaining ones are each justified in the ADR-0034 categories.
- [x] The conformance specification passes unchanged on every engine, and issue 06's coverage gate still passes with no new exemptions.
- [x] A short written account of what a new engine must implement, sufficient to start one without reading the SQLite adapter.
- [x] An ADR records the seam and supersedes or amends the parts of ADR-0034 that describe the borrow-and-override structure as the current state.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/08-map-every-runtime-column-name-on-postgres.md

Row and value normalization is one of the three things this seam must define, and
issue 08 is deciding how column-name mapping should work. Designing the seam
against that answer rather than around an open question is worth the wait.

## Outcome

ADR-0037 records the seam. Per-engine behavioural overrides went from 14 (libSQL
3, Postgres 11) to 0 across a 77-method set, in five green steps.

The dialect ended up with seven entries: `name`, `quoteIdentifier`, `columnType`,
`upsertSql`, `listTables`, `describeColumns`, `addMissingColumn`. The
unbounded-limit form was expected and is absent — ADR-0036 removed the only
caller, and a seam entry with no caller is a seam for a difference the codebase
no longer has.

Two things were resolved rather than parameterised, because all three engines
agreed once the question was asked. App-table DDL now quotes `id`, `createdAt`
and `updatedAt` like every other column, which is what Postgres already emitted
and what SQLite and libSQL cannot tell apart; that deleted the Postgres
`createAppTable` override without a dialect entry. And `consumeOAuthState` is one
`DELETE ... RETURNING` on every engine, node:sqlite included; the two-statement
shared form was a race on the asynchronous engines, which is why both of them
overrode it.

`addMissingColumn` also removed a hazard rather than routing around it. Postgres
gets `ADD COLUMN IF NOT EXISTS`, so no duplicate-column error is raised for a
`catch` to swallow and abort the enclosing transaction with. Storage bootstrap
still runs outside the migration transaction.

Issue 09's review finding — that a future engine override of
`migrateExistingAppTable` would be silently bypassed from inside a migration — is
answered structurally: an engine has nowhere to put such an override, and
`test/database-adapter-engine-seam.test.js` fails if that stops being true.

Not done here, deliberately: the identifier-quoting defect (issue 12), which is
also what would let the Postgres column-name map be deleted and make a missing
mapping impossible rather than merely visible. The seam makes an incomplete
normalization impossible; it does not make an incomplete map impossible, and
ADR-0037 says so.
