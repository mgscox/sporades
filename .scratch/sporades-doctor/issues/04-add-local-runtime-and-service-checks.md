# Add local runtime and Capsule service checks

Status: done

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Add local doctor checks for Dev sessions, local Container sessions, and local
Capsule services. The checks should diagnose runtime state and drift without
changing lifecycle state, and should point users to the existing `dev`,
`deploy`, `security`, `env`, and SSH inspection commands for follow-up.

## Acceptance criteria

- [ ] Doctor reports Dev session binding state, port reachability, and Public Dev posture.
- [ ] Doctor reports local Container binding state and Docker container running state.
- [ ] Doctor reports local Container Base image policy labels, runtime user, read-only release mounts, writable data mount, restart policy, and loopback-only published ports when available.
- [ ] Doctor reports Capsule service declarations, generated Compose file state, service container health, service ports, networks, and known drift between `sporades.json` and Runtime directory state.
- [ ] Doctor treats missing Docker or Docker Compose availability as skipped or failed checks with actionable hints, depending on the requested session.
- [ ] Doctor does not start, stop, restart, remove, reset, pull, build, or compose up/down anything.
- [ ] Human and JSON output point to exact follow-up commands such as `sporades dev status`, `sporades deploy status`, `sporades deploy restart`, `sporades deploy reset`, and `sporades deploy ssh`.
- [ ] Tests use fake Docker/Compose fixtures and cover healthy state, missing binding, stopped container, stale binding, service drift, unhealthy service, missing Docker, and no declared services.

## Blocked by

- .scratch/sporades-doctor/issues/01-define-doctor-command-and-check-envelope.md
- .scratch/sporades-doctor/issues/02-add-project-config-and-security-posture-checks.md
