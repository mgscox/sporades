# Add Hosted Capsule doctor checks

Status: ready-for-agent

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Add Hosted Capsule doctor checks that use Host profiles, remote binding, Host
health, Hosted Capsule health, Host stats, release metadata, Sealed Server env
fingerprints, and Hosted Capsule SSH inspection state to diagnose Hosted
Capsule mismatches from one read-only command.

## Acceptance criteria

- [ ] Doctor resolves the target Host profile and Hosted Capsule subname from flags or remote binding.
- [ ] Doctor reports missing Host profile, missing remote binding, and missing Hosted Capsule registry state with structured hints.
- [ ] Doctor uses existing Host helper inspection surfaces for Host server health and Hosted Capsule health.
- [ ] Doctor reports route/container mismatches, stopped Capsules, missing current releases, failed health checks, unavailable response state, and resource stat availability.
- [ ] Doctor reports non-secret Sealed Server env fingerprint availability for current Hosted Capsule release metadata.
- [ ] Doctor warns when release metadata references a sealed-env key fingerprint that is unavailable on the Host.
- [ ] Doctor reports effective Hosted Capsule SSH state through the same model as `sporades host ssh`, without adding public SSH exposure semantics.
- [ ] Doctor points users to exact follow-up commands such as `sporades host health`, `sporades host stats`, `sporades host logs`, `sporades host ssh`, and `sporades host push --verify`.
- [ ] Tests use fake Host helper/SSH fixtures and cover healthy Hosted Capsule state, missing profile, missing registry state, no current release, stopped Capsule, route mismatch, sealed-env key mismatch, and SSH disabled/unavailable states.

## Blocked by

- .scratch/sporades-doctor/issues/01-define-doctor-command-and-check-envelope.md
- .scratch/sporades-doctor/issues/02-add-project-config-and-security-posture-checks.md

