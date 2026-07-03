# Harden base image and container filesystem

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define a hardened Base image and container filesystem model for Container sessions, including read-only folders where appropriate.

Sporades should build and publish its own thin Base image rather than relying
directly on `node:22-alpine` plus ad hoc runtime flags. The image should remain
boring: Node 22, non-root runtime user, known read-only release paths, known
writable data paths, no app dependencies baked in, labels/versioning for Host
verification, and parity across local Container sessions and Hosted Capsules.

Base image security update behavior should be a per-Capsule policy decision.
If the chosen Alpine-based image can support it cleanly, the design should
consider an in-container automatic security update path, such as cron-driven
package updates, for Capsules that prefer reducing CVE exposure over strict
container immutability. The design should also consider Host-managed Base image
updates and container replacement for Capsules that prefer immutable image
reproducibility. The PRD must make the trade-off explicit and visible in
structured Host inspection output.

The initial policy vocabulary should include:

- `host-managed` - default; Host reports stale Base image versions and can
  replace containers on a newer Base image while preserving Capsule data.
- `auto-patch` - opt-in; the running container applies security updates in
  place if the Base image supports that safely.
- `manual` - report only; Sporades exposes update state but does not change the
  running container or replace it automatically.

## Acceptance criteria

- [ ] A future PRD records the target Base image hardening posture.
- [ ] Sporades builds and publishes a thin Sporades-owned Base image for Container sessions and Hosted Capsules.
- [ ] The design identifies writable paths required for SQLite, uploaded files, and runtime metadata.
- [ ] The design considers non-root users, read-only mounts, seccomp, and related Docker hardening.
- [ ] The design defines per-Capsule Base image security update policy options.
- [ ] The default Base image update policy is `host-managed`.
- [ ] The policy vocabulary includes `host-managed`, `auto-patch`, and `manual`.
- [ ] The design evaluates in-container automatic security updates, including an Alpine cron-based path if feasible.
- [ ] The design evaluates Host-managed Base image updates and container replacement.
- [ ] Host inspection reports each Hosted Capsule's Base image version and update policy.
- [ ] The design records how Base image labels/versioning support Host verification and upgrade visibility.
- [ ] The design explains dev session versus container session parity implications.
- [ ] v2 keeps the existing v0/v2 container posture unless maintainers explicitly promote this marker.

## Notes

This should be planned against the Capsule and Runtime directory vocabulary in `CONTEXT.md`.
