# Run query handlers from the bundled Capsule module

Status: done

## What to build

Make Dev sessions and Container sessions execute Capsule query handlers from the bundled Capsule module instead of reconstructing handlers from source text. A Capsule query should be allowed to call imported helpers, close over module-level constants, and use normal TypeScript/JavaScript expression shapes while still returning results through the existing WebSocket subscription path.

This slice should keep the current public query transport behavior intact while proving that the server runtime can consume the real bundled Capsule definition for one complete read path.

## Acceptance criteria

- [ ] A query handler that depends on an imported helper works in a Dev session.
- [ ] The same query handler works from the generated server Bundle used by Container sessions.
- [ ] Query subscriptions still return structured `query.result` messages with the current data shape.
- [ ] Query handler failures still return structured errors with actionable hints instead of crashing the Dev session.
- [ ] Existing scaffold query behavior remains covered by tests.

## Blocked by

None - can start immediately
