Status: ready-for-agent

# Enable SSH access for Hosted Capsules

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Implement opt-in SSH access for Hosted Capsules through the existing Host push
and Host helper lifecycle. When a Hosted Capsule release/configuration provides
SSH authorized keys, the Host helper should start the Capsule container with
those keys and open port 22 according to the approved Hosted Capsule exposure
model. Existing Caddy HTTP routing, unavailable responses, Host registry
authority, and release lifecycle behavior must continue to work.

## Acceptance criteria

- [ ] Hosted Capsule release/configuration validation rejects malformed or private-key-looking SSH material before starting the container where possible.
- [ ] A configured Hosted Capsule has the approved authorized keys available to the container SSH service.
- [ ] A configured Hosted Capsule opens port 22 according to the approved Hosted Capsule exposure model.
- [ ] Host registry, release, list/stats, or lifecycle JSON reports enough SSH access state to diagnose the effective container shape without storing secrets.
- [ ] Caddy HTTP routes, loopback HTTP published ports, unavailable responses, stop, restart, and failed-start recovery continue to behave correctly.
- [ ] With no configured keys, Hosted Capsule Docker hardening and port behavior remain unchanged.
- [ ] Tests cover Host helper Docker arguments, registry/reporting behavior, disabled behavior, invalid config, and preservation of HTTP routing without requiring a manual interactive SSH session.

## Blocked by

- .scratch/ssh-to-docker/issues/01-define-container-ssh-access-contract.md
- .scratch/ssh-to-docker/issues/02-enable-ssh-access-for-local-container-sessions.md
