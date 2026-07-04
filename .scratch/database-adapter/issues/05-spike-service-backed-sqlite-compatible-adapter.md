Status: done

# Spike Service-Backed SQLite-Compatible Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Run a short spike to choose the first service-backed SQLite-compatible database target and prove the Database adapter can support a non-embedded connection without broad SQL dialect portability work.

## Acceptance criteria

- [x] Candidate SQLite-compatible service targets are compared against current Sporades SQL usage.
- [x] The spike identifies connection, transaction, migration, inspection, and deployment implications.
- [x] A minimal proof runs representative app table, auth, file metadata, log index, and inspection paths through the candidate adapter.
- [x] The result recommends the first service-backed adapter target or explains why no candidate is ready.
- [x] Follow-up implementation issues are created or updated based on the spike outcome.

## Blocked by

- .scratch/database-adapter/issues/04-route-inspection-and-transactions-through-adapter.md
- .scratch/docker-compose-capsule-services/issues/03-run-container-sessions-with-capsule-services.md

## Spike result

Recommended first target: libSQL server (`sqld`), because it is already the
only declared local database Capsule service (`services.database.engine:
"libsql"`) and is the closest SQLite-compatible service target for the current
Sporades SQL surface.

Proof and rationale are recorded in
`.scratch/database-adapter/spike-service-backed-sqlite-compatible-adapter.md`.
The proof is intentionally test-only: it runs representative adapter operations
through a child-process HTTP SQLite service to show the adapter method shape can
cross a non-embedded connection. Production libSQL work should first make the
internal adapter runtime path awaitable.

Follow-up issues:

- `.scratch/database-adapter/issues/06-make-database-adapter-runtime-path-awaitable.md`
- `.scratch/database-adapter/issues/07-add-libsql-service-backed-database-adapter.md`
