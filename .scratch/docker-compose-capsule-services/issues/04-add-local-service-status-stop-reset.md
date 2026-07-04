Status: done

# Add Local Service Status Stop Reset

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Add local lifecycle/status/reset behavior for generated Capsule service state on the existing Dev and Deploy command surfaces. Reset should clean generated Compose state precisely instead of requiring users to remove all of `.sporades/`.

## Acceptance criteria

- [x] Local status output reports declared service state, generated network/volume state, and useful diagnostics through structured JSON.
- [x] Local stop behavior stops generated Capsule service containers without deleting persisted data.
- [x] Local reset behavior can remove generated service data, Compose networks, volumes, and orphans for the current project.
- [x] Reset may remove Sporades-owned Capsule images identified by Sporades-generated labels or tags.
- [x] Reset does not remove shared third-party service images such as database images.
- [x] User guide reset documentation is updated away from blanket `rm -rf .sporades` for service-managed state.
- [x] Tests cover status, stop, reset, orphan cleanup, image safety, and docs examples.

## Blocked by

- .scratch/docker-compose-capsule-services/issues/03-run-container-sessions-with-capsule-services.md
