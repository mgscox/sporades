# Replace Server env files with hardened secrets

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design a replacement for `.env.sporades.server` that preserves the Server env concept while avoiding plaintext project-root secret files as the long-term default.

The app-facing API should remain `ctx.env`. This feature introduces Sealed
Server env: encrypted server-only configuration values managed by Sporades,
decryptable by configured local or Host keys, and exposed to Capsule code
through `ctx.env`. It should not introduce a decorative `ctx.secrets` API with
the same behavior.

Sealed Server env should favor portability from local development to Host
servers over OS-specific local secret stores. A public/private key design using
Node `crypto` is sufficient for this product boundary: the goal is to prevent
accidental plaintext secret leakage while preserving CLI-first promotion of a
Capsule to a Host server, not to provide a banking-grade vault.

Sealed Server env files should be ignored by default and stored in
Sporades-owned Runtime or Host state. A committed sealed envelope is not useful
without its key, and the key must not be committed. Portability should come from
explicit sealed export/import or Host-profile re-encryption commands, not from
making encrypted secrets a default repository artifact.

## Acceptance criteria

- [ ] A future PRD defines where secrets are stored in dev sessions and container sessions.
- [ ] The design preserves `ctx.env` as the app-facing read API for server-only values.
- [ ] A future PRD defines Sealed Server env storage, key generation, encryption, decryption, and re-encryption flows.
- [ ] `.env.sporades.server` is treated as a legacy or import-friendly format rather than the long-term default.
- [ ] Sealed Server env files are ignored by default and live in Sporades-owned Runtime or Host state.
- [ ] The design provides explicit sealed export/import or Host-profile re-encryption commands for portability.
- [ ] Private keys are never committed and are not included in exported sealed envelopes.
- [ ] Local-to-Host promotion can re-encrypt values for a Host key without requiring OS-specific secret-store export.
- [ ] CLI and JSON output expose secret key/configuration state without printing values.
- [ ] The design covers migration from existing `.env.sporades.server` projects.
- [ ] The design preserves CLI-first, scriptable configuration.
- [ ] v2 continues to use Server env files unless maintainers explicitly promote this marker.

## Notes

This marker is deferred from v2 to keep provider auth and upload storage from growing into a broader secrets-management release.
