Status: ready-for-agent

# Run Container Sessions With Capsule Services

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Make local Container sessions run on the generated Compose network with declared database Capsule services, sharing the same local service data used by Dev sessions.

## Acceptance criteria

- [ ] `sporades deploy` starts declared services if needed before replacing the local Container session.
- [ ] The Capsule container joins the generated Compose network and can reach declared services.
- [ ] Dev sessions and local Container sessions share service data by default.
- [ ] Existing single-container replacement semantics remain compatible with generated Compose state.
- [ ] Container session JSON output reports service state and connection failures without leaking secrets.
- [ ] Tests cover deploy with services, redeploy, service connectivity, shared data, and failure diagnostics.

## Blocked by

- .scratch/docker-compose-capsule-services/issues/02-start-capsule-services-for-dev-sessions.md

