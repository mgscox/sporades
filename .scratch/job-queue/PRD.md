# Job Queue

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "Job queue")
- `docs/PRD.md`
- `CONTEXT.md`
- `docs/adr/0026-database-writes-use-intended-transaction-boundaries.md`
- `docs/adr/0027-capsule-roles-and-privileged-server-role-are-separate.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/08-add-job-queue.md`
- `.scratch/privileged-server-role/PRD.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to reflect the implementation status, per the roadmap Promotion Rule.

## Problem Statement

Capsule authors need durable background work for tasks that should outlive one
request, WebSocket connection, or browser session. Today, server handlers can do
work synchronously, and the Privileged server role gives Sporades an explicit
actor for system-owned execution, but there is no runtime-owned Job Queue for
storing, running, retrying, or inspecting Jobs.

Without a first-class queue, Capsule authors are pushed toward app tables,
ad-hoc timers, or external workers. That muddles actor semantics, makes retry
behavior inconsistent, and gives AFK agents no stable inspection surface.

## Solution

Add a runtime-owned Job Queue for durable Capsule background work. Capsule
server code will declare Job handlers and enqueue work from trusted server
surfaces. The queue stores Jobs in Sporades-owned runtime state, runs them under
an explicit actor, records deterministic lifecycle state, retries bounded
failures, and exposes actor-scoped Job inspection and queue summaries.

The first implementation should be local-first and SQLite-backed. Jobs run in
the existing server runtime process for Dev sessions, local Container sessions,
and Hosted Capsules, then resume eligible work after restart. Future queue
adapters can be added below the same runtime-owned API after the SQLite path is
proven.

The queue should deliberately shape the concepts that Job scheduling will need:
Job identity, actor semantics, retry behavior, restart recovery, safe result and
failure metadata, and inspection boundaries. Recurrence and scheduling remain
outside this PRD.

## Runtime Model

A Job is a durable unit of background work owned by one Capsule. Jobs live in
runtime-owned storage, not Capsule app schema. A Job records:

- stable Job ID;
- queue name or handler name;
- lifecycle status;
- safe `enqueuedBy` provenance and a separate execution actor;
- input payload;
- availability time, attempt history, retry policy snapshot, and optional
  idempotency key;
- claim and lease state needed for at-least-once recovery;
- timestamps for creation, availability, start, completion, failure, and
  cancellation;
- bounded safe result or failure metadata.

The initial implementation should use SQLite-backed runtime tables for Dev
sessions, local Container sessions, and Hosted Capsules. The storage shape
should remain adapter-aware so future Redis or hosted queue adapters can be
added without changing app-facing APIs.

Job execution should run inside the same server runtime process for the first
implementation, with one worker and execution concurrency of one per Capsule.
Workers claim eligible Jobs atomically using a lease. Jobs are ordered by
`availableAt` and then stable Job ID. An expired lease is recoverable work, so
the queue provides at-least-once execution rather than exactly-once execution.
Job handlers must therefore tolerate duplicate execution.

Dev session restarts may stop in-flight execution, but queued and delayed Jobs
must remain durable. Container sessions and Hosted Capsules should resume
eligible Jobs after runtime start, and expired running claims should consume an
attempt before the Job is delayed for another attempt or becomes failed.

## Actor Semantics

Each queued Job must record who enqueued it separately from the authority it
runs as. The first release supports two execution actor modes:

- current Sporades user identity, normalized to a captured user ID at enqueue
  time for user-owned work;
- Privileged server role for system-owned work that intentionally has no user.

Capsule code cannot supply an arbitrary captured user ID in the first release,
and the queue never persists Session tokens, cookies, or browser credentials.
Captured-user Jobs evaluate current ACL policy when they run. If the captured
user no longer exists, the Job fails terminally with a bounded safe error such
as `JOB_ACTOR_UNAVAILABLE`.

Jobs must not pretend to be the last connected user, and they must not smuggle
Privileged server role authority into browser credentials. Job state and logs
should make the actor mode visible without leaking secrets.

## App-Facing Shape

The exact API can be refined during implementation, but the PRD expects a
server-only authoring surface shaped around explicit handlers and enqueue calls:

- Capsule code declares Job handlers from `sporades/server`.
- Trusted server handlers enqueue Jobs with payload, availability, optional
  idempotency key, actor mode, and retry options.
- Normal server context can get and list Jobs assigned to the current user.
- Privileged server context can get and list all Jobs in the Capsule.
- Unsupported payloads, actor modes, retry options, and handler names fail with
  structured errors.

Queue writes are durable runtime-owned side effects, but they are not atomic
with Capsule app mutation writes in the first release. The API and docs must not
imply a shared Transaction boundary. An optional idempotency key, unique by
Capsule, handler, and execution actor for as long as the Job is retained, returns
the existing Job on a repeated enqueue. This gives Capsule code a way to make
cross-boundary workflows retry-safe; a transactional outbox remains future
work.

Payload and metadata limits should reuse an existing Sporades structured-payload
limit where one applies. Otherwise, the first queue uses 64 KiB limits for
serialized input and result values and an 8 KiB limit for serialized safe
failure metadata. Limit failures are structured and occur before enqueue or
completion state is committed.

The client should not receive a direct queue API in the first slice. Browser
flows that need background work should call a normal server mutation, endpoint,
or App message handler, and server code should enqueue the Job.

## Retry And Failure Semantics

Jobs should have bounded retry behavior with deterministic state transitions.
The first implementation should support:

- `queued` for work eligible to run now;
- `delayed` for work whose `availableAt` is in the future, including an initial
  delay or retry backoff;
- `running`, `succeeded`, `failed`, and `cancelled` for execution and terminal
  outcomes;
- configurable max attempts with a conservative default;
- deterministic retry delay or backoff policy;
- safe failure metadata that avoids stack traces, tokens, Server env values,
  cookies, and raw request bodies;
- cancellation for queued or delayed Jobs, plus a `cancelRequestedAt` marker and
  best-effort cancellation signal propagation for running Jobs.

The normative transitions are `delayed -> queued` when work becomes available,
`queued -> running` when claimed, `running -> succeeded` on success,
`running -> delayed` when another attempt is allowed, and `running -> failed`
when attempts are exhausted. Queued or delayed Jobs can become `cancelled`.
Running cancellation is cooperative: the Job remains running after cancellation
is requested, and its actual handler outcome determines the terminal state.

Retries must not duplicate a Job's identity. A retry is another attempt for the
same Job, not a new Job unless server code explicitly enqueues one.

## Inspection

Sporades should expose Job state through deterministic, agent-friendly,
paginated inspection. In normal user mode, Capsule server code can get and list
only Jobs whose execution actor is the current captured user. In Privileged
server role mode, Capsule server code can get and list all Jobs belonging to the
Capsule. `enqueuedBy` provenance does not grant visibility. An unauthorized
Job ID must be indistinguishable from an unknown Job ID.

Lists expose bounded safe summaries, omit payloads, results, and failure detail
by default, and support cursor, status, handler, and creation-time filters.
Privileged listing must run through `ctx.privileged.run(...)` and emit the
existing mandatory audit events. CLI JSON inspection should expose equivalent
operator-safe summaries; human output should stay concise and point operators
at Job IDs and follow-up commands rather than dumping internals.

## User Stories

1. As a Capsule author, I can declare a server-side Job handler and enqueue work
   from a trusted server surface.
2. As a Capsule author, I can enqueue user-owned work that keeps the captured
   Sporades user identity after the original request ends.
3. As a Capsule author, I can enqueue system-owned work that runs as the
   Privileged server role without inventing a fake user.
4. As a Capsule author, I can get and list Jobs assigned to the current user
   without modelling Jobs as app tables.
5. As an operator, I can see delayed, queued, running, and failed Jobs through a
   deterministic CLI/JSON surface.
6. As an AFK agent, I can verify retry behavior, failure metadata, and runtime
   restart recovery without scraping logs.
7. As a maintainer, I can keep the first queue SQLite-backed while preserving a
   future path to queue adapters.
8. As a maintainer, I can leave recurring scheduling for a separate PRD once the
   queue state machine and actor model are real.
9. As a Capsule author, I can receive a stable Job ID when work is enqueued, so
   that later server code or CLI inspection can refer to the same Job.
10. As a Capsule author, I can pass JSON-safe input payloads to Job handlers, so
    that background work can receive the data it needs without capturing a live
    request object.
11. As a Capsule author, I can see structured errors for invalid handler names,
    invalid payloads, invalid retry policies, and unsupported actor modes, so
    that queue failures are debuggable without parsing log text.
12. As a Capsule author, I can cancel queued or delayed Jobs, so that obsolete
    background work does not have to run.
13. As a Capsule author, I can receive a cancellation signal in a running Job
    handler, so that long-running work can stop cooperatively when possible.
14. As an operator, I can distinguish delayed, queued, running, succeeded,
    failed, and cancelled Jobs, so that queue health is inspectable.
15. As an operator, I can inspect bounded safe failure metadata, so that I know
    why a Job failed without exposing secrets.
16. As an operator, I can restart a Dev session, local Container session, or
    Hosted Capsule without losing queued work, so that Jobs are actually
    durable.
17. As an operator, I can see how Jobs left running during an unclean shutdown
    are classified on the next start, so that recovery behavior is predictable.
18. As a security officer, I can prove that Job Queue authority is server-only,
    so that browser credentials cannot enqueue privileged work directly.
19. As a security officer, I can prove that Jobs do not expose raw runtime-owned
    queue tables through Capsule schema, so that app code cannot mutate queue
    internals casually.
20. As a maintainer, I can verify generated runtime parity, so that Dev sessions,
    Container sessions, and Hosted Capsules run the same Job Queue behavior.
21. As a maintainer, I can keep queue inspection deterministic JSON-first, so
    that AFK agents can diagnose failures without scraping human output.
22. As a Capsule author, I can enqueue work for a future `availableAt` without
    introducing recurring Job scheduling.
23. As a Capsule author, I can list only Jobs assigned to the current user in
    normal server context and all Capsule Jobs in Privileged server role mode.
24. As a maintainer, I can rely on an explicit at-least-once delivery contract
    and deterministic lease recovery instead of an impossible exactly-once
    promise.

## Implementation Decisions

- The first Job Queue is runtime-owned Capsule state, not user-defined Capsule
  schema and not an app table.
- The default implementation is SQLite-backed for Dev sessions, local Container
  sessions, and Hosted Capsules.
- The app-facing API is server-only. Browser flows must ask server code to
  enqueue Jobs through existing trusted surfaces.
- Job handlers are declared by Capsule server code and invoked by the existing
  server runtime rather than a separate worker framework in the first release.
- One worker with concurrency one runs per Capsule. Atomic claims use leases,
  order eligible Jobs by `availableAt` then Job ID, and provide at-least-once
  execution with deterministic expired-lease recovery.
- The runtime records a stable Job ID, handler name, status, safe `enqueuedBy`,
  execution actor, payload, availability, optional idempotency key, retry policy
  snapshot, attempt history, lease state, timestamps, and bounded safe result or
  failure metadata.
- Jobs run as the current user captured at enqueue time or the Privileged server
  role. Capsule code cannot nominate an arbitrary captured user in v1.
- Privileged Job execution uses the implemented Privileged server role boundary;
  it does not invent a user, session, browser credential, or Capsule role.
- Privileged Job attempts and privileged list/get operations run through
  `ctx.privileged.run(...)` with mandatory audit events containing safe Job and
  attempt identity.
- Queue writes are not atomic with Capsule app mutation writes in v1. Optional
  idempotency keys are scoped by Capsule, handler, and execution actor while the
  Job is retained, and support retry-safe callers without promising a
  transactional outbox.
- Retry behavior is bounded and deterministic. Delayed Jobs are not runnable
  until `availableAt`; a retry remains another attempt for the same Job ID.
- Normal server context lists Jobs assigned to the current user. Privileged
  server context lists all Capsule Jobs. Both expose safe summaries rather than
  raw queue internals.
- Generated runtime artifacts must stay aligned with source runtime behavior.
- Job scheduling depends on this queue's state, actor, retry, and inspection
  semantics, but remains a separate planning track.

## Testing Decisions

- Start with high-seam behavior tests that exercise Capsule authoring APIs
  through real runtime paths rather than unit-testing private queue internals.
- Use type tests to prove Job Queue APIs are server-only and unavailable from
  `sporades/client`.
- Use runtime/database tests to prove Jobs are stored in runtime-owned state,
  not Capsule app schema or `ctx.db`.
- Use transaction-boundary tests to prove enqueue does not claim atomicity with
  Capsule mutation writes and idempotency keys prevent duplicate enqueue on
  caller retry.
- Use client-runtime tests to prove browser code cannot obtain Job Queue or
  Privileged server role authority.
- Use existing restart and runtime-session seams to prove queued Jobs survive
  Dev session restart, expired leases consume an attempt, and eligible Jobs
  resume with at-least-once semantics.
- Use existing Container and Host helper fake seams where available to verify
  local Container and Hosted Capsule persistence/inspection contracts without
  depending on live infrastructure in normal tests.
- Use generated-runtime parity checks so bundled Dev, Container, and Hosted
  behavior cannot drift from source runtime behavior.
- Use docs/type tests to keep public API docs, user docs, roadmap state, and
  scheduling boundaries aligned.
- Tests should assert external behavior: enqueue results, delayed availability,
  Job state, actor provenance and execution mode, user and privileged listing,
  retry transitions, lease recovery, safe metadata, JSON inspection shape, and
  public API availability. They should avoid coupling to private helper names
  unless that is the existing generated-runtime parity seam.

## Out of Scope

- Do not implement cron, recurrence, missed-run recovery, or duplicate-run
  protection in this feature.
- Do not treat one-time delayed availability as recurring Job scheduling.
- Do not promise exactly-once execution or transactional enqueue with Capsule
  app mutations; a transactional outbox remains future work.
- Do not let Capsule code nominate an arbitrary captured Sporades user in v1.
- Do not require Redis, Bull, or a remote queue service for the default local
  developer loop.
- Do not expose raw queue tables through `ctx.db` or Capsule schema.
- Do not make Jobs browser-callable without server mediation.
- Do not add Capsule roles, Teams, or app-admin authorization.
- Do not implement automated backups or Host backup/restore as part of this
  feature.
- Do not centralize JSON logging or replace the Privileged audit event contract.
- Do not add managed external storage or external database support as part of
  this feature.

## Implementation Issues

- `issues/01-run-and-inspect-current-user-jobs.md`
- `issues/02-add-privileged-jobs-and-actor-provenance.md`
- `issues/03-add-delays-retries-and-cancellation.md`
- `issues/04-recover-jobs-with-at-least-once-delivery.md`
- `issues/05-list-and-inspect-jobs-across-runtime-sessions.md`
- `issues/06-document-job-queue-and-update-roadmap.md`

## Further Notes

The first queue should be boring in the best possible way: durable state,
explicit actors, bounded retries, restart recovery, and inspection that an agent
can trust. Job scheduling can be ambitious later; the queue should first make
plain background work solid enough to stand on.
