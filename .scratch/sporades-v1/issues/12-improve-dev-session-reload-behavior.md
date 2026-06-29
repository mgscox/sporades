# Improve Dev session reload behavior

Status: done

## What to build

Improve reload behavior for `sporades dev` only. Editing server or client code during a Dev session should cause less disruption than the current full process restart path where feasible, while preserving the Bundle pipeline, JSONL rebuild events, lifecycle boundaries, and failed-rebuild behavior.

## Acceptance criteria

- [ ] The improved reload behavior applies only to `sporades dev`.
- [ ] Container sessions created by `sporades deploy` continue to start from a fresh Bundle and are not affected by dev reload behavior.
- [ ] Successful rebuilds continue to emit the documented JSONL rebuild success event.
- [ ] Failed rebuilds continue to emit the documented JSONL rebuild failed event and keep serving the last successful Bundle.
- [ ] Connected clients recover from reloads with the existing reconnect behavior.
- [ ] Any `init()` / `shutdown()` lifecycle behavior remains internal to the Dev session and does not create a production hot-reload contract.

## Blocked by

- .scratch/sporades-v1/issues/11-add-context-middleware.md
