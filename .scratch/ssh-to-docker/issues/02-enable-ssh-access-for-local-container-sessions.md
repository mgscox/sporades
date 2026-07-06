Status: ready-for-agent

# Enable SSH access for local Container sessions

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Implement opt-in SSH access for `sporades deploy`. When the Capsule
configuration provides SSH authorized keys, the local Container session should
include those keys, start the minimal SSH capability required by the approved
contract, and open container port 22 according to the approved local exposure
model. When no keys are configured, local Container sessions should behave as
they do today.

## Acceptance criteria

- [ ] `sporades deploy` validates the configured SSH keys and rejects malformed or private-key-looking material with a structured error and hint.
- [ ] A configured local Container session has the approved authorized keys available to the container SSH service.
- [ ] A configured local Container session opens port 22 according to the approved local exposure model.
- [ ] Local Container session JSON/lifecycle output reports whether SSH access is enabled and how it is exposed.
- [ ] Redeploy replacement preserves the single-container model and does not leave stale SSH-enabled containers behind.
- [ ] With no configured keys, Docker hardening and port behavior remain unchanged.
- [ ] Tests cover enabled, disabled, invalid-config, and redeploy behavior without requiring a manual interactive SSH session.

## Blocked by

- .scratch/ssh-to-docker/issues/01-define-container-ssh-access-contract.md
