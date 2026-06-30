# Push current releases to Hosted Capsules

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the remote push path for an already registered Hosted Capsule. Push should reuse the existing Bundle pipeline locally, transfer only runtime inputs to the Host server, install an immutable release atomically, update the current release pointer, and avoid restarting the Hosted Capsule unless `--restart` is explicitly requested.

## Acceptance criteria

- [ ] `sporades host push` resolves the target Hosted Capsule from local remote binding or explicit Host profile/subname flags.
- [ ] Push calls the existing Bundle pipeline and packages server bundle, client bundle, `index.html`, `sporades.json`, and optional Server env.
- [ ] Push transfers a compressed release archive over SSH-compatible transport and asks the remote helper to install it.
- [ ] The remote helper installs the release into an immutable release directory with a UTC-sortable release ID and atomically updates the current release pointer.
- [ ] Push keeps Hosted Capsule data outside release directories and does not send source files or `node_modules` to the Host server.
- [ ] Push does not restart by default.
- [ ] Tests verify archive contents, install-only behavior, current release update, optional Server env handling, and standard JSON output.

## Blocked by

- .scratch/sporades-host-server/issues/04-register-hosted-capsules-with-503-routes.md
