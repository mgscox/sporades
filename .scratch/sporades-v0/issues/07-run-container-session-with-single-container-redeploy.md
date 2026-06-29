# Run a container session with single-container redeploy

Status: done

## What to build

Implement the local `sporades deploy` path. The command should bundle the same server and client outputs used by dev, run them inside a local Docker container based on the v0 base image, mount the runtime inputs in the expected locations, persist SQLite data in a volume, and replace the existing container session on redeploy.

## Acceptance criteria

- [ ] `sporades deploy` bundles server and client code before starting the container session.
- [ ] The container uses the `node:22-alpine` base image for v0.
- [ ] The server bundle, client bundle, `index.html`, `sporades.json`, and `.env.sporades.server` are mounted read-only in the container.
- [ ] SQLite data is stored in a read-write mounted volume under `/app/data`.
- [ ] `.sporades/binding.json` records the container ID and container name.
- [ ] Redeploy stops and removes the previously bound container before starting the replacement.
- [ ] `sporades deploy --json` returns `{ ok: true, data: { url, port, containerId }, error: null }` on success.

## Blocked by

- .scratch/sporades-v0/issues/04-run-todo-query-mutation-loop.md
