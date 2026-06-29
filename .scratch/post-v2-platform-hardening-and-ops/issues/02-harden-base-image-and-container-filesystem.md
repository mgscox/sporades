# Harden base image and container filesystem

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define a hardened Base image and container filesystem model for Container sessions, including read-only folders where appropriate.

## Acceptance criteria

- [ ] A future PRD records the target Base image hardening posture.
- [ ] The design identifies writable paths required for SQLite, uploaded files, and runtime metadata.
- [ ] The design considers non-root users, read-only mounts, seccomp, and related Docker hardening.
- [ ] The design explains dev session versus container session parity implications.
- [ ] v2 keeps the existing v0/v2 container posture unless maintainers explicitly promote this marker.

## Notes

This should be planned against the Capsule and Runtime directory vocabulary in `CONTEXT.md`.
