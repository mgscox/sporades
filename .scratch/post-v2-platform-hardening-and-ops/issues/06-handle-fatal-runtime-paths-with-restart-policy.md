# Handle fatal runtime paths with restart policy

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Define how dev sessions and container sessions respond to fatal runtime paths such as unhandled rejections, uncaught exceptions, and failed lifecycle hooks.

## Acceptance criteria

- [ ] A future PRD defines which fatal paths trigger restart versus process exit.
- [ ] The design describes how restarts interact with lifecycle hooks.
- [ ] The design records CLI and JSON output for fatal events and restart attempts.
- [ ] The design covers retry limits or backoff to avoid restart loops.
- [ ] v2 does not change fatal-path restart behavior unless maintainers explicitly promote this marker.

## Notes

This marker should respect ADR-0009's process restart and lifecycle-hook vocabulary.
