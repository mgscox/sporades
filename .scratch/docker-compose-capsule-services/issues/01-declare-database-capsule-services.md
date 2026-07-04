Status: done

# Declare Database Capsule Services

## Parent

.scratch/docker-compose-capsule-services/PRD.md

## What to build

Add a `sporades.json` declaration shape for database Capsule services and generate Sporades-owned Docker Compose files under the Runtime directory from that intent.

## Acceptance criteria

- [ ] `sporades.json` supports a first database Capsule service declaration shape.
- [ ] Sporades validates service declarations and reports structured errors for unsupported shapes.
- [ ] Generated Compose files live under `.sporades/` and are marked as Sporades-owned runtime state.
- [ ] Users do not need to hand-edit Compose YAML for the supported path.
- [ ] Service names, volumes, networks, and labels/tags are deterministic per project.
- [ ] Docs explain Capsule service declarations and generated Compose ownership.
- [ ] Tests cover valid declarations, invalid declarations, generated Compose output, and stable naming.

## Blocked by

None - can start immediately
