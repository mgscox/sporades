# SSH to Docker

Status: implemented

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "SSH to Docker")
- `docs/adr/0012-single-container-replace-on-redeploy.md`
- `docs/adr/0016-host-server-registry-authoritative.md`
- `docs/adr/0023-host-generated-sealed-env-keys.md`
- `docs/adr/0025-base-image-carries-dormant-ssh-capability.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

## Implementation Status

The Container SSH access contract is implemented and documented for local
Container sessions and Hosted Capsules. Local and Hosted implementation slices
landed before the documentation slice; user-facing docs now describe
top-level `ssh.authorizedKeys`, generated public authorized-key material,
loopback-only Docker-assigned SSH ports, and the explicit
`sporades deploy ssh` and `sporades host ssh` inspection surfaces. The roadmap
has moved SSH to the implemented section.

## Problem Statement

Sporades local Container sessions and Hosted Capsules are intentionally managed
through deterministic CLI and Host helper commands. That is the right primary
interface, but operators may still need an emergency or compatibility path for
SSH-style access into a running container, especially when using external
container-management tools such as Portainer.

Today there is no declared `sporades.json` contract for copying SSH authorized
keys into a Container session or Hosted Capsule, and no documented way for
Sporades to open port 22 when an operator has explicitly requested it.

## Solution

Sporades adds an explicit SSH access configuration for Container sessions and
Hosted Capsules. When a Capsule is built or run for `deploy` or `host`, and the
configuration provides SSH authorized keys, Sporades installs those public keys
into the container runtime environment and opens container port 22 according to
the agreed security contract.

SSH access is not the primary management model. Sporades continues to prefer
structured CLI and Host helper operations for normal deploy, inspect, logs,
stats, restart, and recovery workflows. Interactive SSH is not a product goal;
this feature provides a compatibility and emergency access path for operators
who opt into it.

## User Stories

1. As a Capsule operator, I want to declare SSH access intent in `sporades.json`, so that the access path is explicit and repeatable.
2. As a Capsule operator, I want to provide SSH authorized public keys, so that I can control which identities may connect.
3. As a Capsule operator, I want Sporades to ignore SSH setup when no keys are configured, so that default Container sessions and Hosted Capsules remain unchanged.
4. As a Capsule operator, I want `sporades deploy` to open SSH access only when configured, so that local Container sessions can support compatibility tooling.
5. As a Capsule operator, I want Hosted Capsules to open SSH access only when configured, so that Host server behavior remains opt-in.
6. As a Capsule operator, I want JSON output to report whether SSH access was enabled, so that automation can diagnose the effective container shape.
7. As a Capsule operator, I want invalid SSH configuration to fail with a structured error and hint, so that mistakes are caught before a container starts.
8. As a security-conscious maintainer, I want Sporades to copy only authorized public keys, so that private key material is not moved into images, releases, or containers.
9. As a security-conscious maintainer, I want the port exposure rules to be explicit, so that opening port 22 does not accidentally weaken Hosted Capsule hardening.
10. As a Host server operator, I want Hosted Capsule SSH access to coexist with Caddy HTTP routing, so that HTTP traffic keeps using the existing Capsule route model.
11. As a Host server operator, I want the Host registry to remain authoritative, so that SSH access state is derived from release/config state rather than local guesswork.
12. As a developer, I want redeploys to replace the SSH-enabled local container cleanly, so that port 22 settings do not leave orphaned containers or stale bindings.
13. As an AFK agent, I want tests to assert Docker and Host helper behavior from command outputs and lifecycle results, so that the feature can be implemented without manual SSH sessions.
14. As a documentation reader, I want clear guidance that Portainer or similar tooling is the simpler operational route, so that I do not mistake SSH for the recommended management interface.

## Implementation Decisions

- The first implementation requires a short human-approved SSH access contract before coding the Container and Host behavior.
- The accepted `sporades.json` contract is a single top-level `ssh` object shared by local Container sessions and Hosted Capsules.
- The accepted key list shape is `ssh.authorizedKeys`, where each entry is an object with exactly one of `key` for inline public key text or `file` for a public-key file reference, for example `{ "key": "ssh-ed25519 AAAA..." }` or `{ "file": "~/.ssh/id_ed25519.pub" }`. Bare string entries are not accepted.
- There is no separate `ssh.enabled` toggle in this slice. SSH is enabled only when `ssh.authorizedKeys` resolves to at least one effective authorized key; remove or empty the authorized keys and redeploy/restart to disable SSH.
- There is no custom SSH port configuration in `sporades.json`. Container SSH always targets port 22, and the host port is always Docker-assigned and loopback-only. Users inspect the effective mapped port with `sporades deploy ssh` or `sporades host ssh`; this slice does not add `ssh.port`, `ssh.hostPort`, or `ssh.bind`.
- `file` entries are resolved by the CLI before starting a local Container session or packaging a Hosted Capsule release. Absolute paths are used as-is, `~` expands to the CLI user's home directory, and relative paths resolve from the project directory containing `sporades.json`. The resolved file content is validated as public key text, and only approved public key content may travel into runtime setup; source file paths are not copied into release archives, Host registries, or container metadata.
- The intended contract is to accept OpenSSH `authorized_keys`-compatible public key material, with no Sporades-specific narrowing of key algorithms or line options. `key` entries provide one authorized-key line; `file` entries may provide normal `authorized_keys` file content, including multiple lines, comments, and blank lines. Private key material and malformed key material must be rejected before container startup where possible; empty effective key sets disable SSH. Private key material must not be copied into release archives, images, Runtime directories, Host registries, or containers.
- The configuration lives in `sporades.json` because Capsule runtime behavior is already declared there and injected by the CLI.
- SSH setup is opt-in. With no configured keys, local Container sessions and Hosted Capsules retain their existing Docker hardening defaults and port behavior.
- The single Sporades Base image provides the minimal OpenSSH server capability needed for key-based access, but the container startup path configures and starts SSH only when `ssh.authorizedKeys` resolves to at least one authorized key.
- SSH sessions log in as the existing Base image `sporades` user only. Key-based auth is the only supported SSH authentication model. Password authentication, generated emergency passwords, and root login are disabled, the `sporades` user must not be in sudoers, and this slice does not add a configurable SSH username or password field.
- Sporades does not add a separate SFTP or SCP product surface. If the minimal OpenSSH server naturally supports `ssh`, `scp`, or `sftp` for the `sporades` user with the configured keys, that compatibility behavior is acceptable within the same filesystem boundaries: release mounts remain read-only, Capsule data remains writable, and no sudo or root access is available.
- SSH-enabled local Container sessions run as the Base image runtime user `10001:10001` rather than the invoking host UID/GID, so the SSH login user and process user are consistent. Non-SSH local Container sessions retain the existing invoking UID/GID behavior where available.
- Generated SSH authorized-key state lives under the writable Capsule data mount, such as `/app/data/ssh/authorized_keys`, not in release files, image layers, Host registry data, or `.sporades/build`. The container startup path regenerates this file from validated public key material on each start or redeploy, configures `sshd` to use that explicit path, and ignores or removes stale generated key state when SSH is no longer configured.
- SSH-enabled containers use a Sporades startup script from the Base image instead of invoking `node /app/server.mjs` directly. The script prepares writable SSH state, writes authorized keys, starts `sshd`, and then execs `node /app/server.mjs` as the main foreground process. Non-SSH containers keep the direct Node startup path unless the implementation proves one shared startup script is simpler without changing default behavior.
- Validated authorized-key material is passed to SSH-enabled containers as a generated Sporades-owned runtime input, not by asking the Base image to parse `sporades.json` or resolve file paths. For local Container sessions, the CLI may write this generated file under `.sporades/ssh/` and mount it read-only. For Hosted Capsules, the release archive includes generated authorized-key material rather than original source paths. The Base image startup script copies the generated input into the writable Capsule data mount with sshd-compatible permissions.
- Generated public authorized-key material may be included in Hosted Capsule release archives because public keys are public access policy, not secrets. Routine CLI output should not echo full key material unless a future explicit inspection command asks for it. `sporades deploy ssh` and `sporades host ssh` are the primary inspection surfaces for effective SSH state, reporting metadata such as enabled state, key count, fingerprints, and effective exposure. Fingerprints should use normal SSH fingerprint style where practical.
- Sporades does not deduplicate authorized-key lines unless required for compatibility with SSH tooling. Effective key material should preserve OpenSSH `authorized_keys` semantics and source order.
- The `/app/data/ssh/authorized_keys` file is generated runtime state owned by Sporades, not persistent operator-editable policy. Each SSH-enabled start or redeploy overwrites it from the validated config-derived input. Removing SSH keys from `sporades.json` and redeploying disables SSH and clears or ignores stale generated key state.
- Missing `ssh` means SSH is disabled. An existing `ssh` block with no effective authorized keys, such as an empty `authorizedKeys` array or files containing only comments and blanks, is treated as SSH disabled during `sporades deploy` and `sporades host push`. SSH-specific inspection commands may report `reason: "no-authorized-keys"`; a future `sporades doctor` may warn about pointless empty SSH configuration.
- Malformed SSH configuration is a structured error, including unreadable `file` entries, malformed authorized-key lines, private-key-looking material, entries with both `key` and `file`, and entries with neither. Errors should identify the relevant `ssh.authorizedKeys[n]` entry where possible. `sporades deploy` validates SSH configuration before stopping or replacing an existing local Container session, and `sporades host push` validates before packaging or uploading a Hosted Capsule release.
- `sporades deploy` applies the SSH configuration to local Container sessions. When at least one authorized key is configured, local Container sessions publish container port 22 to a Docker-assigned loopback-only host port, equivalent to `127.0.0.1::22`, and `sporades deploy ssh` reports the effective host, port, target port, key count, and fingerprints. No configured keys means no SSH server setup and no port 22 publishing.
- Host push/start applies the SSH configuration to Hosted Capsules through the Host helper. When at least one authorized key is configured, Hosted Capsules publish container port 22 to a Docker-assigned loopback-only port on the Host server, equivalent to `127.0.0.1::22`. The Host registry or lifecycle state records enough effective SSH exposure metadata for structured inspection, including enabled state, host, port, and target port. Operators reach the Capsule SSH port through the existing Host server SSH path, such as local forwarding or a jump host; Sporades does not publish per-Capsule SSH ports on `0.0.0.0` by default.
- `sporades host ssh [subname] [--host <alias>] [--json]` is the Hosted Capsule inspection command for effective SSH state. If `subname` is omitted, it should use the local remote binding when available, matching existing Host command ergonomics.
- `sporades deploy ssh` and `sporades host ssh` should share the same inspection model against the relevant Docker host. Local inspection uses the local Container binding to find the container and queries local Docker; Hosted inspection uses the Host helper to query Docker on the Host server. Registry, binding, or release metadata may provide intended enabled state, key count, and fingerprints, but the actual host port comes from Docker. If SSH is configured but the container is stopped, JSON should report `enabled: true`, `running: false`, and a surface-specific reason such as `container-stopped` for local Container sessions or `capsule-stopped` for Hosted Capsules.
- SSH inspection commands should mirror existing command vocabulary rather than adding a new top-level command. Human output should be terse and report connection facts, not a composed SSH command, such as enabled state, user, address, and key count. Hosted Capsule human output should make clear that the address is loopback-only on the Host server. JSON output should include `enabled`, `user`, `host`, `port`, `targetPort`, `keyCount`, and `fingerprints`, but not a composed command string.
- Disabled or unavailable SSH inspection states should use reason codes that imply the likely remedy where possible. Local reasons include `no-container-session`, `container-stopped`, `no-authorized-keys`, and `port-not-published`; Hosted reasons include `no-hosted-capsule`, `capsule-stopped`, `no-current-release`, `no-authorized-keys`, and `port-not-published`. Human hints and structured error/hint fields should steer toward the next action, such as running `sporades deploy`, `sporades deploy restart`, `sporades host register`, `sporades host push`, or `sporades host start`.
- `sporades deploy` and `sporades host push` should not expose effective SSH state in their normal output or JSON result shape. SSH state belongs behind `sporades deploy ssh` and `sporades host ssh`; deploy and push should surface SSH only when validation fails.
- User documentation may include indicative SSH and tunnel examples, but they are examples only because client commands vary by OS, local SSH config, and tunneling setup. CLI JSON reports connection facts rather than composed commands.
- Public SSH port exposure is out of scope for this contract. Sporades provides no `public` or `bindHost` escape hatch for Container SSH access; operators who need remote access to the loopback-only port can use their own tunneling or forwarding tool outside the Capsule contract.
- Caddy HTTP routing remains separate. SSH access must not replace or interfere with Capsule routes, unavailable responses, or loopback HTTP published ports.
- Host server registry and release metadata should store enough SSH intent and key metadata for `sporades host ssh` to diagnose effective state without storing secret material.
- Structured errors should reject malformed key configuration before container startup where possible.
- Interactive SSH workflows are out of scope for tests. Tests should prove the container is configured correctly without requiring a human SSH session.

## Testing Decisions

- Good tests should verify external command behavior and lifecycle outputs rather than implementation internals.
- Local Container session tests should assert config validation, Docker run/build arguments, authorized-key material placement behavior, port 22 exposure, redeploy replacement behavior, and JSON output.
- Hosted Capsule tests should assert Host helper request/manifest behavior, Docker run arguments on the Host helper side, registry/release reporting, and preservation of Caddy HTTP route behavior.
- Negative tests should cover missing keys, malformed keys, accidental private-key-looking values, and disabled/default behavior.
- Prior art includes local Container session deploy tests, Host helper lifecycle tests, loopback published-port tests, Host registry tests, and Host push release archive tests.

## Out of Scope

- Making SSH the primary management interface for Sporades.
- Building an interactive SSH command in the CLI.
- Copying private keys or credentials into images, release archives, Runtime directories, Host registries, or containers.
- User/password SSH authentication.
- Replacing Portainer or other container management tooling.
- General Host server SSH profile management, which already belongs to Host profiles and Host provisioning.
- Multi-node SSH routing or DNS automation.

## Further Notes

- This feature intentionally rubs against the existing hardening model, so the
  contract slice comes first. Tiny door, big consequences. Best not to install
  a revolving one by accident.
- If the contract decides Hosted Capsule SSH should be reachable only through a
  Host-controlled path rather than direct public publishing, the implementation
  issues should preserve that decision explicitly.
