# Add Capsule security policy defaults

Status: done

## Parent

.scratch/production-readiness/PRD.md

## What to build

Add per-Capsule security policy defaults that make Sporades-owned HTTP surfaces
safe by default while preserving local development ergonomics. The policy lives
in `sporades.json`, can be inspected by CLI and Host commands before the server
Bundle starts, and applies consistently across Dev sessions, local Container
sessions, and Hosted Capsules.

This slice should deliver an end-to-end path: scaffold/config defaults,
effective policy resolution, runtime header/CORS behavior, Public Dev session
behavior, structured JSON output, docs, and tests.

## Acceptance criteria

- [ ] `sporades.json` supports per-Capsule security policy for CORS and CSP.
- [ ] The default CORS posture is same-origin for Sporades-owned HTTP surfaces.
- [ ] Dev sessions allow both `localhost` and `127.0.0.1` origins by default.
- [ ] Dev sessions support an explicit Public Dev session mode, and CLI/JSON output makes the relaxed posture visible.
- [ ] Local Container sessions and Hosted Capsules require explicit CORS configuration for cross-origin custom endpoint access.
- [ ] Conservative security headers are emitted by default.
- [ ] Technology-revealing headers are removed or suppressed by default.
- [ ] CSP defaults to report-only mode with reasonable React/Preact scaffold defaults.
- [ ] CSP can be switched to active enforcement through `sporades.json`.
- [ ] CLI validation and JSON output expose the effective security posture without requiring the server Bundle to start.
- [ ] Host commands may report effective security policy but do not override it.
- [ ] Existing client transport, auth callback, file URL, and custom endpoint behavior remains compatible with the SDK abstractions.
- [ ] Docs cover security policy defaults, Public Dev session mode, and migration from existing configs.
- [ ] `docs/ROADMAP.md` is updated to reflect implementation status.

## Blocked by

None - can start immediately
