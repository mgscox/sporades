# Align async handler types with runtime behavior

Status: done

## What to build

Make the public TypeScript handler types and the runtime agree about async behavior. If handler types allow `Promise` results, Dev sessions and Container sessions should await query, mutation, message, endpoint, middleware, and hook handlers where that is part of the supported API. If any handler category must remain synchronous, the public types and docs should say so clearly.

The preferred outcome is first-class async support for app handlers because the public API already teaches users that async handlers are valid.

## Acceptance criteria

- [ ] Async query handlers resolve before `query.result` messages are sent.
- [ ] Async mutation handlers resolve inside the transaction boundary before commit and subscription refresh.
- [ ] Async endpoint handlers resolve before HTTP responses are written.
- [ ] Async message handlers resolve before `app.result` is sent.
- [ ] Public TypeScript types, runtime behavior, and docs agree for every handler category.

## Blocked by

- .scratch/codebase-shortfalls/issues/01-run-query-handlers-from-bundled-capsule-module.md
- .scratch/codebase-shortfalls/issues/02-run-mutation-handlers-from-bundled-capsule-module.md
