Status: done

# Define the Container SSH access contract

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Define the explicit `sporades.json` and runtime contract for Container SSH
access in local Container sessions and Hosted Capsules. The accepted contract
is recorded in the parent PRD and ADR-0025.

## Acceptance criteria

- [x] The accepted `sporades.json` shape for SSH access is documented.
- [x] The contract states that OpenSSH `authorized_keys`-compatible public key material is accepted and private key material is rejected.
- [x] Local Container session port 22 exposure behavior is specified.
- [x] Hosted Capsule port 22 exposure behavior is specified and reconciled with existing Host hardening.
- [x] SSH inspection reporting requirements are specified without adding SSH state to normal deploy/push output.
- [x] The PRD and ADR-0025 record that interactive SSH is not the primary Sporades management interface.
- [x] The follow-up implementation issues are updated for the accepted contract.

## Blocked by

None - can start immediately
