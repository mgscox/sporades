Status: ready-for-agent

# Route Shared Schema Migration Through A Transaction

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

The shared `migrateAppSchema` opens its transaction with a synchronous
`exec("BEGIN")` and wraps the body in a `try`/`catch`. On an asynchronous engine
that `BEGIN` is an unawaited promise, the `catch` cannot see an asynchronous
rejection, and the `COMMIT` would fire before the migration finished. The body
also derives from an unresolved `readSchemaMetadata()`.

Nothing is unguarded today. Both asynchronous engines replace the whole method
with their own transaction-scoped path, and the method is conformance-covered on
every engine, so the shared body is dormant. Issue 05 and issue 06 both looked at
it and both declined, correctly: making only the inner function promise-aware
would be worse than the status quo. Today the shared body fails loudly, because
deriving from a Promise makes `JSON.parse` throw and raises a clear error. A
half-fix would replace that with a transaction that opens and commits without
enclosing its work — a silent half-applied migration, which is exactly the trade
ADR-0034 exists to prevent.

The real fix is to route the shared body through the adapter's own transaction
primitive, as both engines already do, and merge the engine-specific migration
path back into one definition. That removes another per-engine copy and brings
schema migration under the same contract as the rest of the method set.

This is a refactor with real risk — migrations rewrite user data — so it is its
own issue rather than a rider on a coverage ticket.

## Acceptance criteria

- [ ] The shared schema migration path uses the adapter's transaction primitive rather than bare BEGIN/COMMIT statements.
- [ ] Nothing in the shared body derives from an unresolved query result.
- [ ] A failed migration rolls back on every engine, proven by test rather than by inspection.
- [ ] The engine-specific migration path is merged into the shared definition, or the remaining difference is recorded as a licensed dialect override.
- [ ] Existing additive-migration conformance cases continue to pass on every engine.

## Blocked by

- None — can start immediately.
