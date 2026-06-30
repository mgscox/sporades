# Harden registry and Caddy mutation safety

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Make Host server registry and Caddy mutations safe enough for the MVP. Domain-scoped registry writes should be locked and atomic, Caddy config updates should validate before reload, and failed validation or reload should preserve the previous working config while returning structured failure output.

## Acceptance criteria

- [ ] Registry mutations use a simple per-Hosted-domain lock so concurrent operations cannot corrupt state.
- [ ] Registry writes use temp file plus rename semantics and never leave partial JSON as the authoritative registry.
- [ ] Caddy config is generated into managed include files rather than replacing the entire global Caddyfile.
- [ ] Caddy config updates validate the candidate config before moving it into place and reloading.
- [ ] Failed Caddy validation or reload preserves the previous working config and returns structured JSON failure output with an actionable hint.
- [ ] The Hosted Capsule unavailable response is served directly through generated Caddy config, not a separate unavailable-response container.
- [ ] Tests cover lock behavior, atomic write failure, Caddy validation failure, Caddy reload failure, previous-config preservation, and standard JSON errors.

## Blocked by

- .scratch/sporades-host-server/issues/04-register-hosted-capsules-with-503-routes.md
- .scratch/sporades-host-server/issues/06-run-hosted-capsules-in-docker.md
- .scratch/sporades-host-server/issues/09-retrieve-host-server-caddy-logs.md
