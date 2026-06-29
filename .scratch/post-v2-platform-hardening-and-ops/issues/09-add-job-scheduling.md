# Add job scheduling

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design cron-like job scheduling for recurring work after the job queue boundary is understood.

## Acceptance criteria

- [ ] A future PRD defines the app-facing scheduling API.
- [ ] The design records how scheduled jobs are persisted and recovered across restarts.
- [ ] The design covers timezone, drift, missed-run, and duplicate-run behavior.
- [ ] The design explains dependency on, or independence from, the future job queue.
- [ ] v2 does not add job scheduling unless maintainers explicitly promote this marker.

## Notes

This marker is likely blocked on the job queue design unless maintainers choose a smaller timer-only scope.
