Status: ready-for-agent

# Rotate Host-Generated Sealed Env Keys

## Parent

.scratch/host-generated-sealed-env-keys/PRD.md

## What to build

Add manual per-Hosted Capsule sealed-env key rotation. Rotation should generate a new Host keypair, update the Hosted Capsule registry's current fingerprint for future pushes, and retain old keys while retained releases still reference them.

## Acceptance criteria

- [ ] A Host command rotates the current sealed-env key for one Hosted Capsule.
- [ ] Rotation generates a new fingerprint and public key without deleting keys referenced by retained releases.
- [ ] Subsequent `host push` re-encrypts to the new current public key.
- [ ] Rollback to a release encrypted to an older retained key still works.
- [ ] Key cleanup deletes only keys not referenced by any retained release.
- [ ] Tests cover rotation, push after rotation, rollback after rotation, and safe cleanup behavior.

## Blocked by

- .scratch/host-generated-sealed-env-keys/issues/03-record-release-key-fingerprints-for-rollback.md

