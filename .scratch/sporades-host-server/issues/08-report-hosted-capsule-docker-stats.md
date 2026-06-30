# Report Hosted Capsule Docker stats

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement `host stats` for one Hosted Capsule using Docker stats in no-stream mode on the Host server. The command should return normalized resource fields for agents while preserving raw Docker stats for debugging.

## Acceptance criteria

- [ ] `sporades host stats <subname>` resolves the Hosted Capsule through the selected or explicit Host profile.
- [ ] Stats use Docker no-stream data for the matching Hosted Capsule container.
- [ ] JSON output includes normalized CPU percentage, memory usage, memory limit, memory percentage, network input/output, block input/output, PID count, and raw Docker stats.
- [ ] The command fails with structured JSON when the Hosted Capsule is not registered or has no running container.
- [ ] Tests cover normalized parsing, raw passthrough, missing Capsule, stopped Capsule, SSH failure, and remote helper failure.

## Blocked by

- .scratch/sporades-host-server/issues/06-run-hosted-capsules-in-docker.md
