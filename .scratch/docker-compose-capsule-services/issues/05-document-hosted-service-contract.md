Status: ready-for-agent

# Document Hosted Service Contract

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Document the deferred Hosted Capsule service orchestration contract informed by the local Compose implementation, including how the existing Host command surface should eventually manage Hosted Capsule services.

## Acceptance criteria

- [ ] Docs state that the first Docker Compose Capsule service implementation is local-only.
- [ ] The Hosted Capsule service contract identifies required Host responsibilities for service lifecycle, networking, persistence, backup, reset, inspection, and failure recovery.
- [ ] The docs explain that future Hosted service orchestration should use the existing `sporades host` surface rather than a new top-level service namespace.
- [ ] Open questions such as Portainer or another Host management layer are captured without being implemented.
- [ ] `docs/ROADMAP.md` links remain accurate after the PRD/issues are created.

## Blocked by

- .scratch/docker-compose-capsule-services/issues/04-add-local-service-status-stop-reset.md

