# Add Host Server health check route

Status: ready-for-agent

## Parent

.scratch/sporades-host-ops-and-autodeploy/PRD.md

## What to build

Add a minimal public Host server health route that lets developers and agents
verify that DNS, TLS, Caddy, and the Host server route layer are alive. The
response should be deliberately small and safe: it may confirm that the Host
server is reachable and the route layer is responding, but it must not expose
container names, file paths, versions, resource metrics, secrets, or registry
details.

## Acceptance criteria

- [ ] A Host server health URL is available for each Hosted domain after bootstrap.
- [ ] The health response is valid JSON with an `ok` value and only safe public fields.
- [ ] The health route works even when no Hosted Capsules are currently running.
- [ ] `sporades host health --json` checks the selected or explicit Host profile and reports structured success or failure.
- [ ] Failures distinguish unreachable Host server, TLS/HTTP failure, and unexpected health response shape.
- [ ] Tests cover route generation, safe response fields, successful CLI output, and representative failure modes.

## Blocked by

None - can start immediately

