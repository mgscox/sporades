# Handle dev rebuilds with JSONL streaming

Status: done

## What to build

Turn the dev session into a reliable iteration loop. File changes should trigger debounced esbuild rebundles, successful rebuilds should restart the bundled server process through lifecycle hooks, clients should reconnect, and failed rebuilds should report errors while continuing to serve the last successful bundle.

## Acceptance criteria

- [ ] `sporades dev` watches relevant project files and debounces rebuilds by 100ms.
- [ ] Successful rebuilds regenerate server and client bundles and restart the server process using `shutdown()` and `init()` lifecycle boundaries.
- [ ] Connected clients reconnect over WebSocket after a process restart with a 500ms backoff.
- [ ] Failed rebuilds leave the last successful dev session serving and surface the build error clearly.
- [ ] `sporades dev --json` streams JSONL events for started, rebuild success, and rebuild failed states.
- [ ] Non-JSON mode remains human-readable while preserving the same underlying event information.

## Blocked by

- .scratch/sporades-v0/issues/04-run-todo-query-mutation-loop.md
