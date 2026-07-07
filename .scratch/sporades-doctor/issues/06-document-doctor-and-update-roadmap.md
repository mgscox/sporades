# Document doctor and update roadmap

Status: done

## Parent

.scratch/sporades-doctor/PRD.md

## What to build

Document `sporades doctor` as the read-only diagnostic coordinator for project,
local runtime, and Hosted Capsule checks. The docs should explain when to use
doctor, how to interpret check statuses, and how doctor relates to existing
inspection commands.

## Acceptance criteria

- [x] CLI help includes `sporades doctor` and all supported doctor options.
- [x] The user guide documents human and JSON doctor usage for project, local Container session, and Hosted Capsule diagnostics.
- [x] The docs state that doctor is read-only and does not repair state.
- [x] The docs state that doctor coordinates existing inspection surfaces rather than replacing `security`, `env`, `deploy ssh`, `host health`, `host stats`, `host logs`, or `host ssh`.
- [x] The docs explain `--strict` for CI and AFK-agent use.
- [x] The docs avoid printing secrets, private keys, full Server env values, or full SSH public-key material.
- [x] `docs/ROADMAP.md` is updated to reflect the implementation status when this feature is completed and documented.
- [x] Docs tests cover the canonical command names and prevent drift toward a mutating repair command.

## Blocked by

- .scratch/sporades-doctor/issues/02-add-project-config-and-security-posture-checks.md
- .scratch/sporades-doctor/issues/03-add-capsule-authoring-posture-checks.md
- .scratch/sporades-doctor/issues/04-add-local-runtime-and-service-checks.md
- .scratch/sporades-doctor/issues/05-add-hosted-capsule-doctor-checks.md
