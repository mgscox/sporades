Status: done

# Add ACL Denial Logging And Docs

## Parent

.scratch/database-and-storage-acl-rules/PRD.md

## What to build

Return opaque public denial errors while writing detailed structured internal logs for ACL diagnosis. Document ACL declaration, allow-by-default behavior, `write` fallback, read filtering, write previous/next state, and ACL context helper boundaries.

## Acceptance criteria

- [x] Public/client denial responses use a broad code such as `DENIED` and do not expose policy internals.
- [x] Internal structured logs include table/resource, operation, rule category, and enough context to diagnose denials without logging secrets or raw sensitive values.
- [x] Docs explain ACL rules as invisible accept/reject authorization policy.
- [x] Docs explain that storage ACL enforcement is reserved for a later slice but shares the `ctx.acl.storage` model.
- [x] Docs explain that `sporades doctor` may later warn about missing ACLs or open-to-the-world data.
- [x] Tests cover denial response shape, log detail, redaction, and docs examples where practical.

## Blocked by

- .scratch/database-and-storage-acl-rules/issues/04-add-scoped-acl-context-helpers.md
