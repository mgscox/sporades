# Retrieve Host server Caddy logs

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Add CLI access to recent Host server Caddy combined logs for origin-level debugging. Developers should be able to retrieve the last N lines for a Host profile/Hosted domain without SSHing manually or downloading full log files.

## Acceptance criteria

- [ ] `sporades host logs --lines <n>` retrieves recent Caddy combined log lines for the selected or explicit Host profile.
- [ ] The line count defaults to a conservative value and validates invalid values with a structured error.
- [ ] Plain output prints recent log lines without exposing unrelated command noise.
- [ ] `--json` returns the standard Sporades JSON envelope with the requested line count and log entries.
- [ ] The command is scoped to Host server logs and does not attempt to retrieve Capsule app logs or Docker logs.
- [ ] Tests cover default line count, explicit line count, invalid line count, empty logs, SSH failure, and remote helper failure.

## Blocked by

- .scratch/sporades-host-server/issues/03-bootstrap-host-server-and-hosted-domain.md
