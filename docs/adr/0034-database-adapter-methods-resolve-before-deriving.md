# Database adapter methods are engine-agnostic and resolve before deriving

The Database adapter method set is engine-agnostic and defined once. Every
engine presents the same methods with the same names, arguments, and meanings,
and what a method answers for a given stored state must be identical on every
engine. A behavioral method body must not diverge by engine. How a method
phrases the SQL that gets it that answer may differ, because dialects differ;
what it concludes may not.

## Where the code is today

That is the target, and the codebase does not fully reach it yet. The method set
is written as one object on the SQLite adapter, and the Postgres and libSQL
adapters build themselves by constructing a throwaway SQLite adapter, spreading
its methods, and overriding `exec` and `prepare` with asynchronous versions. But
the overriding does not stop at the statement primitives: Postgres replaces
roughly 23 further methods and libSQL roughly 18, including `ensureAuthStorage`,
`migrateExistingAppTable`, `insertLogIndexEvent`, `pruneLogIndex`,
`readRecentLogEvents`, `readUserPreferences`, `saveUserPreferences`,
`writeSystemMetadata`, `listInspectableTables`, `dumpInspectableDatabase`,
`runReadOnlyInspectionQuery`, and `consumeOAuthState`. Several have genuinely
different bodies — `consumeOAuthState` is a SELECT followed by a DELETE in the
shared definition and a single `DELETE ... RETURNING` on Postgres.

Those overrides exist for dialect and DDL reasons, and that is the only reason
that licenses one. This is the same line ADR-0035 draws when it leaves SQL
dialect emission in per-engine tests: an override may change the statement text
a method emits; it may not change the answer the method gives. An override that
exists because the shared body computes the wrong thing is not a dialect
override, and reducing the override count is the direction of travel rather than
a settled state.

The distinction is not hypothetical. At least one shared definition is still
non-compliant with this ADR and survives only because it is shadowed:
`runReadOnlyInspectionQuery` derives its column names from `statement.columns()`
and filters its rows from `statement.all()` without resolving either, so on an
asynchronous engine it would map and filter Promises. It is dormant rather than
correct, because both Postgres and libSQL happen to override it. A shadow is not
a fix — the shared definition is a latent defect that becomes live the moment an
engine stops shadowing it, or a new engine adapter borrows the set without
knowing to.

## The invariant

A Database adapter method must never derive a value, a branch, or a guard from
an unresolved query result. It may return a query result directly and let the
caller await it. It may not test it, count it, coerce it, or read a property off
it without resolving it first.

Stated mechanically, for citation in review: **inside a Database adapter method,
any value produced by a statement primitive — `get()`, `all()`, `run()`, or
`columns()` — or by another Database adapter method must be resolved before
anything is derived from it.** Both halves of that are load-bearing. `columns()`
is as much a statement primitive as `get()`, and returns a Promise on both
asynchronous engines. And the sibling-method half is what a rule about
`prepare(...)` alone would miss: the Upload defect described below branched on
`this.selectFileById(...)`, not on a `prepare(...)` call, and a rule scoped to
statement primitives would have waved it through. A method that needs to look at
a result uses the runtime's existing promise-aware helpers — `thenIfPromise` and
`chainMaybePromise` — so that one definition stays correct whether what it
called was synchronous or asynchronous.

The invariant exists because violating it produces silent wrong answers rather
than errors. A pending query is a truthy object with no useful properties, so
`Boolean(pendingQuery)` is always `true`, `Number(pendingQuery?.count ?? 0)` is
always `0`, and a branch on `pendingQuery.changes` always takes the same path.
Nothing throws and no request fails. Six shipped defects came from this one
mechanism: an email credential existence check that reported every address as
already registered and so made email sign-up impossible on Postgres and libSQL;
a reference integrity check of the same shape, so `Reference()` never rejected a
reference to a row that does not exist; an Upload call whose completion branched
on an unresolved sibling method result and therefore never wrote the File
metadata row for a new file; two reserved-user guards that tested a Promise,
never fired, and left the reserved Privileged server role identity readable as
an ordinary Sporades user through Session and email credential lookups; and an
outstanding-Reset code count that always returned zero, leaving the ADR-0033 cap
inert. Each was correct where it was written and became wrong only when a
different adapter borrowed it.

## Async-first was considered and rejected

The obvious stronger rule is to make every Database adapter method return a
Promise, so there is no synchronous mode to get wrong. That option is rejected,
and it is rejected on a specific constraint rather than on taste.

ADR-0022 exposes a constrained read-only ACL context to ACL rules, with scoped
helpers including `ctx.acl.db.get()` and `ctx.acl.storage.get()`. The runtime
implements those helpers to fail closed when the underlying adapter read is
asynchronous: a synchronous ACL rule that cannot see the resolved value denies.
Making every adapter read asynchronous would therefore make every synchronous
ACL rule that reads through an ACL context helper fail closed on every engine,
including SQLite in a Dev session. That is a Capsule-facing breaking change to
working Capsules, which is a worse outcome than the defect class this ADR
closes.

The cost is bounded, and stating it accurately matters more than stating it
dramatically. The fail-closed flag is only ever set from inside the
`ctx.acl.db.*` and `ctx.acl.storage.*` helpers, so a synchronous ACL rule that
decides from `ctx`, `previous`, `next`, or the row alone is unaffected — and
that is the common case. It is also worth keeping two things separate: ADR-0022
mandates the ACL context helpers and their read-only vocabulary, but says
nothing about asynchrony or about failing closed. The fail-closed response to an
asynchronous read is a property of the current runtime implementation, not an
ADR-0022 requirement, and could in principle be changed by a decision that faced
what synchronous ACL rules should then do.

A future reader must not reopen async-first without meeting that constraint
first. What happens to synchronous ACL rules that read through an ACL context
helper is an ADR-0022 question and needs its own specification; until it is
answered, the dual-mode return convention stays and the invariant above is what
keeps it safe.

## The dual-mode return convention

A Database adapter method may return either a plain value or a Promise. This is
deliberate rather than a leftover of the `node:sqlite` extraction: on SQLite a
read returns a row, and on Postgres or libSQL the same method returns a Promise
of that row, and callers are written to tolerate both. It is retained for the
reason given above, not because it is convenient, and the invariant is the price
of retaining it.

## Relationship to existing decisions

This extends ADR-0021, which establishes the Database adapter as an internal
runtime boundary below `ctx.db` and states that code above it remains agnostic
to the selected engine. ADR-0021 asserts that agnosticism; this ADR states what
the method set has to do to deliver it, and ADR-0035 states how that is
verified.

This narrows rather than reverses the completed decision in
`.scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md`.
That decision governs how call sites consume Database adapter methods — runtime
paths for app tables, auth storage, File metadata storage, the Log index, schema
migration, and inspection can await adapter operations without changing the
Sporades DB API that Capsule handlers reach through `ctx.db`. This ADR governs
how a Database adapter method consumes its own statement primitives and its own
sibling methods. Both hold at once, and the second is not implied by the first:
awaiting at the call site does not help when the wrong value was already
computed inside the method.

Nothing here changes ADR-0026. Workflow-level Transaction boundaries continue to
be verified above the Database adapter, and engine mechanics continue to be
verified at the boundary; this ADR constrains what a single adapter method does
with a single statement result, which is a separate concern from where a write
workflow's atomicity is decided. It also does not add a public Database adapter
or plugin API, which ADR-0021 defers.
