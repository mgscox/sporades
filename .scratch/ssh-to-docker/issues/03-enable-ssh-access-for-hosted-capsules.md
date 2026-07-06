Status: done

# Enable SSH access for Hosted Capsules

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Implement opt-in Container SSH access for Hosted Capsules through the existing
Host push and Host helper lifecycle. When a Hosted Capsule release provides
effective authorized keys, the release archive should include generated public
authorized-key material, and the Host helper should start the Capsule container
through the Base image startup script with container port 22 published to a
Docker-assigned loopback-only port on the Host server. Existing Caddy HTTP
routing, unavailable responses, Host registry authority, and release lifecycle
behavior must continue to work.

## Acceptance criteria

- [x] `sporades host push` validates `ssh.authorizedKeys` before packaging or uploading a release, resolving absolute, `~`, and project-relative `file` entries on the CLI machine.
- [x] Hosted Capsule release/configuration validation rejects malformed config, malformed authorized-key material, unreadable `file` entries, and private-key-looking material before starting the container where possible.
- [x] An empty effective key set is treated as SSH disabled during Host push.
- [x] Hosted Capsule release archives include generated public authorized-key material when SSH is enabled, but not original source file paths or private material.
- [x] A configured Hosted Capsule receives generated authorized-key material as a read-only runtime input and the startup script writes generated runtime state under `/app/data/ssh/authorized_keys`.
- [x] A configured Hosted Capsule opens container port 22 on a Docker-assigned loopback-only Host server port, with no public SSH exposure or `sporades.json` port/bind escape hatch.
- [x] `sporades host ssh [subname] [--host <alias>] [--json]` reports effective SSH state by inspecting Docker on the Host server through the Host helper, including enabled state, running state, user, host, port, target port, key count, fingerprints, and remedy-oriented reason codes.
- [x] Normal `sporades host push`, list, stats, and lifecycle output do not expose effective SSH state unless validation fails or the explicit `host ssh` command is used.
- [x] Caddy HTTP routes, loopback HTTP published ports, unavailable responses, stop, restart, and failed-start recovery continue to behave correctly.
- [x] With no configured keys, Hosted Capsule Docker hardening and port behavior remain unchanged.
- [x] Tests cover Host helper Docker arguments, release archive contents, `host ssh`, disabled behavior, invalid config, loopback-only port publishing, and preservation of HTTP routing without requiring a manual interactive SSH session.

## Blocked by

- .scratch/ssh-to-docker/issues/02-enable-ssh-access-for-local-container-sessions.md
