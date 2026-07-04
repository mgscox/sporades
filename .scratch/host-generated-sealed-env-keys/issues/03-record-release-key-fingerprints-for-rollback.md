Status: done

# Record Release Key Fingerprints For Rollback

## Parent

.scratch/host-generated-sealed-env-keys/PRD.md

## What to build

Record the sealed-env key fingerprint required by each pushed release, and make Hosted Capsule start/rollback paths select the matching Host private key by release manifest fingerprint rather than by the current registry fingerprint.

## Acceptance criteria

- [x] Release manifests record the sealed-env key fingerprint for releases that include a sealed envelope.
- [x] Hosted Capsule start mounts or points the runtime at the private key matching the selected release manifest fingerprint.
- [x] Rollback to a retained release uses that release's recorded fingerprint, not the current registry fingerprint.
- [x] Releases without Sealed Server env remain supported.
- [x] Structured Host inspection reports the current registry fingerprint and the running release fingerprint when available.
- [x] Tests cover release push, start, rollback across different fingerprints, and missing matching key behavior.

## Blocked by

- .scratch/host-generated-sealed-env-keys/issues/02-auto-reencrypt-sealed-env-during-host-push.md
