Status: ready-for-agent

# Start Capsule Services For Dev Sessions

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Make `sporades dev` start declared local database Capsule services before running the Capsule as a local Node process, and inject the service connection details into the Dev session runtime without exposing secrets in client bundles or JSON output.

## Acceptance criteria

- [ ] `sporades dev` starts declared database Capsule services through generated Compose.
- [ ] Dev session startup waits for service readiness or fails with structured diagnostics.
- [ ] Service data persists under Runtime-owned service state and survives Dev session restarts.
- [ ] The server runtime receives service connection details through server-only configuration.
- [ ] `sporades dev --json` reports service lifecycle events without leaking secrets.
- [ ] Tests cover service start, readiness failure, rebuild behavior, persistence, and JSON output.

## Blocked by

- .scratch/docker-compose-capsule-services/issues/01-declare-database-capsule-services.md

