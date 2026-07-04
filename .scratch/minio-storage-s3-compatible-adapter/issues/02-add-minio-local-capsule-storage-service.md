Status: ready-for-agent

# Add MinIO Local Capsule Storage Service

## Parent

.scratch/minio-storage-s3-compatible-adapter/PRD.md

## What to build

Add `services.storage.kind: "storage"` with `engine: "minio"` as local Capsule service intent. Sporades should generate and manage MinIO Compose state for Dev sessions and local Container sessions, then inject server-only runtime service env that can be consumed by the Storage adapter.

This slice should integrate MinIO into the same Capsule service model used by database services: users edit `sporades.json`, while Sporades owns generated Compose state under the Runtime directory.

## Acceptance criteria

- [ ] `sporades.json` accepts `services.storage` with `{ "kind": "storage", "engine": "minio" }`.
- [ ] Unsupported storage service declarations fail with structured errors and actionable hints.
- [ ] Generated Compose includes a deterministic MinIO service, persistent state, labels, and the shared Capsule services network.
- [ ] Dev sessions start MinIO before the runtime and pass localhost service env to the server runtime only.
- [ ] Local Container sessions run the Capsule container on the shared service network and pass container-reachable MinIO service env.
- [ ] Service lifecycle/status/reset outputs include storage service state without leaking credentials.
- [ ] MinIO readiness probing reports useful diagnostics when startup or health checks fail.
- [ ] While generalizing service env plumbing, Dev sessions pass the configured database service engine instead of hardcoding libSQL.
- [ ] Tests cover valid declarations, invalid declarations, generated Compose output, Dev wiring, local Container wiring, readiness failure diagnostics, and database-plus-storage service combinations.

## Blocked by

None - can start immediately
