# Add release verification around Host push

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Add an optional verified Host push path that starts or restarts a Hosted Capsule
on the newly pushed release, waits for Hosted Capsule health, and returns a
clear success or failure result. This gives humans and agents confidence that a
release works after it reaches the Host server, not merely that files were
transferred.

Verification should be conservative about release state. `host push --verify`
may upload the new release, make it current, and attempt to run it. If
verification fails, Sporades must not silently roll back to the previous release.
The failed release remains the current attempted release, its release-history
state becomes `failed`, and the Capsule route should point to the Hosted Capsule
unavailable response if the container is not healthy. The JSON error must include
the previous current release so a human or agent can run an explicit rollback.

## Acceptance criteria

- [ ] `sporades host push --verify --json` pushes the current release, starts or restarts the Hosted Capsule as needed, and runs the Hosted Capsule health check.
- [ ] Verification succeeds only when the Capsule route responds and runtime health checks pass.
- [ ] Verification failure records the failed release state in release history and returns structured failure details.
- [ ] Verification failure does not silently roll back; the response includes rollback guidance using `sporades host rollback <subname> <previous-release-id>`.
- [ ] JSON output includes release ID, previous current release, current attempted release, verification state, health summary, Hosted Capsule URL, and rollback guidance when relevant.
- [ ] Tests cover successful verified push, verification timeout, runtime health failure, route failure, release-history update, and non-verified push behavior.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/02-add-hosted-capsule-runtime-health-checks.md
- .scratch/sporades-host-ops-and-autodeploy/issues/04-record-hosted-capsule-release-history.md
