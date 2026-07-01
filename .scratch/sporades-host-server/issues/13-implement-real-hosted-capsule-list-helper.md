# Implement real Hosted Capsule listing from registry and Docker

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the real `capsule.list` action in the Host server helper so `sporades host list` reads the authoritative Host server registry and enriches each Hosted Capsule with live Docker state. Listing should work from any local directory with a Host profile and should report Capsule-oriented state rather than exposing raw registry files or Docker output.

Real-server verification should reuse or create a disposable template Capsule registration from environment-provided settings, then confirm the registered Capsule appears in list output before any release is pushed.

## Acceptance criteria

- [ ] `sporades host list --host <alias> --json` succeeds against a real Host server and returns the Hosted Capsules registered for that Host profile's Hosted domain.
- [ ] Empty registries return an empty list in the standard Sporades JSON envelope.
- [ ] Registered Capsules include subname, hosted URL, registry status, current release metadata when present, and Docker status when a matching container exists.
- [ ] Docker lookup uses deterministic Hosted Capsule identity, names, or labels and handles missing/stopped containers without failing the whole list operation.
- [ ] Plain output remains readable for humans while `--json` remains stable for agents.
- [ ] Real-server tests use environment variables, optionally loaded from `.env`, and never embed a concrete server IP or domain in test code.

## Blocked by

- .scratch/sporades-host-server/issues/12-implement-real-hosted-capsule-registration-helper.md
