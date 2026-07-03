# Extend Host stats with protected resource details

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Extend the existing Host inspection surface instead of adding a competing
`sporades host status` command. Today `sporades host stats <subname> --json`
reports normalized Docker stats for one Hosted Capsule and `sporades host logs`
handles diagnostics. Keep that command family and add the missing protected
status deltas there.

The intended public CLI shape is:

- `sporades host stats --json` reports Host-level resource state for the
  selected or explicit Host profile.
- `sporades host stats <subname> --json` keeps the existing Capsule stats
  behavior and enriches it with lifecycle and release status.

Do not add a separate `sporades host status` command unless the PRD is updated
first. Public health routes from earlier issues must stay small and safe; this
issue gathers operational detail only through SSH/helper-owned Host state and
Docker, not through unauthenticated HTTP routes.

## Acceptance criteria

- [ ] `sporades host stats --json` works without a subname and reports Host server disk, memory, load, Docker availability, Caddy availability, and Hosted Capsule counts for the selected or explicit Host profile.
- [ ] `sporades host stats <subname> --json` remains backwards compatible with the current JSON envelope and includes additional Capsule lifecycle fields: registered state, running/stopped state, uptime when available, restart count when available, current release ID, and route target.
- [ ] Existing `sporades host stats <subname> --json` consumers still receive normalized CPU, memory, network, block I/O, and PID stats under the current `stats` key.
- [ ] Status data is gathered from Host-server-owned registry state, helper-local system checks, and Docker stats/inspect rather than scraped from public routes.
- [ ] No unauthenticated HTTP status route is added as part of this issue; any future HTTP status route must be specified in a separate issue with an explicit protection mechanism.
- [ ] The command reports structured failures for missing Host profile, SSH/helper failure, malformed registry state, Docker unavailable, unregistered Capsule, and stopped Capsule.
- [ ] Docs that currently mention `host stats` are updated to describe the new Host-level form and the enriched Capsule-level form without introducing `host status`.
- [ ] Tests cover Host-level stats, enriched Capsule-level stats, backwards-compatible JSON shape, normalized stats, docs/help text, and failure modes.

## Blocked by

- .scratch/sporades-host-ops-and-autodeploy/issues/01-add-host-server-health-check-route.md
