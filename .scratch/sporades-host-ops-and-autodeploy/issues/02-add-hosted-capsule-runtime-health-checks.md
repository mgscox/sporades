# Add Hosted Capsule runtime health checks

Status: done

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Add an end-to-end health check for a specific Hosted Capsule that verifies the
Capsule route reaches the running container and that the server runtime has
initialised enough to use SQLite and file storage. The check should be available
through the CLI for agents.

The runtime health path must have an explicit protection model. Use a
Sporades-owned path such as `/__sporades/health/runtime` that is reachable
through the generated Capsule route only when the Host helper supplies a
Host-owned probe credential, for example an `x-sporades-host-probe` header.
Ordinary public requests to the same path must receive a generic `404` or `403`
and must not reveal whether the Capsule exists. The probe credential is
Host-server-owned state, is not exposed to app code, and is never printed in CLI
output.

## Acceptance criteria

- [ ] `sporades host health <subname> --json` resolves the selected or explicit Host profile and Hosted Capsule.
- [ ] The health check confirms the Hosted Capsule is registered, has a current release, has a running container, and responds through its Capsule route.
- [ ] The runtime health result includes safe checks for server runtime readiness, SQLite access, and file storage writability.
- [ ] Runtime health probing uses a defined Host-owned protection mechanism, and unauthenticated public requests to the probe path do not expose operational details.
- [ ] The command reports structured failures for unregistered Capsule, no current release, stopped container, route failure, runtime failure, SQLite failure, and file storage failure.
- [ ] The health endpoint does not expose secrets, local filesystem paths, session tokens, or raw environment values.
- [ ] Tests cover successful runtime health, rejected unauthenticated probe requests, and each structured failure class.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/01-add-host-server-health-check-route.md
