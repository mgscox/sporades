# Register Hosted Capsules with 503 routes

Status: done

## Parent

.scratch/sporades-host-server/PRD.md

## What to build

Implement Hosted Capsule registration against a bootstrapped Hosted domain. Registration should create the authoritative Host server registry record, reserve a Capsule subname, prepare server-side state, write local remote binding as a convenience pointer, and generate a Capsule route that returns the Hosted Capsule unavailable response until a container is running.

## Acceptance criteria

- [ ] `sporades host register <subname>` registers a Hosted Capsule on the selected Host profile's Hosted domain.
- [ ] Registration requires the Hosted domain to be bootstrapped and fails with a hint naming the bootstrap command and expected TLS files when it is not.
- [ ] Capsule subnames are validated as lowercase DNS-safe labels and reserved names are rejected.
- [ ] Capsule subname uniqueness is scoped to the Hosted domain, allowing the same subname on different Hosted domains.
- [ ] The Host server registry is authoritative for Hosted Capsule existence; local remote binding is written only as a convenience for the current project.
- [ ] Registration creates or regenerates a per-Capsule route pointing at the Host-server-owned `503 Service Unavailable` response.
- [ ] Tests cover successful registration, duplicate rejection, invalid subnames, domain-scoped uniqueness, local binding writes, and JSON output.

## Blocked by

- .scratch/sporades-host-server/issues/03-bootstrap-host-server-and-hosted-domain.md
