# Expose logs and database inspection commands

Status: done

## What to build

Add early observability for dev sessions so developers and agents can inspect runtime behavior while the rest of v0 is being built. A running dev session should expose captured server logs and SQLite inspection data, and the CLI should provide `sporades logs` and `sporades db` commands that can operate against it with structured output.

## Acceptance criteria

- [ ] The server runtime provides `ctx.log.info`, `ctx.log.warn`, and `ctx.log.error`, and captured entries are available from the running dev session.
- [ ] `sporades logs` fetches recent server logs from the dev session, and `sporades logs --json` returns structured JSON.
- [ ] `sporades db list`, `sporades db dump`, and `sporades db query <sql>` operate against the dev session's SQLite database.
- [ ] `sporades db query` only allows read-only SQL and returns a structured error with a hint for rejected writes or invalid SQL.
- [ ] The debug HTTP surface remains internal to Sporades and does not introduce user-defined endpoints.
- [ ] Missing or unreachable dev sessions produce actionable hints instead of raw connection failures.

## Blocked by

- .scratch/sporades-v0/issues/02-start-bundled-dev-session.md
