Status: done

# Run Container Sessions With Capsule Services

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Make local Container sessions run on the generated Compose network with declared database Capsule services, sharing the same local service data used by Dev sessions.

## Acceptance criteria

- [x] `sporades deploy` starts declared services if needed before replacing the local Container session.
- [x] The Capsule container joins the generated Compose network and can reach declared services.
- [x] Dev sessions and local Container sessions share service data by default.
- [x] Existing single-container replacement semantics remain compatible with generated Compose state.
- [x] Container session JSON output reports service state and connection failures without leaking secrets.
- [x] Tests cover deploy with services, redeploy, service connectivity, shared data, and failure diagnostics.

## Blocked by

- .scratch/docker-compose-capsule-services/issues/02-start-capsule-services-for-dev-sessions.md
