# List Hosted Capsules

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement `host list` so developers and agents can inspect Hosted Capsules for a Host profile/Hosted domain from any directory. The command should combine authoritative registry data with live Docker state and present Capsule-oriented output rather than raw Docker output.

## Acceptance criteria

- [ ] `sporades host list` works from outside a Sporades project when a Host profile is selected or passed explicitly.
- [ ] List output includes Capsule subname, hosted URL, registry metadata, current release metadata when present, and live Docker status when available.
- [ ] The command trusts the Host server registry over any local project binding.
- [ ] Plain output is readable for humans and `--json` returns the standard Sporades JSON envelope.
- [ ] Tests cover empty registries, registered-but-unavailable Capsules, running Capsules, stopped Capsules, missing local binding, and fake Docker state.

## Blocked by

- .scratch/sporades-host-server/issues/04-register-hosted-capsules-with-503-routes.md
