Status: ready-for-agent

# Spike Service-Backed SQLite-Compatible Adapter

## Parent

.scratch/database-adapter/PRD.md

## What to build

Run a short spike to choose the first service-backed SQLite-compatible database target and prove the Database adapter can support a non-embedded connection without broad SQL dialect portability work.

## Acceptance criteria

- [ ] Candidate SQLite-compatible service targets are compared against current Sporades SQL usage.
- [ ] The spike identifies connection, transaction, migration, inspection, and deployment implications.
- [ ] A minimal proof runs representative app table, auth, file metadata, log index, and inspection paths through the candidate adapter.
- [ ] The result recommends the first service-backed adapter target or explains why no candidate is ready.
- [ ] Follow-up implementation issues are created or updated based on the spike outcome.

## Blocked by

- .scratch/database-adapter/issues/04-route-inspection-and-transactions-through-adapter.md
- .scratch/docker-compose-capsule-services/issues/03-run-container-sessions-with-capsule-services.md

