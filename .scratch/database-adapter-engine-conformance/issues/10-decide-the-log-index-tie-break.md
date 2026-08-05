Status: needs-triage

# Decide The Log Index Tie-Break

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

The Log index orders by timestamp and then by a tie-break that differs per
engine. The shared definitions break ties on `rowid`, which is insertion order.
Postgres breaks ties on `id`, which is a random UUID. Two events sharing a
timestamp therefore come back in different orders depending on the engine, and
pruning keeps different rows.

This is a genuine behavioural divergence rather than dialect, so ADR-0034 says it
should not stand — but it cannot be fixed the way the other divergences were.
Postgres has no `rowid`, so agreement requires either a monotonic insertion-order
column on `sporades_log_events` and a migration to add it, or an explicit
decision that the tie-break is unspecified and callers must not depend on it.

That is a schema and contract decision rather than an implementation choice,
which is why this is triage rather than ready-for-agent. It was found during
issue 05 and confirmed during issue 06; neither fixed it, correctly.

No conformance case asserts the tie-break today. Adding one before the decision
is made would land knowingly red for Postgres.

## Acceptance criteria

- [ ] A decision is recorded: either the Log index has a specified insertion-order tie-break on every engine, or the tie-break is explicitly unspecified.
- [ ] If specified, the schema change and migration land and a conformance case asserts equal ordering for same-timestamp events on every engine.
- [ ] If unspecified, the contract is recorded where callers will see it, and no runtime code depends on the tie-break.

## Blocked by

- None — needs a maintainer decision before implementation.
