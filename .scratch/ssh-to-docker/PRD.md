# SSH to Docker

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "SSH to Docker")
- `docs/adr/0012-single-container-replace-on-redeploy.md`
- `docs/adr/0016-host-server-registry-authoritative.md`
- `docs/adr/0023-host-generated-sealed-env-keys.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to remove the item, per the roadmap Promotion Rule.

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
- The intended contract is to accept authorized public keys only. Private key material must not be copied into release archives, images, Runtime directories, Host registries, or containers.
- The configuration lives in `sporades.json` because Capsule runtime behavior is already declared there and injected by the CLI.
- SSH setup is opt-in. With no configured keys, local Container sessions and Hosted Capsules retain their existing Docker hardening defaults and port behavior.
- The Base image or container startup path must provide the minimal SSH server capability needed for key-based access when enabled.
- `sporades deploy` applies the SSH configuration to local Container sessions and opens container port 22 according to the approved local exposure contract.
- Host push/start applies the SSH configuration to Hosted Capsules through the Host helper and opens container port 22 according to the approved Hosted Capsule exposure contract.
- Caddy HTTP routing remains separate. SSH access must not replace or interfere with Capsule routes, unavailable responses, or loopback HTTP published ports.
- Host server registry and release metadata should report enough SSH access state for list/stats/JSON diagnostics without storing secret material.
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
