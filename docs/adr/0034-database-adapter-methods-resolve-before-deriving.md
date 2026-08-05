# Database adapter methods are engine-agnostic and resolve before deriving

The Database adapter method set is engine-agnostic and defined once. Every
engine presents the same methods with the same names, arguments, and meanings,
and the differences between engines are confined to the statement primitives and
the connection behavior underneath those methods. Today that is literal: the
method set is written as one object on the SQLite adapter, and the Postgres and
libSQL adapters build themselves by constructing a throwaway SQLite adapter,
spreading its methods, and overriding `exec` and `prepare` with asynchronous
versions. There are no per-engine copies of the method set, and there must not
be; a method whose body differs by engine is a place where code above the
Database adapter has stopped being agnostic to the selected engine.

A Database adapter method may return either a plain value or a Promise. This
dual-mode return convention is deliberate rather than a leftover of the
`node:sqlite` extraction: on SQLite a read returns a row, and on Postgres or
libSQL the same method returns a Promise of that row, and callers are written to
tolerate both. The convention is retained for the reason given below, not
because it is convenient.

## The invariant

A Database adapter method must never derive a value, a branch, or a guard from
an unresolved query result. It may return a query result directly and let the
caller await it. It may not test it, count it, coerce it, or read a property off
it without resolving it first.

This is the rule to cite in review, and it is deliberately mechanical: if a line
inside a Database adapter method inspects the thing `prepare(...).get()`,
`prepare(...).all()`, or `prepare(...).run()` returned, that method is wrong
unless the inspection happens after resolution. A method that needs to look at
its own result uses the runtime's existing promise-aware helpers —
`thenIfPromise` and `chainMaybePromise` — so that one definition stays correct
whether the statement primitive underneath it is synchronous or asynchronous.

The invariant exists because violating it produces silent wrong answers rather
than errors. A pending query is a truthy object with no useful properties, so
`Boolean(pendingQuery)` is always `true`, `Number(pendingQuery?.count ?? 0)` is
always `0`, and a branch on `pendingQuery.changes` always takes the same path.
Nothing throws and no request fails. Six shipped defects came from this one
mechanism: an email credential existence check that reported every address as
already registered and so made email sign-up impossible on Postgres and libSQL;
a reference integrity check of the same shape, so `Reference()` never rejected a
reference to a row that does not exist; an Upload call whose completion branched
on a pending result and therefore never wrote the File metadata row for a new
file; two reserved-user guards that tested a Promise, never fired, and left the
reserved Privileged server role identity readable as an ordinary Sporades user
through Session and email credential lookups; and an outstanding-Reset code
count that always returned zero, leaving the ADR-0033 cap inert. Each was
correct where it was written and became wrong only when a different adapter
borrowed it.

## Async-first was considered and rejected

The obvious stronger rule is to make every Database adapter method return a
Promise, so there is no synchronous mode to get wrong. That option is rejected,
and it is rejected on a specific constraint rather than on taste.

ADR-0022 exposes a constrained read-only ACL context to ACL rules, with scoped
helpers including `ctx.acl.db.get()` and `ctx.acl.storage.get()`. ACL rules may
be written synchronously, and those helpers fail closed when the underlying
adapter read is asynchronous: a synchronous rule that cannot see the resolved
value denies. Making every adapter read asynchronous would therefore make every
synchronous ACL rule fail closed on every engine, including SQLite in a Dev
session. That is a Capsule-facing breaking change to working Capsules, which is
a worse outcome than the defect class this ADR closes.

A future reader must not reopen async-first without meeting that constraint
first. Deciding what happens to synchronous ACL rules is an ADR-0022 question
and needs its own specification; until it is answered, the dual-mode return
convention stays and the invariant above is what keeps it safe.

## Relationship to existing decisions

This extends ADR-0021, which establishes the Database adapter as an internal
runtime boundary below `ctx.db` and states that code above it remains agnostic
to the selected engine. ADR-0021 asserts that agnosticism; this ADR states what
the method set has to do to deliver it.

This narrows rather than reverses the completed decision in
`.scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md`.
That decision governs how call sites consume Database adapter methods — runtime
paths for app tables, auth storage, File metadata storage, the Log index, schema
migration, and inspection can await adapter operations without changing the
Sporades DB API that Capsule handlers reach through `ctx.db`. This ADR governs
how a Database adapter method consumes its own statement primitives. Both hold
at once, and the second is not implied by the first: awaiting at the call site
does not help when the wrong value was already computed inside the method.

Nothing here changes ADR-0026. Workflow-level Transaction boundaries continue to
be verified above the Database adapter, and engine mechanics continue to be
verified at the boundary; this ADR constrains what a single adapter method does
with a single statement result, which is a separate concern from where a write
workflow's atomicity is decided. It also does not add a public Database adapter
or plugin API, which ADR-0021 defers.
