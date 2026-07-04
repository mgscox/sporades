Status: done

# Auto-Reencrypt Sealed Env During Host Push

## Parent

.scratch/host-generated-sealed-env-keys/PRD.md

## What to build

Update `sporades host push` so it automatically fetches the Hosted Capsule's current Host public key, decrypts configured local Sealed Server env values locally, re-encrypts them to the Host public key, and packages only the Host-encrypted sealed envelope with the release.

## Acceptance criteria

- [x] `sporades host push` detects configured local Sealed Server env and re-encrypts it to the Hosted Capsule current public key.
- [x] The release archive includes the Host-encrypted sealed envelope and never includes Host private keys or plaintext values.
- [x] `sporades env reencrypt --host <alias> --subname <name> --json` remains available for explicit inspection and CI preparation.
- [x] If local Sealed Server env is missing but `.env.sporades.server` exists, push fails with a hint to run `sporades env import` explicitly.
- [x] If no local source values are available, push fails with a structured recovery hint.
- [x] Tests cover successful automatic re-encryption, explicit re-encryption, missing local sealed state, legacy env refusal, and output redaction.

## Blocked by

- .scratch/host-generated-sealed-env-keys/issues/01-generate-host-owned-sealed-env-keys.md
