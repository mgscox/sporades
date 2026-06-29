# Add server security defaults

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define server hardening defaults such as CORS policy and helmet-style headers for Sporades-owned HTTP surfaces.

## Acceptance criteria

- [ ] A future PRD lists the HTTP surfaces that need defaults.
- [ ] The design records CORS behavior for local dev, container sessions, custom endpoints, file URLs, and auth callbacks where relevant.
- [ ] The design records default security headers and any local-development exceptions.
- [ ] The design preserves the existing client transport and SDK abstractions.
- [ ] v2 does not add broad server hardening unless maintainers explicitly promote this marker.

## Notes

This marker should be revisited after v2 file URLs and provider auth callback behavior are stable.
