Status: done

# Add Privileged File/Storage Access Through Existing Boundaries

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Add the first approved privileged file/storage operations for system-owned Capsule execution while preserving the existing File and Storage adapter boundaries. Privileged file/storage access should use the same runtime abstractions as normal access, with ACL bypass available only through the privileged context and audited with redacted bounded metadata.

## Acceptance criteria

- [x] Privileged file/storage operations cover a narrow approved set of Capsule resources and fail closed for unsupported operations.
- [x] Normal file/storage access remains ACL-protected by default.
- [x] Privileged file/storage access does not introduce a separate Storage adapter contract or expose raw runtime storage tables.
- [x] Audit metadata uses safe resource summaries such as resource kind, stable IDs where safe, counts, fingerprints, operation names, and safe error codes.
- [x] Tests cover local file storage and configured Capsule storage services where the existing runtime abstractions support them.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/04-add-privileged-actor-identity-and-sentinel-guardrails.md

## Verification

- Issue-swarm worker: 019f42df-2929-78c0-83b1-d899c4befd71
- Review: 019f42e8-c430-7243-b5eb-973d50f3a39f accepted after mutation transaction fix.
- `npm run build`
- `node --test --test-name-pattern "leaked privileged table APIs|privileged table API bypasses normal ACL|normal handler contexts cannot forge privileged DB ACL bypass|privileged file|unsupported privileged storage" test/database-adapter.test.js`
- `node --test --test-name-pattern "container server bundle reads injected service env|container server bundle uses injected MinIO storage env" test/deploy.test.js`
- `node ./scripts/check-generated-bin.mjs`
- `git diff --check`
