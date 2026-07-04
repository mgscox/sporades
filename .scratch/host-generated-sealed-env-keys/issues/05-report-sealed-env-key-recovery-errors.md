Status: ready-for-agent

# Report Sealed Env Key Recovery Errors

## Parent

.scratch/host-generated-sealed-env-keys/PRD.md

## What to build

Return structured, agent-operable errors when Host sealed-env key material, matching release fingerprints, or local re-encryption source values are missing. Recovery guidance should direct operators to re-key and re-seal from source-of-truth values rather than implying old envelopes can be decrypted without the private key.

## Acceptance criteria

- [ ] Missing Host private key errors include Hosted Capsule identity, expected fingerprint when known, and a re-key/re-seal recovery hint.
- [ ] Missing local source value errors explain whether local Sealed Server env, legacy Server env import, or source-of-truth values are needed.
- [ ] Errors do not print plaintext values or private keys.
- [ ] Host inspection reports sealed-env key status without exposing private key material.
- [ ] Docs describe the no-private-key/no-plaintext-crossing model and recovery when Host keys are lost.
- [ ] Tests cover missing key, missing source values, redaction, and documentation examples where practical.

## Blocked by

- .scratch/host-generated-sealed-env-keys/issues/04-rotate-host-generated-sealed-env-keys.md

