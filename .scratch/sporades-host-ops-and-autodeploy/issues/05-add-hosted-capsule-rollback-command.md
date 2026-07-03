# Add Hosted Capsule rollback command

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Add a rollback command that returns a Hosted Capsule to a previous recorded
release. Rollback should use Host-server-owned release history, update the
current release pointer, restart the Hosted Capsule on the selected release, and
return structured output that agents can use to verify the result.

Rollback is an explicit operator action. It should start the selected release
even if the Capsule was stopped before the rollback command, because the command
means "make this release current and run it." If the restart/start fails, the
command should keep the selected release recorded as the attempted current
release, mark the attempt failed in release history, route the Capsule to the
Hosted Capsule unavailable response, and return a structured error that names
the previous current release so the operator can choose the next action.

## Acceptance criteria

- [ ] `sporades host rollback <subname> <release-id> --json` resolves the selected or explicit Host profile and Hosted Capsule.
- [ ] Rollback rejects unknown releases, missing release files, unregistered Capsules, and Capsules with no release history using structured errors.
- [ ] A successful rollback updates the current release pointer and restarts the Hosted Capsule on that release.
- [ ] Rolling back a stopped Capsule starts the selected release rather than only updating metadata.
- [ ] Failed rollback start attempts are recorded in release history and leave the route on the Hosted Capsule unavailable response.
- [ ] Rollback preserves persistent Capsule data and uploaded files.
- [ ] The command output includes the previous current release, the new current release, and the Hosted Capsule state after restart.
- [ ] Tests cover successful rollback, unknown release, missing files, stopped Capsule behavior, data preservation, and helper failure.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/04-record-hosted-capsule-release-history.md
