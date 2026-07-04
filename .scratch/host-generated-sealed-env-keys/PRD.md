# Host-Generated Sealed Env Keys

Status: ready-for-agent

## Overview

Move Hosted Capsule Sealed Server env private-key custody from local Host profile configuration into Host-server-owned state. The CLI should retrieve only Host public keys and fingerprints, re-encrypt local source values to the Host public key, and push Host-encrypted sealed envelopes so neither Host private keys nor plaintext secrets cross the local-to-Host boundary.

## Source Planning

- `docs/ROADMAP.md`
- `docs/adr/0023-host-generated-sealed-env-keys.md`
- Existing Sealed Server env implementation: `.scratch/production-readiness/issues/03-add-sealed-server-env.md`

## Scope

- Generate one sealed-env keypair per Hosted Capsule during registration.
- Store Host private keys in strict-permission Host filesystem state by fingerprint.
- Store the current sealed-env key fingerprint in Hosted Capsule registry state.
- Expose public key/fingerprint inspection through Host commands.
- Make `sporades host push` automatically re-encrypt local Sealed Server env values to the current Host public key when local sealed values are available.
- Record the sealed-env key fingerprint required by each release manifest.
- Support manual key rotation without breaking rollback to retained releases.
- Report missing-key and missing-source-value failures with structured errors and recovery hints.

## Non-Goals

- Do not implement Host backup/restore in this feature.
- Do not use desktop keyrings or require an interactive unlock password on Host servers.
- Do not provide casual raw private-key export.
- Do not require CI/autodeploy env promotion in the first slice.
- Do not change `ctx.env` as the app-facing API.

## Product Decisions

- Host private keys never leave the Host server.
- Plaintext Server env values never cross the local-to-Host boundary.
- The default Host key store is strict-permission Host filesystem state.
- Host key backup/restore belongs under the broader Host backup and restore roadmap item.
- Fingerprints are machine/diagnostic identifiers, not routine user input.
- `host push` may auto re-encrypt from configured local Sealed Server env, but must not silently import legacy `.env.sporades.server`.

## User Stories

- As an operator, I can register a Hosted Capsule and know the Host already owns its sealed-env keypair.
- As an operator, I can push a Capsule using Sealed Server env without copying a Host private key from my machine.
- As an operator, I can rotate a Hosted Capsule sealed-env key and still roll back to retained releases.
- As an agent, I get structured errors and recovery hints when Host key material or local source values are missing.

## Implementation Issues

- `issues/01-generate-host-owned-sealed-env-keys.md`
- `issues/02-auto-reencrypt-sealed-env-during-host-push.md`
- `issues/03-record-release-key-fingerprints-for-rollback.md`
- `issues/04-rotate-host-generated-sealed-env-keys.md`
- `issues/05-report-sealed-env-key-recovery-errors.md`

