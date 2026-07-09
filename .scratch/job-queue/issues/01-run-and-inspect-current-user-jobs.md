# Run And Inspect Current-User Jobs

Status: done

## Parent

.scratch/job-queue/PRD.md

## What to build

Deliver the first complete Job Queue path for user-owned work. Capsule server
code can declare a named handler, enqueue JSON-safe work as the current user,
run it through a single Capsule worker, and get or list the resulting safe Job
state. The current user is captured as the execution actor at enqueue time;
Session tokens and browser credentials are never persisted.

## Acceptance criteria

- [ ] Capsule server code can declare a named Job handler through `sporades/server`, enqueue work as the current user, receive a stable Job ID, execute the handler, and inspect the completed state.
- [ ] The first worker model runs one worker with concurrency one per Capsule and orders runnable Jobs by `availableAt`, then stable Job ID.
- [ ] A Job available now uses `queued`, transitions through `running`, and ends as `succeeded` or `failed`; `pending`, `retrying`, and `dead` are not Job statuses.
- [ ] Runtime-owned storage records Job ID, handler, safe `enqueuedBy`, captured-user execution actor, bounded JSON-safe payload, status, availability, attempt information, timestamps, and safe result or failure metadata without exposing queue tables through Capsule schema or `ctx.db`.
- [ ] Normal server context can get and cursor-list only Jobs whose execution actor is the current captured user; `enqueuedBy` alone does not grant visibility.
- [ ] An unauthorized Job ID is indistinguishable from an unknown Job ID, and list summaries omit payloads, results, and failure detail by default.
- [ ] Capsule code cannot nominate an arbitrary captured user ID, and Jobs persist no Session token, cookie, browser credential, or Server env value.
- [ ] Queue writes are explicitly non-atomic with Capsule app mutation writes in v1; API behavior, docs, and tests do not imply a shared Transaction boundary.
- [ ] An optional idempotency key is unique by Capsule, handler, and execution actor while the Job is retained; repeating it returns the existing Job instead of enqueueing a duplicate.
- [ ] Payload bounds reuse an existing Sporades structured-payload limit where applicable, otherwise default to 64 KiB for serialized input/result and 8 KiB for serialized safe failure metadata.
- [ ] Invalid handlers, duplicate registrations, unsupported payloads, oversized payloads, and invalid options fail with structured errors before enqueue or completion state is committed.
- [ ] Job Queue types are server-only, browser/client code has no direct Job Queue authority, and generated runtime artifacts stay aligned with source behavior.
- [ ] High-seam tests cover the complete declare, enqueue, execute, get, and list path plus user isolation, idempotency, transaction-boundary behavior, type shape, and generated-runtime parity.

## Blocked by

None - can start immediately

## Comments

- Integrated by the Job Queue swarm as `c39658a`, `0f958a5`, `8b89aa5`, and `d1664d0` after independent review accepted worker SHA `e9c3c185ded6319728c097f4504652da46511fc1`.
- Integration checks: `npm run build && node --test test/job-queue.test.js test/types.test.js` passed. `test/docs.test.js` has a pre-existing planning-base failure because it expects `Job queue | design` while the committed roadmap correctly says `ready`.
