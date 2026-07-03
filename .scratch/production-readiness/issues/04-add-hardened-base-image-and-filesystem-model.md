# Add hardened Base image and filesystem model

Status: ready-for-agent

## Parent

.scratch/production-readiness/PRD.md

## What to build

Add a thin Sporades-owned Base image and hardened container filesystem model for
local Container sessions and Hosted Capsules. The Base image should remain
boring and predictable: Node 22, non-root runtime user, known read-only release
paths, known writable data paths, no app dependencies baked in, and
labels/versioning for Host verification.

This slice should deliver an end-to-end path: Base image definition, local
Container session usage, Hosted Capsule usage, filesystem mount enforcement,
Base image labels/version reporting, per-Capsule update policy reporting, docs,
and tests.

## Acceptance criteria

- [ ] Sporades builds or references a thin Sporades-owned Base image for local Container sessions and Hosted Capsules.
- [ ] The Base image uses a non-root runtime user.
- [ ] Runtime release files mount read-only.
- [ ] SQLite data, uploaded file bytes, and required runtime metadata live only in explicit writable paths.
- [ ] The design considers and documents seccomp and related Docker hardening posture.
- [ ] Base image labels/versioning support Host verification and upgrade visibility.
- [ ] Host inspection reports each Hosted Capsule's Base image version and update policy.
- [ ] Per-Capsule Base image update policy supports `host-managed`, `auto-patch`, and `manual`.
- [ ] The default Base image update policy is `host-managed`.
- [ ] `auto-patch` is evaluated and implemented only if the chosen Base image can support in-container security updates safely.
- [ ] `manual` reports update state but does not mutate or replace the running container automatically.
- [ ] Local Container sessions and Hosted Capsules preserve persistent Capsule data across Base image replacement.
- [ ] Docs cover the Base image, filesystem layout, update policies, and Dev/Container/Hosted parity implications.
- [ ] `docs/ROADMAP.md` is updated to reflect implementation status.

## Blocked by

None - can start immediately
