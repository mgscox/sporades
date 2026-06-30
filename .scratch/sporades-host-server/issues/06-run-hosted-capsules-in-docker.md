# Run Hosted Capsules in Docker

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement Hosted Capsule lifecycle commands using Docker on the Host server. Start, stop, and restart should run the current release only, use deterministic domain-scoped container names, attach discovery labels, mount runtime files read-only, preserve `/app/data`, and keep Capsule routes aligned with container state. This slice also wires `push --restart` into the lifecycle path.

## Acceptance criteria

- [ ] `sporades host start <subname>` starts the current release for a registered Hosted Capsule and fails clearly when no release has been pushed.
- [ ] `sporades host stop <subname>` stops the running container without deleting persistent Hosted Capsule data and routes the Capsule subdomain back to the unavailable response.
- [ ] `sporades host restart <subname>` stops the old container first and starts the current release; no blue/green or historical release selection is exposed.
- [ ] Hosted Capsule containers use deterministic domain-scoped names, one shared Host server Docker network, and labels for Sporades ownership, Hosted domain, Capsule subname, Capsule identity, and release ID.
- [ ] Docker runtime files are mounted read-only, the data directory is mounted read-write at `/app/data`, and the base image matches the local container session base image.
- [ ] Start/restart performs a short Docker running-state grace check; failures route to the `503` unavailable response and return structured JSON failure output with an actionable hint.
- [ ] `sporades host push --restart` installs the release and then invokes the restart path.
- [ ] Tests cover start, stop, restart, stale/stopped containers, failed starts, route switching, Docker args, labels, mounts, and `push --restart`.

## Blocked by

- .scratch/sporades-host-server/issues/05-push-current-releases-to-hosted-capsules.md
