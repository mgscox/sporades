# Start a bundled dev session that serves the scaffold

Status: done

## What to build

Implement the first `sporades dev` path for a scaffolded project. The command should bundle the server and client with esbuild, write those bundles into the runtime directory, start a local Node dev session from the server bundle, and serve the user-owned `index.html` plus client bundle over HTTP.

## Acceptance criteria

- [ ] Running `sporades dev` in a scaffolded project creates `.sporades/build/server.mjs` and `.sporades/build/client.js`.
- [ ] The dev session serves `/` from the project's `index.html` and serves `/client.js` from the bundled client output.
- [ ] The dev session uses the config cascade for port selection: `sporades.json` then CLI flag then default.
- [ ] The server runtime receives project configuration as startup input rather than reading `sporades.json` directly.
- [ ] `sporades dev --json` emits a structured started event including the local URL and port.
- [ ] Build or startup failures exit with code 1 and include structured errors with actionable hints.

## Blocked by

- .scratch/sporades-v0/issues/01-create-runnable-react-todo-scaffold.md
