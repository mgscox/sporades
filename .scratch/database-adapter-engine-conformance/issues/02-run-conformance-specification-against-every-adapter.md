Status: done

# Run Conformance Specification Against Every Adapter

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

The tracer bullet for this feature: one behavioural specification, parameterised
by a Database adapter factory, executed once per engine, seeded with the cases
that cover the six known engine-divergence defects.

A maintainer runs the ordinary test command and sees the same specification pass
against the SQLite adapter and against the libSQL adapter, with the Postgres
adapter joining when a Postgres URL is configured. Reverting any one of the six
fixes turns the run red on at least one engine.

The specification asserts observable behaviour at the Database adapter boundary:
what a method returns for a given stored state. It does not assert how a method
reached that answer, whether it returned a Promise, or which internal helper it
used — a correct adapter must be free to satisfy the contract either way.

Two details are what make this catch the defect class rather than decorate it.
Every assertion compares an observed value against an expected value, because all
six defects returned a plausible wrong value while throwing nothing. And every
predicate is exercised on both sides, because a check that always returns true and
a count that always returns zero each satisfy a single positive assertion.

The libSQL run uses the existing in-process fake libSQL service, so no external
infrastructure is needed. The Postgres run reuses the existing environment gate;
gating decides only whether that run happens, never what it asserts. Setup
currently embedded in the existing adapter tests should be extracted into the
reusable per-engine runner as part of this work.

Engine mechanics — connection lifecycle, SQL dialect emission, transaction
session behaviour such as the libSQL baton — stay in the existing per-engine
tests and do not move into the shared specification.

## Acceptance criteria

- [x] A single conformance specification is parameterised by a Database adapter factory and executed once per engine.
- [x] The specification runs against the SQLite adapter, the libSQL adapter through the in-process fake service, and the Postgres adapter behind its existing environment gate.
- [x] At least two engines run under the ordinary test command with no external infrastructure.
- [x] The Postgres gate controls only whether that run executes, not which assertions it makes.
- [x] The specification covers the six known defects: the email credential existence check, reference integrity, upload completion for a new file, the two reserved-user guards, and the outstanding Reset code count.
- [x] Every assertion compares an observed value against an expected value; no case passes merely because a call did not throw.
- [x] Every predicate is exercised on both sides — present and absent rows, zero and non-zero counts.
- [x] Reverting any one of the six fixes causes the specification to fail on at least one engine.
- [x] Per-engine setup previously duplicated in the adapter tests is extracted into the shared runner.
- [x] Existing engine-mechanic tests remain where they are and continue to pass.

## Blocked by

- .scratch/database-adapter-engine-conformance/issues/01-record-adapter-contract-and-conformance-adrs.md
