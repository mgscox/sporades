# Reload project config during Dev session rebuilds

Status: done

## What to build

Make Dev session rebuilds reread `sporades.json` before rebundling and restarting runtime pieces. When a developer changes relevant Capsule configuration during a running Dev session, the rebuilt Runtime should use the new config instead of reporting success while continuing with stale settings.

This slice should preserve failed-rebuild behavior: failed config or bundle changes should keep serving the last successful Runtime and emit a structured rebuild failure event.

## Acceptance criteria

- [ ] Editing relevant `sporades.json` values during `sporades dev` affects the next successful rebuild.
- [ ] Invalid config changes emit a structured rebuild failure and keep the last successful Runtime running.
- [ ] Server-runtime-affecting config changes restart the runtime and disconnect old WebSocket clients as expected.
- [ ] Client-only changes still avoid unnecessary server runtime restarts.
- [ ] JSONL and human-readable rebuild output remain compatible with existing behavior.

## Blocked by

None - can start immediately
