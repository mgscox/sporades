Status: ready-for-human

# Define the Container SSH access contract

## Parent

.scratch/ssh-to-docker/PRD.md

## What to build

Define the explicit `sporades.json` and runtime contract for SSH access in
local Container sessions and Hosted Capsules. The decision should settle the
configuration shape, key validation rules, port exposure model, JSON reporting,
and security limits before any AFK implementation opens port 22.

## Acceptance criteria

- [ ] The accepted `sporades.json` shape for SSH access is documented.
- [ ] The contract states that only authorized public keys are accepted and private key material is rejected.
- [ ] Local Container session port 22 exposure behavior is specified.
- [ ] Hosted Capsule port 22 exposure behavior is specified and reconciled with existing Host hardening.
- [ ] JSON/lifecycle reporting requirements for SSH-enabled containers are specified.
- [ ] The PRD or linked ADR records that interactive SSH is not the primary Sporades management interface.
- [ ] The follow-up implementation issues are updated if the accepted contract differs from the initial PRD assumptions.

## Blocked by

None - can start immediately
