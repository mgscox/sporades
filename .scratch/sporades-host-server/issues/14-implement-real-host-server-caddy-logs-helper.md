# Implement real Host server Caddy log retrieval

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement the real `host.logs` action in the Host server helper so `sporades host logs` can retrieve recent Host server Caddy logs from the actual server. The command should preserve the existing CLI output contract while reading from the real Caddy service or configured log location, and should be useful for debugging Cloudflare-to-origin routing and generated Capsule routes.

Real-server verification should generate at least one HTTP request to a registered template Capsule route and then confirm the recent Host server logs can be retrieved without manually SSHing to inspect Caddy.

## Acceptance criteria

- [ ] `sporades host logs --host <alias> --lines <n> --json` succeeds against a real Host server and returns recent Caddy log entries in the standard Sporades JSON envelope.
- [ ] The helper supports the current server's Caddy logging source, such as journald for the Caddy service or a managed Caddy access log file, without requiring manual SSH commands from the user.
- [ ] Empty or unavailable logs return structured output or structured errors with actionable hints rather than raw command noise.
- [ ] Plain output prints only recent log entries, while `--json` includes requested line count and entries.
- [ ] Real-server tests trigger a request against a registered disposable `todo` or `guestbook` Capsule route and verify logs using environment-provided server/domain settings.
- [ ] Tests may load `.env` for opt-in real-server settings, but no concrete server IP, domain, credentials, or certificate paths are committed.

## Blocked by

- .scratch/sporades-host-server/issues/11-implement-real-hosted-domain-bootstrap-helper.md
