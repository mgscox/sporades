Status: done

# Map Every Runtime Column Name On Postgres

## Parent

.scratch/database-adapter-engine-conformance/PRD.md

## What to build

Issue 03 found a seventh live engine-divergence defect, of a shape the PRD did
not anticipate. Postgres folds unquoted camelCase DDL identifiers to lowercase,
so the adapter restores them through a hand-maintained normalization table. That
table had no entry for `verifierHash`, the column the ADR-0033 Reset code work
added. On Postgres `findPasswordResetCode` therefore returned that field
undefined, the verifier comparison fell through to its absent-code placeholder,
and every valid Reset code was rejected as invalid — presented to the user as an
ordinary "invalid code", with no error anywhere.

Issue 03 fixed that one entry and its reviewer confirmed, by sweeping every
camelCase column on the `sporades_auth_*` tables, that it was the only hole on
the auth surface. It is not the only hole in the table. A coordinator audit found
roughly a dozen unmapped camelCase columns on the Job queue and Schedule tables —
`sporades_jobs`, `sporades_schedules`, `sporades_schedule_occurrences` — including
`availableAt`, `scheduledFor`, `startedAt`, `completedAt`, `failedAt`,
`actorUserId`, `enqueuedByUserId`, `idempotencyKey` and `scheduleName`. Several
are read back in runtime code, so the same silent-undefined failure is available
there. Those surfaces are outside this feature's conformance scope, which is why
this is its own issue rather than an extension of issue 05.

Close the class rather than the instances. A hand-maintained list of column names
is a registry that must be updated every time a runtime table gains a camelCase
column, and nothing fails when it is not — the same shape of latent defect
ADR-0034 addresses for unresolved results. Prefer a mechanism where a missing
entry cannot go unnoticed: derive the mapping from the schema the runtime already
declares, quote identifiers so no folding occurs, or add a check that fails when a
runtime table declares a camelCase column with no mapping.

Then verify the Job queue and Schedule surfaces actually work on Postgres, since
the defect above suggests they may never have been exercised there.

## Acceptance criteria

- [x] Every camelCase column on every runtime-owned table round-trips correctly through the Postgres read path.
- [x] A runtime table gaining a camelCase column cannot silently miss its mapping — the gap is prevented by construction or fails a check.
- [x] The Job queue and Schedule read paths are shown to return correctly-named fields on Postgres.
- [x] Any defect found in those surfaces is fixed at the shared definition, not by a per-engine override.
- [x] The existing `verifierHash` regression case continues to pass.

## Blocked by

- None — can start immediately.
