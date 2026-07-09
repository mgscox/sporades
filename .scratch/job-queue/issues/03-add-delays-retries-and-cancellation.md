# Add Delays, Retries, And Cancellation

Status: done

## Parent

.scratch/job-queue/PRD.md

## What to build

Extend the working queue with one-time delayed availability, bounded retries,
attempt history, and cooperative cancellation. A Job is `queued` only when it
is ready to run; `delayed` covers both an initial future `availableAt` and retry
backoff without introducing recurring Job scheduling.

## Acceptance criteria

- [ ] Enqueue accepts a one-time future `availableAt`; such a Job is `delayed` until that time and then transitions to `queued`.
- [ ] Retry policy supports bounded max attempts and deterministic delay or backoff with conservative defaults.
- [ ] A retryable failure transitions `running -> delayed -> queued` under the same Job ID; exhausted attempts transition `running -> failed`.
- [ ] Attempt history records each start, outcome, timing, and bounded safe error code without raw stack traces, tokens, cookies, Server env values, or raw request bodies.
- [ ] Queued or delayed Jobs can transition directly to `cancelled` before execution.
- [ ] Cancelling a running Job records `cancelRequestedAt` and propagates its `AbortSignal`, but leaves the Job `running` until the handler actually returns or throws.
- [ ] A running handler that completes after cancellation was requested becomes `succeeded`; an abort-shaped throw becomes `cancelled`; other errors follow the normal retry or terminal failure rules.
- [ ] Delayed one-time execution is documented and tested as Job Queue behavior; cron, recurrence, timezone handling, missed-run policy, and duplicate recurring-run protection remain out of scope.
- [ ] Structured errors distinguish handler failure, retry exhaustion, cancellation, and invalid state transitions.
- [ ] Tests cover initial delay, delayed ordering, success, retry exhaustion, attempt history, retry delay selection, queued/delayed cancellation, running cancellation outcomes, and safe metadata redaction.

## Blocked by

- .scratch/job-queue/issues/02-add-privileged-jobs-and-actor-provenance.md

## Comments

- Integrated by the Job Queue swarm as `0946b9c`, `15f7a33`, `40a48be`, `c38b5b9`, `fb75562`, `0ecca6a`, `231ced6`, and `44459dc` after independent review accepted worker SHA `1d322d68623eb60fd472b9e52fbff995c8bd6405`.
- Integration checks: build plus full delay/retry/cancel, privileged, current-user, and type suites passed.
