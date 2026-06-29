# Centralize JSON server logging

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design a centralized JSON server logger that lets agents watch platform and app behavior consistently.

## Acceptance criteria

- [ ] A future PRD defines the JSON log event shape.
- [ ] The design explains how `ctx.log` writes are captured.
- [ ] The design covers log access from CLI commands and machine-readable output.
- [ ] The design defines how platform logs, app logs, and build/dev-session events relate.
- [ ] v2 does not add centralized logging unless maintainers explicitly promote this marker.

## Notes

The v0 PRD mentions `ctx.log` and `sporades logs`; this marker should reconcile that product language with the current implementation before build work starts.
