# Route Hosted Capsules through loopback-published ports

Status: ready-for-agent

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Make Hosted Capsule running routes work when Caddy is installed directly on the Host server rather than inside Docker. A started Hosted Capsule should publish its container port on a loopback-only host port, discover that assigned port, and write the Capsule route to `127.0.0.1:<published-port>` instead of relying on Docker container-name DNS.

This preserves the current native-Caddy prerequisite model while avoiding public container ports, Docker bridge IP pinning, and manual route edits.

## Acceptance criteria

- [ ] `sporades host push --restart` starts Hosted Capsule containers with port `4000` published only on `127.0.0.1` using an automatically assigned host port.
- [ ] The Host helper discovers the assigned loopback host port from Docker after the container starts and writes the running Caddy route as `reverse_proxy 127.0.0.1:<port>`.
- [ ] Running route output and JSON lifecycle results report enough route/container information to diagnose the selected loopback target.
- [ ] Stop, restart, failed-start rollback, unavailable-route fallback, and registry updates continue to behave correctly.
- [ ] Tests cover the Docker run arguments, published-port inspection, generated Caddy route, restart behavior, and failure when Docker does not report a usable loopback host port.

## Blocked by

None - can start immediately
