# 08 — Inspect Dev-Session Schedules From The CLI

**What to build:** Let an administrator inspect all bounded schedule state for the active Dev session through the JSON-only `sporades schedules` command backed by a read-only one-shot generated-Bundle action.

Status: done

## Parent

.scratch/job-scheduling/PRD.md

## Blocked by

.scratch/job-scheduling/issues/07-inspect-schedules-and-correlate-jobs.md

- [ ] The Dev schedule command returns the standard structured JSON envelope with Capsule identity and schedules ordered by name.
- [ ] A Capsule with no schedules or no schedule store succeeds with `schedules: []` without creating or migrating storage.
- [ ] The shared action opens the configured Database adapter read-only and does not evaluate Capsule code, migrations, workers, lifecycle hooks, HTTP, or WebSocket startup.
- [ ] The internal action identifier is `schedules.inspect` and accepts no filters or pagination arguments in V1.
- [ ] Inspection does not advance schedules, acquire claims, enqueue Jobs, or emit Privileged audit events.
- [ ] Malformed stored state fails the whole response with a bounded structured error identifying only the responsible Schedule and field, without returning partial results or corrupt raw values.
- [ ] Inactive Dev sessions reuse existing structured target errors.
- [ ] Focused tests exercise the real one-shot generated Bundle and a temporary Dev session.
