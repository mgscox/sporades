# Add server security defaults

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define server hardening defaults such as CORS policy and helmet-style headers for Sporades-owned HTTP surfaces.

Default CORS posture should be same-origin for Sporades-owned HTTP surfaces.
Dev sessions should allow both `localhost` and `127.0.0.1` origins for local
browser workflows, and should provide an explicit Public Dev session mode for
demos or device testing. Container sessions and
Hosted Capsules should require explicit CORS declarations for cross-origin
custom endpoint access.

The first version should also include a conservative default security header
set. Technology-revealing headers should be removed or suppressed by default.
Content Security Policy should be Capsule-configurable, defaulting to
report-only mode with reasonable React/Preact scaffold defaults. CORS should
also be Capsule-configurable while preserving the same-origin defaults and Dev
session exceptions described above.

Capsule security configuration belongs in `sporades.json`, not in server
Capsule code. CLI tooling, scaffolds, Host verification, and agents should be
able to inspect the configured posture before the server Bundle is running.
The policy is per-Capsule for this release theme; Host profiles and Host
servers may report the effective policy, but must not override it.

## Acceptance criteria

- [ ] A future PRD lists the HTTP surfaces that need defaults.
- [ ] The design records same-origin CORS behavior for local dev, container sessions, custom endpoints, file URLs, and auth callbacks where relevant.
- [ ] Dev sessions allow both `localhost` and `127.0.0.1` origins by default.
- [ ] Dev sessions provide an explicit Public Dev session mode with structured CLI output that makes the relaxed posture visible.
- [ ] Container sessions and Hosted Capsules require explicit CORS declarations for cross-origin custom endpoint access.
- [ ] The design records default security headers and any local-development exceptions.
- [ ] Technology-revealing headers are removed or suppressed by default.
- [ ] Content Security Policy is Capsule-configurable with `report-only` as the default mode and reasonable React/Preact scaffold defaults.
- [ ] CSP can be switched from report-only to active enforcement through Capsule configuration.
- [ ] CORS is Capsule-configurable while preserving same-origin defaults, Dev `localhost` / `127.0.0.1` behavior, and explicit Public Dev session behavior.
- [ ] Capsule security configuration lives in `sporades.json`.
- [ ] CLI validation and JSON output expose the effective security posture without requiring the server Bundle to start.
- [ ] Host profiles and Host servers do not override Capsule security policy in this release theme.
- [ ] The design preserves the existing client transport and SDK abstractions.
- [ ] v2 does not add broad server hardening unless maintainers explicitly promote this marker.

## Notes

This marker should be revisited after v2 file URLs and provider auth callback behavior are stable.
