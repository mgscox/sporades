Status: ready-for-agent

# Add Privileged File/Storage Access Through Existing Boundaries

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Add the first approved privileged file/storage operations for system-owned Capsule execution while preserving the existing File and Storage adapter boundaries. Privileged file/storage access should use the same runtime abstractions as normal access, with ACL bypass available only through the privileged context and audited with redacted bounded metadata.

## Acceptance criteria

- [ ] Privileged file/storage operations cover a narrow approved set of Capsule resources and fail closed for unsupported operations.
- [ ] Normal file/storage access remains ACL-protected by default.
- [ ] Privileged file/storage access does not introduce a separate Storage adapter contract or expose raw runtime storage tables.
- [ ] Audit metadata uses safe resource summaries such as resource kind, stable IDs where safe, counts, fingerprints, operation names, and safe error codes.
- [ ] Tests cover local file storage and configured Capsule storage services where the existing runtime abstractions support them.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/04-add-privileged-actor-identity-and-sentinel-guardrails.md
