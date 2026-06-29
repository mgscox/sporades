# Add pre/post mutation hooks

Status: done

## What to build

Add Capsule-level hooks around mutation execution so developers can centralize validation, audit logging, and side effects without repeating that logic in every mutation handler. Hooks should run within the server runtime's mutation path and preserve existing structured error and query invalidation behavior.

## Acceptance criteria

- [ ] A Capsule can register pre-mutation and post-mutation hooks through the `capsule()` definition.
- [ ] Pre-mutation hooks can inspect mutation name, arguments, and context before the mutation handler runs.
- [ ] Pre-mutation hooks can block a mutation with a structured error.
- [ ] Post-mutation hooks can inspect mutation result and context after a successful mutation handler.
- [ ] Query invalidation and subscription refresh behavior still works when hooks are registered.
- [ ] Hook failures produce structured errors and actionable hints without leaving partial runtime state.

## Blocked by

- .scratch/sporades-v1/issues/02-add-additive-field-migrations.md
