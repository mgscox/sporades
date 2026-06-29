Status: ready-for-agent

# List Connected Auth Clients

## What to build

Add a CLI command that lists connected browser clients for the running dev server so agents can choose where to seed a simulated identity. The command should expose stable client identifiers and useful metadata without leaking session tokens or secrets.

This should be a test-driven design task. Verify the public CLI JSON output and the targeting behavior it enables rather than private connection registry details.

## Acceptance criteria

- [ ] `sporades auth clients --json` lists connected clients for a running dev server.
- [ ] Each listed client has a stable identifier suitable for a later exact-targeting command, plus safe metadata such as current auth provider or connection age where available.
- [ ] The output does not include session tokens, provider secrets, or localStorage values.
- [ ] The command returns structured errors when no compatible dev server is reachable.
- [ ] Exact `--client <id>` targeting is either implemented here or documented as the immediate follow-up enabled by this command.
- [ ] Tests cover no clients, one client, multiple clients, and no secret leakage in JSON output.
- [ ] Documentation explains when to use `current`, `all`, and listed client IDs.

## Blocked by

- .scratch/sporades-auth-session-controls/issues/05-push-simulated-sessions-to-connected-clients.md
