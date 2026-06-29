# Replace Server env files with hardened secrets

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design a replacement for `.env.sporades.server` that preserves the Server env concept while avoiding plaintext project-root secret files as the long-term default.

## Acceptance criteria

- [ ] A future PRD defines where secrets are stored in dev sessions and container sessions.
- [ ] The design explains how `ctx.env` or its successor exposes values to server code.
- [ ] The design covers migration from existing `.env.sporades.server` projects.
- [ ] The design preserves CLI-first, scriptable configuration.
- [ ] v2 continues to use Server env files unless maintainers explicitly promote this marker.

## Notes

This marker is deferred from v2 to keep provider auth and upload storage from growing into a broader secrets-management release.
