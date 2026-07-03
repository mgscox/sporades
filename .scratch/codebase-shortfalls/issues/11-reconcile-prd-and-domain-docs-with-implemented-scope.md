# Reconcile PRD and domain docs with implemented scope

Status: done

## What to build

Update the project requirements and domain documentation so they describe the platform that actually exists. The docs should no longer claim that v0 has no hosting, no TLS, no endpoints, or destructive schema-only migrations when the repository already includes Host server commands, Caddy TLS modes, endpoints, files, app messages, provider auth, and additive migrations.

The goal is to make future agent and maintainer work safer by removing stale mental models from the canonical docs.

## Acceptance criteria

- [ ] The root PRD accurately separates completed scope from future scope.
- [ ] Domain glossary entries match implemented concepts and avoid contradictions around local-only versus hosted behavior.
- [ ] Endpoint, auth, file, app message, and migration behavior are documented according to current runtime behavior.
- [ ] Any intentionally deferred hardening or architecture work points to the relevant issue or planning area.
- [ ] Existing ADRs are not contradicted by the updated docs.

## Blocked by

None - can start immediately
