# Run mutation handlers from the bundled Capsule module

Status: done

## What to build

Make Dev sessions and Container sessions execute Capsule mutation handlers from the bundled Capsule module instead of reconstructing handlers from source text. A mutation should be allowed to use imported helpers, module-level constants, and ordinary handler shapes while still participating in transactions, cache invalidation, mutation hooks, and query subscription refresh.

This slice should preserve the existing WebSocket mutation protocol while proving the real bundled Capsule definition can drive one complete write path.

## Acceptance criteria

- [ ] A mutation handler that depends on an imported helper works in a Dev session.
- [ ] The same mutation handler works from the generated server Bundle used by Container sessions.
- [ ] Successful mutations still invalidate cached rows and refresh subscribed queries for the current user.
- [ ] Mutation errors still roll back the transaction and return structured `mutation.result` errors.
- [ ] Existing scaffold mutation behavior remains covered by tests.

## Blocked by

- .scratch/codebase-shortfalls/issues/01-run-query-handlers-from-bundled-capsule-module.md
