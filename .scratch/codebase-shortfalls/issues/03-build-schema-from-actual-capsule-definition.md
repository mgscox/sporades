# Build schema from the actual Capsule definition

Status: done

## What to build

Build the runtime schema from the actual Capsule definition produced by `capsule()` rather than parsing table declarations from source text. The resulting schema should support normal JavaScript composition: imported field builders, shared field objects, computed schema fragments, and table declarations that are not written in one narrow textual format.

This slice should keep the existing database bootstrap and schema migration behavior visible end-to-end while removing source-text schema extraction from the supported path.

## Acceptance criteria

- [ ] A table schema assembled from imported or shared field definitions is registered correctly.
- [ ] Fresh Dev session startup creates the expected app tables from the actual Capsule definition.
- [ ] Container session startup creates the same app tables from the generated server Bundle.
- [ ] Existing additive migration tests still pass or are updated to exercise the actual Capsule definition path.
- [ ] Unsupported schema changes still fail with structured errors and actionable hints.

## Blocked by

- .scratch/codebase-shortfalls/issues/01-run-query-handlers-from-bundled-capsule-module.md
