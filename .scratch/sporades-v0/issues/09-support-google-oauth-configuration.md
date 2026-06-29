# Support Google OAuth configuration and linked accounts

Status: done

## What to build

Add the authenticated auth path for v0. Developers should be able to configure Google OAuth, the client should expose sign-in through the Sporades auth layer, and an existing anonymous session should become a linked account without losing ownership of existing data.

## Acceptance criteria

- [ ] `sporades auth status` reports the current auth mode and whether required Google OAuth configuration is present.
- [ ] `sporades auth set google --client-id <id> --client-secret <secret>` updates project auth configuration without exposing secrets in normal command output.
- [ ] When Google OAuth mode is configured, the server runtime initializes Better Auth for anonymous sessions plus Google sign-in.
- [ ] The client auth API exposes enough behavior for the scaffold to start Google sign-in and refresh auth state without importing Better Auth client SDKs.
- [ ] Signing in links the Google identity to the existing anonymous account so previously owned todos remain visible.
- [ ] `ctx.auth` reflects authenticated user details after linking.
- [ ] Misconfigured OAuth fails with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v0/issues/08-inject-server-env-into-dev-and-container-sessions.md
