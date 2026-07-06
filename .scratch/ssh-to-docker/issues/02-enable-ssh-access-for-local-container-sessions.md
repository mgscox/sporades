Status: done

# Enable SSH access for local Container sessions

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Implement opt-in Container SSH access for `sporades deploy`, including the
shared Base image changes needed by local Container sessions and Hosted
Capsules. When the Capsule configuration provides effective authorized keys,
the local Container session should mount generated key material, run the Base
image startup script, start the minimal OpenSSH capability, and publish
container port 22 to a Docker-assigned loopback-only host port. When no keys
are configured, local Container sessions should behave as they do today.

## Acceptance criteria

- [x] The single Sporades Base image includes the minimal OpenSSH server capability and a dormant Sporades startup script for SSH-enabled containers.
- [x] The `sporades` image user remains non-root, is not in sudoers, and is the only SSH login user.
- [x] `sporades deploy` validates `ssh.authorizedKeys` before stopping or replacing an existing local Container session, resolving absolute, `~`, and project-relative `file` entries on the CLI machine.
- [x] `sporades deploy` rejects malformed config, malformed authorized-key material, unreadable `file` entries, and private-key-looking material with a structured error and hint.
- [x] An empty effective key set is treated as SSH disabled during deploy.
- [x] A configured local Container session receives generated authorized-key material as a read-only runtime input and the startup script writes generated runtime state under `/app/data/ssh/authorized_keys`.
- [x] A configured local Container session runs as the Base image runtime user `10001:10001`, starts `sshd`, and publishes container port 22 to a Docker-assigned loopback-only host port.
- [x] `sporades deploy ssh [--json]` reports effective SSH state by inspecting Docker on the local Docker host, including enabled state, running state, user, host, port, target port, key count, fingerprints, and remedy-oriented reason codes.
- [x] Normal `sporades deploy` output and JSON do not include effective SSH state unless validation fails.
- [x] Redeploy replacement preserves the single-container model and does not leave stale SSH-enabled containers behind.
- [x] With no configured keys, Docker hardening and port behavior remain unchanged.
- [x] Tests cover Base image/startup behavior, enabled, disabled, invalid-config, `deploy ssh`, loopback-only port publishing, runtime-user behavior, and redeploy behavior without requiring a manual interactive SSH session.

## Blocked by

None - the Container SSH access contract is recorded in the parent PRD.
