# Mount .env.sporades.server as a file in v0

Status: Superseded

Superseded by the implemented Hosted Capsule release packaging model and by
the post-v2 hardened secrets planning area. This ADR remains as the historical
decision for the first local-only container sessions.

v0 mounted `.env.sporades.server` read-only at `/app/.env.sporades.server` in
the local container. This was simple and mirrored `dev` behaviour, but it was a
terrible long-term solution: env files are unstructured, leak secrets into
filesystems, and do not support rotation or per-environment overrides.

Current behavior still uses `.env.sporades.server` as the Server env source for
Dev sessions and local Container sessions. Hosted Capsule release packaging also
includes the Server env file when present so hosted runtime behavior matches the
local runtime shape. Replacing env files with hardened secrets is deferred to
`.scratch/post-v2-platform-hardening-and-ops/issues/01-replace-server-env-files-with-hardened-secrets.md`.
