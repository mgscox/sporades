Status: done

# Implement Privileged DB Access Through Normal Adapter Boundaries

## Parent

.scratch/privileged-server-role/PRD.md

## What to build

Allow `privilegedCtx.db` to use the familiar Capsule table API while bypassing normal ACL gates only through an internal runtime capability. This should preserve normal `ctx.db` behavior by default, keep ACL evaluation constrained, and avoid introducing a separate Database adapter or raw runtime-table escape hatch.

## Acceptance criteria

- [x] `privilegedCtx.db` can perform approved Capsule app-table reads and writes that would otherwise be blocked by normal ACL gates.
- [x] Normal `ctx.db` access remains user-scoped and ACL-protected by default.
- [x] Capsule code cannot forge privileged access by setting role-shaped, skip-ACL-looking, or capability-looking properties on a normal handler context.
- [x] ACL rule evaluation cannot access or call `ctx.privileged.run(...)`.
- [x] `ctx.acl` remains read-only and cannot access Privileged server role execution or runtime-owned non-app resources.
- [x] The implementation uses the existing Database adapter boundary; privileged DB behavior is a runtime route decision, not a separate adapter contract.

## Blocked by

- .scratch/privileged-server-role/issues/02-add-minimal-ctx-privileged-run.md
- .scratch/privileged-server-role/issues/03-harden-privileged-run-failure-and-cancellation.md
- .scratch/privileged-server-role/issues/04-add-privileged-actor-identity-and-sentinel-guardrails.md

## Verification

- Issue-swarm worker: 019f42df-277c-7ae1-9304-3aafc3a52442
- Review: 019f42e7-ec3d-73b1-9cf1-86412c1a740d accepted after revocation fix.
- `npm run build`
- `node --test --test-name-pattern "leaked privileged table APIs|privileged table API bypasses normal ACL|normal handler contexts cannot forge privileged DB ACL bypass" test/database-adapter.test.js`
- `node --test test/table-acl.test.js`
- `node ./scripts/check-generated-bin.mjs`
