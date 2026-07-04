# Add Sealed Server env

Status: done

## Parent

.scratch/production-readiness/PRD.md

## What to build

Add Sealed Server env as the hardened successor to plaintext Server env files
while preserving `ctx.env` as the app-facing API. Sealed Server env should use
portable public/private key encryption with Node `crypto`, store sealed material
in ignored Runtime or Host state by default, and support CLI-first promotion
from local development to Host servers through explicit import/export or
Host-profile re-encryption.

This slice should deliver an end-to-end path: key generation, sealing,
unsealing, migration/import from `.env.sporades.server`, local Dev use,
Container/Hosted delivery, Host-profile re-encryption, safe JSON output, docs,
and tests.

## Acceptance criteria

- [x] `ctx.env` remains the app-facing read API for server-only values.
- [x] Sealed Server env storage, key generation, encryption, decryption, and re-encryption flows are implemented.
- [x] Sealed Server env files are ignored by default and live in Sporades-owned Runtime or Host state.
- [x] Private keys are never committed and are not included in exported sealed envelopes.
- [x] `.env.sporades.server` is supported as a legacy/import-friendly format rather than the long-term default.
- [x] CLI commands can import existing `.env.sporades.server` values into Sealed Server env.
- [x] CLI commands can export/import sealed material explicitly for portability without printing secret values.
- [x] Local-to-Host promotion can re-encrypt values for a Host key without requiring OS-specific secret-store export.
- [x] Dev sessions, local Container sessions, and Hosted Capsules receive decrypted values at runtime without exposing values in CLI/JSON output.
- [x] CLI and JSON output expose secret key/configuration state without printing values.
- [x] Docs cover Sealed Server env, migration from plaintext Server env files, local-to-Host promotion, and key handling.
- [x] `docs/ROADMAP.md` is updated to reflect implementation status.

## Blocked by

None - can start immediately
