Status: ready-for-agent

# Document Container SSH access

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Update user-facing and runtime documentation for Container SSH access after the
local and Hosted implementation slices land. The docs should present SSH as an
opt-in compatibility and emergency access path, not the primary Sporades
management interface.

## Acceptance criteria

- [ ] `docs/user-guide.md` documents the top-level `ssh.authorizedKeys` shape, including `{ "key": "..." }` and `{ "file": "..." }` entries.
- [ ] Docs explain that `file` entries resolve on the CLI machine, support absolute paths, `~`, and project-relative paths, and that original source paths are not copied into Hosted Capsule releases.
- [ ] Docs state that SSH uses the `sporades` user, key-based auth only, no root login, no sudoers access, no passwords, no custom ports, and no public port exposure.
- [ ] Docs explain `sporades deploy ssh` and `sporades host ssh` as the explicit inspection surfaces for effective SSH state.
- [ ] Docs include indicative local SSH and Hosted tunnel examples without presenting them as universal commands.
- [ ] `docs/runtime-layout.md` describes generated SSH runtime state under Capsule data and generated public authorized-key material in Hosted Capsule releases.
- [ ] The parent PRD and `docs/ROADMAP.md` are updated when the feature is implemented and documented.

## Blocked by

- .scratch/ssh-to-docker/issues/02-enable-ssh-access-for-local-container-sessions.md
- .scratch/ssh-to-docker/issues/03-enable-ssh-access-for-hosted-capsules.md
