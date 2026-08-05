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

Those overrides are not all the same kind of thing, and the difference is the
whole point. Set aside connection and transaction-session mechanics —
`withTransaction`, `withReadOnlySnapshot`, and `close` — which are engine
machinery rather than behavior, and which ADR-0035 likewise leaves to per-engine
tests. Among the overrides that carry behavior there are three kinds, and only
the first is legitimate.

A **dialect or DDL override** emits different SQL because the engines genuinely
differ. `ensureAuthStorage` is the clean example: Postgres needs its own
`CREATE TABLE` column types and uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
where the SQLite definition cannot. This is the same line ADR-0035 draws when it
leaves SQL dialect emission in per-engine tests: an override may change the
statement text a method emits; it may not change the answer the method gives.

An **await-shim override** emits the same SQL as the shared definition and
exists for one reason only — to resolve the result before deriving from it, or
before depending on the write having landed. libSQL's `pruneLogIndex` and
`readRecentLogEvents` are byte-identical in SQL to the shared definitions and
differ only by an `await`. On libSQL this is the dominant category, covering
`insertLogIndexEvent`, `pruneLogIndex`, `readRecentLogEvents`,
`listInspectableTables`, `dumpInspectableDatabase`, and
`runReadOnlyInspectionQuery`; on Postgres most of those also adjust SQL, and
only `insertLogIndexEvent` is a pure same-SQL shim.

A **behavioral divergence** — a method that answers differently on one engine —
is never licensed, on any grounds.

The remedy for an await-shim depends on which of the two hazards the shared body
has, and they are not the same fault. Where the shared body **derives** from an
unresolved result, as `readRecentLogEvents` and `runReadOnlyInspectionQuery` do,
the fix is to make it promise-aware with `thenIfPromise`, exactly as
`completeFileUpload`, `emailCredentialExists`, and `referenceExists` now are.
Where the shared body is **write-only**, as `insertLogIndexEvent` and
`pruneLogIndex` are — both a bare `prepare(...).run(...)` with no `return` —
`thenIfPromise` would change nothing, because nothing is derived. The fix there
is to return the statement result so the caller has something to await. Either
way the shim then disappears rather than being maintained in duplicate.
Reducing the override count is the direction of travel, and these are the
mechanisms that do it; the count grows when a shim is added instead.

Leaving an await-shim in place is not neutral, because the shared body it
shadows stays wrong. `runReadOnlyInspectionQuery` is the clearest case: the
shared definition derives its column names from `statement.columns()` and
filters its rows from `statement.all()` without resolving either, so on an
asynchronous engine it would map and filter Promises. It is dormant rather than
correct, because both Postgres and libSQL happen to override it. A shadow is not
a fix — the shared definition is a latent defect that becomes live the moment an
engine stops shadowing it, or a new engine adapter borrows the set without
knowing to. The shared `readRecentLogEvents` is in exactly the same position.

## The invariant

A Database adapter method must never derive a value, a branch, or a guard from
an unresolved query result. It may return a query result directly and let the
caller await it. It may not test it, count it, coerce it, or read a property off
it without resolving it first.

Returning the result is permissive for a method that derives nothing from it and
mandatory for a method that writes. A write-only method that discards its
statement result leaves the caller no way to know when the write has landed:
harmless on SQLite, where it already has, and wrong on Postgres and libSQL,
where it has not.

Stated mechanically, for citation in review: **inside a Database adapter method,
any value produced by a statement primitive — `get()`, `all()`, `run()`, or
`columns()` — by another Database adapter method, or by a helper the method
delegates to that reaches a statement primitive, must be resolved before
anything is derived from it; and a method that writes must return its statement
result rather than discard it.** Each limb corresponds to a shape that has
actually occurred. `columns()` is as much a statement primitive as `get()`,
returns a Promise on both asynchronous engines, and is inspected unresolved in
the shared `runReadOnlyInspectionQuery`. The sibling-method limb is what a rule
about `prepare(...)` alone would miss: the Upload defect described below
branched on `this.selectFileById(...)`, not on a `prepare(...)` call. The
delegation limb matters because a method can be clean at its own call site and
still wrong — the shared `readRecentLogEvents` is a one-line delegation to a
module-level function that does `.all(safeLimit).reverse().map(...)` on an
unresolved result, so reviewing only the method body would clear it.

The final limb catches a shape none of the others reach. A contributor adding
`deleteWidget(id) { this.prepare("DELETE ...").run(id); }` to the shared set
derives nothing and passes every other limb cleanly, yet ships a method whose
write has landed on SQLite and has not landed on Postgres or libSQL by the time
it returns. The runtime already depends on this distinction: the Log index
caller does `const inserted = database.insertLogIndexEvent(event)` and then
probes `isPromiseLike(inserted)` to decide whether to chain the prune — a probe
the shared definition can never satisfy, because it returns `undefined`. A
method that needs to look at a result uses the runtime's existing promise-aware
helpers — `thenIfPromise` and `chainMaybePromise` — so that one definition stays
correct whether what it called was synchronous or asynchronous.

The invariant exists because violating it usually produces a silent wrong answer
rather than an error. A pending query is a truthy object with no useful
properties, so `Boolean(pendingQuery)` is always `true`,
`Number(pendingQuery?.count ?? 0)` is always `0`, and a branch on
`pendingQuery.changes` always takes the same path — nothing throws and no
request fails. Not every violation is silent: treating a Promise as an array, as
`runReadOnlyInspectionQuery` does, throws a `TypeError`, which that method's own
`try`/`catch` then converts into a returned error result. But the loud cases are
the lucky ones. Six shipped defects came from this one mechanism, and every one
of them was silent: an email credential existence check that reported every
address as already registered and so made email sign-up impossible on Postgres
and libSQL; a reference integrity check of the same shape, so `Reference()`
never rejected a reference to a row that does not exist; an Upload call whose
completion branched on an unresolved sibling method result and therefore never
wrote the File metadata row for a new file; two reserved-user guards that tested
a Promise, never fired, and left the reserved Privileged server role identity
readable as an ordinary Sporades user through Session and email credential
lookups; and an outstanding-Reset code count that always returned zero, leaving
the ADR-0033 cap inert. Each was correct where it was written and became wrong
only when a different adapter borrowed it.

## Async-first was considered and rejected

The obvious stronger rule is to make every Database adapter method return a
Promise, so there is no synchronous mode to get wrong. That option is rejected,
and it is rejected on a specific constraint rather than on taste.

ADR-0022 exposes a constrained read-only ACL context to ACL rules, with scoped
helpers including `ctx.acl.db.get()` and `ctx.acl.storage.get()`. The runtime
implements those helpers to fail closed when the underlying adapter read is
asynchronous: the helper returns null to the rule and marks the evaluation, and
the decision point denies on that mark. Making every adapter read asynchronous
would therefore make every ACL rule that reads through an ACL context helper
fail closed on every engine, including SQLite in a Dev session. That is a
Capsule-facing breaking change to working Capsules, which is a worse outcome
than the defect class this ADR closes.

Writing the rule as `async` is not an escape hatch, and this ADR should not be
read as implying one. The helper sets the mark from inside itself, before the
rule can await anything, and the decision point tests that mark on both the
synchronous and the awaited branch. An `async` rule doing `await
ctx.acl.db.get(...)` is denied exactly as a synchronous one is. Async-first is
therefore more blocked than a sync-only framing would suggest, not less.

What does bound the cost is that the mark is only ever set from inside the
`ctx.acl.db.*` and `ctx.acl.storage.*` helpers. An ACL rule that decides from
`ctx`, `previous`, `next`, or the row alone is unaffected whatever its
synchrony, and that is the common case. It is also worth keeping two things
separate: ADR-0022 mandates the ACL context helpers and their read-only
vocabulary, but says nothing about asynchrony or about failing closed. The
fail-closed response to an asynchronous read is a property of the current
runtime implementation, not an ADR-0022 requirement, and could in principle be
changed by a decision that faced what helper-reading ACL rules should then do.

A future reader must not reopen async-first without meeting that constraint
first. What happens to ACL rules that read through an ACL context helper —
synchronous or asynchronous — is an ADR-0022 question and needs its own
specification; until it is answered, the dual-mode return convention stays and
the invariant above is what keeps it safe.

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
how a Database adapter method consumes its own statement primitives, its sibling
methods, and the helpers it delegates to. Both hold at once, and the second is
not implied by the first: awaiting at the call site does not help when the wrong
value was already computed inside the method, or when the method returned
nothing to await.

Nothing here changes ADR-0026. Workflow-level Transaction boundaries continue to
be verified above the Database adapter, and engine mechanics continue to be
verified at the boundary; this ADR constrains what a single adapter method does
with a single statement result, which is a separate concern from where a write
workflow's atomicity is decided. It also does not add a public Database adapter
or plugin API, which ADR-0021 defers.
