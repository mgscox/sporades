Status: ready-for-agent

# Generate Host-Owned Sealed Env Keys

## Parent

.scratch/host-generated-sealed-env-keys/PRD.md

## What to build

Generate a per-Hosted Capsule sealed-env keypair during Hosted Capsule registration and store the private key in Host-server-owned persistent state. The Host registry should record the current sealed-env key fingerprint, and Host inspection commands should expose the public key and fingerprint without exposing private key material.

## Acceptance criteria

- [ ] Hosted Capsule registration creates a sealed-env keypair when the Hosted Capsule is first registered.
- [ ] Host private key material is stored in strict-permission Host filesystem state under the Hosted Capsule.
- [ ] Host public key and fingerprint can be retrieved through structured Host command output.
- [ ] The Hosted Capsule registry records the current sealed-env key fingerprint.
- [ ] Re-registering or inspecting an existing Hosted Capsule does not overwrite existing key material.
- [ ] JSON output never includes private key material.
- [ ] Tests cover new registration, existing registration, key path permissions, public-key inspection, and private-key redaction.

## Blocked by

None - can start immediately

