# Inject server env into dev and container sessions

Status: done

## What to build

Make server-only environment variables available consistently through `ctx.env` in dev and container sessions. The CLI should own reading and validating `.env.sporades.server`, pass the parsed values into the server runtime, and mount the env file read-only in the container session for v0.

## Acceptance criteria

- [ ] `.env.sporades.server` is parsed by the CLI for dev sessions and passed into the server runtime as startup input.
- [ ] Container sessions mount `.env.sporades.server` read-only at `/app/.env.sporades.server`.
- [ ] `ctx.env` exposes server env values to queries and mutations without requiring app code to read files.
- [ ] Env validation enforces a maximum of 64 keys, 64KB total size, and no `SPORADES_` prefix.
- [ ] Missing env files are handled gracefully for apps that do not need server env.
- [ ] Invalid env files fail commands with structured errors and actionable hints.

## Blocked by

- .scratch/sporades-v0/issues/05-add-anonymous-session-ownership.md
- .scratch/sporades-v0/issues/07-run-container-session-with-single-container-redeploy.md
