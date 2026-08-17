# Job Scheduling

Status: ready-for-agent

## Source Planning

- `docs/ROADMAP.md` (Recommended Next Features: "Job scheduling")
- `docs/PRD.md`
- `CONTEXT.md`
- `docs/adr/0027-capsule-roles-and-privileged-server-role-are-separate.md`
- `docs/adr/0028-job-inspection-is-a-one-shot-bundle-action.md`
- `docs/adr/0029-scheduled-jobs-use-schedule-provenance.md`
- `docs/adr/0030-job-scheduling-only-enqueues-ordinary-jobs.md`
- `.scratch/job-queue/PRD.md`
- `.scratch/privileged-server-role/PRD.md`
- `.scratch/post-v2-platform-hardening-and-ops/issues/09-add-job-scheduling.md`

When this feature is implemented and documented, `docs/ROADMAP.md` MUST be
updated to reflect the implementation status, per the roadmap Promotion Rule.

## Problem Statement

Capsule authors can enqueue durable Jobs immediately or make one Job available
at a future time, but they cannot declare recurring work. Features such as
periodic cleanup, report generation, synchronization, and future automated
backups therefore require an external cron service, a permanently connected
user, or ad hoc timer code that loses its state when a Dev session, Container
session, or Hosted Capsule restarts.

Ad hoc recurrence also leaves important behavior undefined. Authors cannot tell
whether a missed occurrence will be skipped or recovered, which timezone owns a
wall-clock expression, how daylight-saving transitions behave, or how Sporades
prevents two runtime starts from creating duplicate Jobs for the same
occurrence. Scheduled work has no live request or Session from which to obtain
an actor, so it must not impersonate the last user or hide privileged execution
inside timer callbacks.

Sporades now has the prerequisites to solve this coherently: a durable
runtime-owned Job Queue, an explicit Privileged server role, deterministic Job
inspection, and runtime-owned persistence across Dev sessions, Container
sessions, and Hosted Capsules.

## Solution

Add server-only Job scheduling declarations to a Capsule. A named schedule
binds a declared Job handler to a five-field cron expression, an IANA timezone,
a JSON-safe payload, and an explicit missed-run policy. The runtime persists
schedule evaluation and occurrence state, converts each due occurrence into one
Privileged Job, and uses the Job Queue's existing durability, retry,
cancellation, lease recovery, and inspection behavior to execute it.

The first release supports two missed-run policies: `skip`, which resumes from
the next future occurrence, and `latest`, which creates at most the most recent
missed occurrence after downtime. It does not replay every missed occurrence.
Each occurrence has a deterministic identity derived from the Capsule,
schedule name, and scheduled UTC instant. Occurrence persistence plus Job Queue
idempotency makes repeated evaluation safe and prevents duplicate Jobs for one
occurrence without claiming exactly-once execution of the Job itself.

Schedules run only as the Privileged server role in the first release. They
cannot capture a browser Session, nominate an arbitrary Sporades user, or be
created dynamically by client code. Administrators and trusted server code can
inspect bounded schedule state, including the next occurrence, last evaluated
occurrence outcome, associated Job ID or safe error code, missed-run policy, and
effective timezone.

## User Stories

1. As a Capsule author, I want to declare a named recurring schedule next to my server-side Job handlers, so that recurring work is part of the Capsule definition.
2. As a Capsule author, I want a schedule to reference an existing named Job handler, so that recurrence reuses the durable Job Queue instead of creating a second execution system.
3. As a Capsule author, I want to use a familiar five-field cron expression, so that minute-level recurring work is concise to declare.
4. As a Capsule author, I want a Schedule to accept an explicit IANA timezone or default to the runtime server timezone, so that local server-time recurrence is concise while portable recurrence can be pinned.
5. As a Capsule author, I want invalid cron expressions to fail startup with a structured error, so that malformed schedules never fail silently.
6. As a Capsule author, I want an invalid explicit or unresolved server timezone to fail startup with a structured error, so that a Schedule never runs with unknown wall-clock semantics.
7. As a Capsule author, I want schedule names to be stable within a Capsule, so that persisted state survives rebuilds and restarts.
8. As a Capsule author, I want duplicate schedule names to fail deterministically, so that two declarations cannot compete for one persisted identity.
9. As a Capsule author, I want a schedule payload to use the Job Queue's JSON-safe limits, so that scheduled Jobs behave like ordinarily enqueued Jobs.
10. As a Capsule author, I want a schedule to pass ordinary enqueue retry options when it creates a Job, so that transient failures remain bounded without changing the Job handler contract.
11. As a Capsule author, I want scheduled work to execute as the Privileged server role, so that it has an explicit userless actor when no Session exists.
12. As a security officer, I want scheduled work to be impossible to declare or invoke from `sporades/client`, so that browser credentials cannot create recurring privileged work.
13. As a security officer, I want each scheduled privileged Job attempt to emit the existing Privileged audit events, so that system-owned recurrence is visible.
14. As an operator, I want audit and Job state to identify the originating schedule and scheduled occurrence, so that I can correlate execution with recurrence.
15. As a Capsule author, I want the default missed-run policy to skip missed occurrences, so that downtime does not unexpectedly create a workload spike.
16. As a Capsule author, I want to choose a `latest` missed-run policy, so that important recurring work can catch up once after downtime.
17. As a Capsule author, I want `latest` recovery to enqueue at most one missed occurrence, so that a long outage cannot create an unbounded backlog.
18. As a Capsule author, I want the next future occurrence to be scheduled after recovery, so that normal recurrence continues after downtime.
19. As an operator, I want schedule state to survive a Dev session restart, so that local recurrence is deterministic during development.
20. As an operator, I want schedule state to survive a Container session restart, so that local production-like recurrence does not reset.
21. As an operator, I want schedule state to survive a Hosted Capsule restart or new release, so that hosted recurrence remains durable.
22. As an operator, I want two overlapping runtime starts to produce no more than one Job for an occurrence, so that restart races do not duplicate scheduled work.
23. As an operator, I want a crash between recording an occurrence and creating its Job to recover safely, so that scheduled work is not silently lost.
24. As an operator, I want a crash after creating the Job but before completing schedule bookkeeping to reuse the same Job, so that recovery does not duplicate it.
25. As a Capsule author, I want each scheduled occurrence to have a stable UTC instant, so that duplicate protection is independent of display formatting.
26. As a Capsule author, I want cron matching to use local wall-clock fields in the effective timezone, so that `09:00` means 09:00 in that region.
27. As a Capsule author, I want a local time skipped by a daylight-saving jump to create no occurrence, so that Sporades does not invent a wall-clock time that never existed.
28. As a Capsule author, I want both real instants in a repeated daylight-saving hour to be eligible occurrences, so that cron evaluation follows actual matching instants.
29. As an operator, I want occurrence identities to distinguish repeated local times, so that daylight-saving fallback does not trigger false deduplication.
30. As a Capsule author, I want Schedule evaluation to use the timezone database shipped with the runtime, so that explicit and server-default timezone behavior is defined by the executing environment.
31. As a Capsule author, I want removing a declaration to delete its runtime Schedule state, so that redeclaring the name later starts fresh.
32. As an operator, I want historical Jobs from a removed schedule to remain inspectable, so that changing configuration does not erase operational history.
33. As a Capsule author, I want changing a schedule expression, timezone, static payload, optional factory `payloadVersion`, or retry policy to affect future occurrences only, so that deployed definition changes do not rewrite completed history.
34. As a Capsule author, I want changing a definition not to backfill occurrences under the old definition, so that deployments do not surprise me with stale work.
35. As a Capsule author, I want renaming a schedule to create a new schedule identity, so that identity changes are explicit rather than guessed.
36. As an operator, I want malformed persisted schedule state to fail closed with a bounded structured error, so that corruption does not cause a duplicate storm.
37. As an operator, I want malformed persisted Schedule state to fail inspection explicitly rather than disappear from a partial result, so that corruption cannot masquerade as an absent Schedule.
38. As an operator, I want to inspect each Schedule's enabled state, expression, effective timezone, missed-run policy, next occurrence, and latest occurrence outcome, so that recurrence is observable.
39. As an operator, I want schedule inspection to omit payload contents and secrets, so that operational visibility remains safe.
40. As an operator, I want deterministic JSON-only schedule inspection for an active Dev session, local Container session, and Hosted Capsule, so that agents can diagnose recurrence without scraping logs.
41. As an operator, I want empty schedule inspection to return `schedules: []`, so that Capsules without recurrence are a normal success case.
42. As an operator, I want schedule inspection to be read-only, so that diagnosis cannot advance the scheduler or create Jobs.
43. As an operator, I want stopped or unreachable targets to return existing structured target errors, so that schedule inspection follows Job inspection conventions.
44. As a maintainer, I want generated server Bundles to expose the same scheduling behavior as source runtime code, so that Dev, Container, and Hosted execution cannot drift.
45. As a maintainer, I want schedule persistence to use the configured Database adapter, so that SQLite, libSQL, and Postgres runtime state behave consistently.
46. As a maintainer, I want the scheduler to reuse Job Queue retention and inspection rather than own Job results, so that responsibilities stay narrow.
47. As a maintainer, I want a controllable runtime clock at the full runtime test seam, so that cron, recovery, and daylight-saving behavior can be tested without sleeping.
48. As an AFK agent, I want deterministic clock-driven tests for due, missed, and duplicate occurrences, so that scheduling failures are reproducible.
49. As a Capsule author, I want cancellation of one created Job not to disable its schedule, so that Job lifecycle and schedule lifecycle remain separate.
50. As a Capsule author, I want retries to remain attempts of the same occurrence's Job, so that a retry is not confused with a new scheduled occurrence.
51. As a Capsule author, I want the scheduler to pass exactly the payload declared by the schedule, so that ordinary Job handlers receive no hidden scheduling-specific input.
52. As a Capsule author, I want to declare schedules in a named map alongside my named Jobs, so that schedule identity and handler references are explicit.
53. As a Capsule author, I want a schedule payload to be either a JSON-safe value or a payload factory evaluated for each occurrence with an optional stable `payloadVersion`, so that recurring Jobs can receive occurrence-specific ordinary input, existing v0.8.5 factories remain valid, and versioned captured configuration changes create a new generation.
54. As a Capsule author, I want to declare a Schedule disabled, so that I can retain and inspect its definition without allowing it to run.
55. As a Capsule author, I want removing a Schedule declaration to forget its runtime Schedule state, so that redeclaring the same name later starts fresh rather than remapping historical state.

## Implementation Decisions

- Job scheduling is a runtime-owned server capability built on the implemented
  Job Queue. It calculates occurrences and creates Jobs; it does not execute
  handlers, own retry loops, or duplicate Job lifecycle state.
- Job Scheduling does not change `job()`, Job handler behavior, Job execution,
  or Job Queue management. For each occurrence it performs the equivalent of an
  ordinary privileged enqueue and then leaves the resulting Job entirely under
  the existing Job Queue contract.
- The scheduler passes exactly the JSON-safe payload declared by the schedule.
  It does not inject `scheduledFor`, schedule identity, occurrence identity, or
  other scheduling fields into the handler payload or context. Schedule and
  occurrence identity remain operational Job metadata for inspection and audit.
- Capsule server definitions declare named schedules that reference named
  `job()` handlers. The declaration contains a five-field cron expression,
  optional IANA timezone, JSON-safe payload, missed-run policy, and optional
  ordinary Job Queue enqueue retry options.
- Any invalid Schedule declaration fails Capsule startup before Schedule state
  changes or evaluation begins. Sporades does not partially activate the valid
  subset. This is distinct from a payload factory failing later for one
  occurrence, which logs and advances that Schedule.
- Schedules are declared in a named `schedules` map alongside the existing
  named `jobs` map. A server-only `schedule()` declaration validates and brands
  the schedule definition; the map key is the stable Schedule identity.
- Schedule names begin with a letter and may then contain letters, numbers,
  underscores, or hyphens. Integer-like map keys are rejected so JavaScript
  property enumeration cannot reorder the author's declaration order.
- A schedule payload may be a JSON-safe value or a server-only payload factory
  evaluated when an occurrence is being scheduled. The factory produces the
  ordinary JSON payload passed to Job Queue enqueue; it does not change the
  `job()` handler contract.
- A payload factory may declare a stable non-empty `payloadVersion` of at most
  128 characters and should change it whenever factory code or captured
  configuration changes. Omission preserves the v0.8.5 source-text fingerprint
  for backward compatibility, though source text cannot reveal closure state.
  Static payloads are fingerprinted directly and do not accept `payloadVersion`.
- `payload` defaults to JSON `null` when omitted. Authors use an explicit value
  or payload factory only when the Job needs input.
- A payload factory receives immutable occurrence metadata plus a scheduling
  context containing the Privileged server role accessor. It does not begin in
  an elevated privileged context, and ordinary payload calculation emits no
  Privileged audit events. If the factory explicitly calls
  `ctx.privileged.run(...)`, the existing Privileged audit boundary and narrow
  privileged DB/File capabilities apply.
- The immutable occurrence metadata contains only `scheduleName` and the
  nominal UTC `scheduledFor`. The separate scheduling context contains
  `signal` and `privileged`. Internal occurrence IDs, claims, Job Queue state,
  and other runtime internals are not exposed.
- Payload factories may return a JSON-safe value synchronously or through a
  promise. Sporades awaits the result and validates the resolved value before
  enqueue; a rejected promise follows the same log-and-skip behavior as a
  synchronous throw.
- Payload-factory evaluation has a Capsule-wide timeout configured in
  `sporades.json` as `scheduling.payloadFactoryTimeoutSeconds`. It defaults to
  30 and accepts finite positive integers from 1 through 300. V1 has no
  per-Schedule timeout override. A timeout follows the same bounded log-and-skip
  behavior as a throw or rejected promise.
- The scheduling context includes an `AbortSignal` that is aborted when the
  payload-factory timeout expires. Cancellation is cooperative: Sporades
  discards any eventual result and creates no Job, but cannot forcibly stop
  JavaScript or undo side effects from a factory that ignores the signal.
- Different Schedules may evaluate payload factories concurrently under a
  fixed Capsule-wide limit of four. A single Schedule never evaluates two of
  its occurrences concurrently. V1 does not make this concurrency limit
  configurable. Shutdown aborts factories already evaluating and removes queued
  factories before they acquire a slot, so none starts after scheduling stops.
- When multiple Schedules are due at the same UTC instant, Sporades begins
  their occurrence and payload evaluation in declaration order, subject to the
  concurrency limit. Payload completion and Job execution order are not
  guaranteed: after enqueue, the existing Job Queue applies its ordinary
  `availableAt` and Job ID ordering with no Schedule priority or dependency.
- Payload factories are intended for dynamic data population rather than state
  mutation, but Sporades does not attempt to prove purity or block writes made
  through explicitly requested privileged access. Recovery may invoke a factory
  more than once; documentation warns authors that any resulting side effects
  are their responsibility and must tolerate repetition.
- If a payload factory throws, Sporades emits a bounded structured error for
  that Scheduled occurrence, advances the Schedule, and creates no Job. The
  scheduler does not retry the factory or borrow the not-yet-created Job's retry
  policy; future occurrences continue normally.
- V1 supports standard numeric five-field cron syntax for minute, hour,
  day-of-month, month, and day-of-week, including lists, ranges, and steps.
  Seconds, years, nicknames such as `@daily`, and implementation-specific
  extensions are rejected.
- Cron day-of-month and day-of-week follow conventional OR behavior when both
  fields are restricted. This behavior must be documented rather than inherited
  accidentally from a parser library.
- V1 schedules only Privileged Jobs. Scheduled captured-user Jobs, arbitrary
  user IDs, Session capture, browser credentials, and Capsule-role actors are
  not supported.
- The default missed-run policy is `skip`. The alternative `latest` policy
  creates only the most recent missed occurrence. V1 does not provide an `all`
  policy or unbounded catch-up.
- For `latest`, occurrence identity and payload-factory `scheduledFor` use the
  most recent missed cron instant, not the startup or recovery time. Recovery
  time remains operational metadata only.
- An occurrence is missed only when startup or recovery finds that its
  persisted occurrence time passed while no active scheduler could service it.
  A timer armed by a running scheduler still enqueues its intended occurrence
  when it fires late; ordinary timer or event-loop latency is not a missed run.
  V1 introduces no arbitrary lateness grace period.
- When `timezone` is omitted, Sporades resolves the runtime server timezone
  through Node's `Intl.DateTimeFormat().resolvedOptions().timeZone`. The
  effective timezone is validated and exposed in Schedule inspection. Docs warn
  that Dev, Container, and Hosted environments may have different server
  timezones; authors who need portable recurrence should specify one explicitly.
- An omitted timezone is re-resolved at each runtime startup. If the effective
  server timezone changed, Sporades treats it as a Schedule definition change
  for future occurrences only and performs no backfill under either timezone.
- Cron expressions are evaluated against wall-clock fields in the effective
  IANA timezone and converted to UTC instants for persistence. A nonexistent
  local time creates no occurrence. Both distinct instants in a repeated local
  hour may create occurrences, with distinct UTC occurrence identities.
- Documentation warns that daylight-saving behavior is an intentional
  consequence of choosing a local timezone. Authors who require invariant
  recurrence without skipped or repeated wall-clock times should use `UTC`.
- Each occurrence identity is derived from Capsule identity, schedule name, and
  scheduled UTC instant. The corresponding Job uses a deterministic internal
  idempotency key scoped to that occurrence.
- Schedule definitions and occurrence bookkeeping live in runtime-owned state,
  outside Capsule schema and unavailable through `ctx.db`.
- Occurrence creation is recoverable across the schedule-store and Job Queue
  boundary. A persisted pending occurrence is retried until its Job exists;
  Job Queue idempotency returns the existing Job if a crash occurs after enqueue
  but before occurrence bookkeeping completes.
- This recovery contract provides one durable Job identity per occurrence, but
  Job execution remains at-least-once under the existing lease contract.
  Handlers must still tolerate duplicate execution attempts.
- Scheduler evaluation is single-writer per claimed schedule evaluation, with
  conditional persistent claims protecting against overlapping workers or
  runtime starts. Expired claims are recoverable. A fresh incarnation token on
  the enabled durable Schedule row is authority during claim and recovery; a stale runtime leaves
  replacement-owned pending occurrences untouched and disables its local
  generation.
- Schedule state records the stable name, normalized expression, timezone,
  missed-run policy, definition fingerprint, enabled state, next occurrence,
  latest occurrence summary, claim state, and bounded safe error state. The
  latest occurrence summary contains `scheduledFor`, outcome (`enqueued` or
  `payload-failed`), the Job ID when enqueued, or a safe error code when payload
  creation failed. Payload contents are not included in inspection output.
- Runtime startup reconciles declared schedules with persisted definitions.
  The complete declaration set and fresh incarnation tokens publish atomically
  only after candidate recovery and timer capability can be validated; actual
  timers arm after commit, including a recovery wake planned when a retained-state
  compare-and-set loses, so callbacks cannot inherit completed transaction
  ownership and failed candidate initialization leaves the previous scheduler
  functional. Every retained or freshly calculated next-occurrence cursor must
  be a canonical four-digit UTC timestamp; malformed retained state or a
  startup calculation outside that domain fails startup with bounded
  `SCHEDULE_STATE_INVALID` state before persistence or a live timer arms. An
  enabled active Schedule has a cursor, an enabled exhausted Schedule has none,
  and a disabled Schedule is non-exhausted with no cursor. Startup and
  inspection reject every other retained combination before writes or timers.
  If an
  already-due occurrence is the final representable instant, its success,
  payload failure, or enqueue failure and latest summary commit atomically;
  future scheduling is durably exhausted, inspection returns `enabled: true`
  with `nextOccurrence: null`, and restart arms no replacement timer. When that
  final cursor is already due at restart, `latest` recovers it before atomic
  exhaustion while `skip` exhausts without enqueueing. A late
  final occurrence and its single-attempt Job clamp their claims to the
  remaining canonical domain; a retry policy that requires a later attempt
  commits the bounded enqueue-failure outcome.
  Inspection applies the same domain to the next cursor and latest-occurrence
  timestamp. Reconciliation,
  claim, and finalization lock the Schedule row before occurrence rows.
  Same-definition restart transfers
  compatible pending occurrences after locking the durable Schedule generation.
  A one-time migration records durable legacy-adoption lineage for genuine
  v0.8.5 rows. Only uninterrupted same-definition enabled lineage remains open;
  change, disablement, removal, or restoration closes it irreversibly. An open
  lineage runs a tracked once-per-second indexed discovery scan of at most 100
  wholly legacy pending rows, including rows written after startup by an overlapping
  v0.8.5 runtime. Shutdown cancels the scan and awaits an active batch.
  New declarations begin from startup time and do not backfill time before they
  existed. `enabled` defaults to `true`; a declaration may set `enabled: false`,
  in which case it remains persisted and inspectable but creates no
  occurrences. Inspection always returns the resolved boolean.
- Disabled declarations are still fully validated, including name, cron,
  timezone, Job handler reference, payload declaration, missed-run policy, and
  retry options. Disabling suppresses scheduling only, so changing `enabled` to
  `true` requires no additional definition fields or deferred validation.
- Job dispatch, Job recovery wakes, and Schedule evaluation remain stopped from
  runtime construction until the Capsule `init()` hook, retained Schedule
  validation, declaration reconciliation, and timer capability gates all
  complete successfully. A Job durably enqueued by `init()` cannot dispatch
  before that boundary. A failed initialization creates no Scheduled
  occurrences, unwinds and awaits all Job and Schedule runtime work, and leaves
  retained Jobs for recovery by a later successful open. Scheduling stops
  accepting new occurrences before `shutdown()` begins.
- Re-enabling a declared Schedule resumes from the deployment that enabled it
  and does not backfill its disabled interval. Removing the declaration deletes
  its runtime Schedule state while existing Jobs retain their historical
  schedule/occurrence metadata. Re-adding the same map key later creates a fresh
  Schedule beginning at that deployment time.
- Disabling or removing a Schedule applies only to future Job creation. Jobs
  already enqueued remain ordinary Jobs and are not cancelled or changed.
  Payload factories still running during replacement are aborted and discarded,
  and persisted pending occurrences that have not produced a Job are abandoned
  rather than recovered under the disabled or removed definition.
- A changed definition applies to future evaluation from the deployment that
  introduced it. It does not reinterpret completed occurrences or backfill
  occurrences under the replaced definition.
- Renaming a schedule removes the old runtime Schedule state and creates a new
  identity. V1 provides no rename migration metadata or heuristic matching.
- Cancelling or retrying an occurrence's Job does not disable or advance the
  schedule. Schedule recurrence and Job lifecycle are separate state machines.
- Trusted server code may get and list bounded schedule summaries only through
  the Privileged server role. Normal current-user contexts have no schedule
  authority because V1 schedules are system-owned.
- Operator inspection mirrors the existing Job inspection architecture:
  deterministic JSON-only commands for active Dev, local Container, and Hosted
  targets invoke a shared read-only one-shot generated-Bundle action through
  the existing local, Docker, and Host-helper transports.
- The commands are `sporades schedules`, `sporades deploy schedules`, and
  `sporades host schedules --host <alias> --subname <name>`. They explicitly
  target Dev, local Container, and Hosted Capsule state respectively and do not
  guess a runtime location.
- The shared internal runtime and Host-helper action is `schedules.inspect`.
  It accepts no filters or pagination arguments in V1.
- Schedule inspection does not evaluate schedules, acquire scheduler claims,
  enqueue Jobs, run lifecycle hooks, or emit Privileged audit events merely for
  administrator reads.
- V1 Schedule inspection exposes current summary state and the last associated
  Job ID or payload-failure code, not occurrence history. Each later occurrence
  replaces this summary. Older payload failures remain in structured logs, and
  historical execution remains in Job
  inspection and is correlated through Schedule and Scheduled occurrence
  metadata.
- Inspection ordering is by schedule name ascending. An empty store or Capsule
  with no declarations returns `schedules: []` without creating storage.
- If any persisted Schedule cannot be decoded, the whole inspection action
  fails with a bounded structured error identifying only the Schedule and
  malformed field. It returns neither a partial list nor the corrupt raw value.
  Invalid deployed declarations instead fail runtime startup before persisted
  Schedule state changes.
- Scheduled Job provenance and Privileged audit metadata include bounded
  Schedule name and scheduled occurrence identity so operators can correlate the
  scheduler, Job Queue, and audit surfaces without exposing payloads.
- Job `enqueuedBy` becomes explicit provenance: user-originated enqueue records
  user mode and user ID, while scheduled enqueue records schedule mode and
  Schedule name plus UTC `scheduledFor`. It is the sole Schedule provenance
  field; Job state does not add a redundant nullable `schedule` field. Capsule
  enqueue APIs cannot supply or spoof Schedule provenance. Scheduled Jobs do not
  invent an enqueuing user, Session, or privileged sentinel. Provenance grants
  neither visibility nor execution authority; scheduled execution remains
  separately the Privileged server role.
- The scheduler uses the Capsule's configured Database adapter and keeps source
  runtime, generated Bundle, and Host-helper protocol behavior aligned.
- The runtime gains an internal controllable clock/timer boundary for tests.
  This is not a Capsule authoring API and production defaults use the runtime's
  real clock and timers.

## Testing Decisions

- The primary seam is the existing full server-runtime behavior seam: start a
  Capsule runtime with declared schedules, advance a controllable runtime clock,
  restart the runtime where needed, and observe created Jobs and schedule state
  through public server inspection APIs.
- Tests should assert external behavior rather than cron-parser helpers,
  scheduler loops, SQL statements, private timers, or internal function names.
- Clock-driven runtime tests cover first occurrence, repeated occurrences,
  schedule ordering, future calculation, `skip` recovery, bounded `latest`
  recovery, late firing during a running session, and continued recurrence
  after recovery.
- Payload-factory failure tests prove the error is safely logged, no Job is
  created, the occurrence is not retried, and the next occurrence remains due.
- Payload-factory tests cover synchronous values, asynchronous values,
  unsupported resolved values, synchronous throws, rejected promises, default
  timeout, configured timeout, and configuration validation.
- Declaration tests prove omitted payload enqueues JSON `null` without changing
  Job handler semantics.
- Timeout tests prove the factory signal is aborted, eventual results are
  discarded, and ignored cancellation cannot create a late Job.
- Concurrency tests prove a slow factory does not block unrelated Schedules,
  no more than four factories run at once, and occurrences of one Schedule are
  never evaluated concurrently.
- Simultaneous-occurrence tests prove payload evaluation begins in declaration
  order while resulting Jobs retain ordinary queue ordering.
- Runtime restart tests cover durable definitions, pending-occurrence recovery,
  expired evaluation claims, crash-before-enqueue, crash-after-enqueue, and
  duplicate prevention across overlapping runtime starts.
- Lifecycle tests prove failed initialization creates no occurrences,
  successful initialization starts evaluation, shutdown stops new occurrence
  creation, and already-enqueued Jobs retain normal queue semantics.
- Timezone tests cover explicit zones, runtime-server default resolution, and
  differing environment defaults, plus fixed IANA zones and known transition dates to cover normal
  offsets, spring-forward nonexistent times, fall-back repeated times, and UTC
  occurrence identity.
- Definition reconciliation tests cover addition, removal, changed expression,
  changed explicit or server-default timezone, changed payload or retry policy,
  and rename-as-new-identity.
- Disabled-definition tests prove full validation still applies while payload
  factories are not evaluated and no occurrences are created.
- Declaration tests cover valid names, rejected integer-like or unsupported
  names, and stable source-order enumeration.
- Actor and audit tests prove scheduled Jobs run as the Privileged server role,
  preserve safe schedule/occurrence correlation, and cannot carry a Session or
  arbitrary captured-user identity.
- Job-state tests prove user or Schedule provenance is present as appropriate,
  unavailable as caller-supplied Schedule provenance, represented by one
  canonical field, and consistent across app and operator inspection.
- Provenance tests prove user and Schedule modes are explicit, no fake user is
  stored for scheduled enqueue, and provenance affects neither actor-scoped
  visibility nor execution authority.
- Payload-factory tests prove ordinary calculation emits no Privileged audit
  events, while explicit use of the supplied Privileged server role accessor
  retains its normal audit behavior.
- Existing Job Queue tests remain the prior art for idempotency, non-atomic
  queue writes, delayed availability, retry, cancellation, lease recovery,
  actor visibility, and bounded metadata. Scheduling tests should reuse those
  contracts rather than restate their internals.
- Type and client-runtime tests prove schedule declarations and inspection are
  server-only and unavailable from `sporades/client`.
- Type tests pin the payload-factory metadata and scheduling-context shape and
  reject access to internal occurrence or queue state.
- Adapter tests exercise schedule persistence and occurrence claims through the
  existing SQLite, libSQL, and Postgres setups.
- CLI, fake Docker, and fake SSH/Host-helper tests mirror existing Job
  inspection tests for Dev, Container, and Hosted targets, including empty,
  stopped, unreachable, incompatible-helper, and malformed-state cases.
- Generated-runtime parity tests prove source and bundled schedule declaration,
  evaluation, inspection-action, and Host-helper protocol behavior stay aligned.
- Documentation tests keep the glossary, public API, user guide, roadmap status,
  five-field cron restrictions, timezone/DST behavior, missed-run policies, and
  Job Queue dependency synchronized.

## Out of Scope

- Do not create a second Job execution engine, queue, retry system, worker pool,
  or result store.
- Do not support cron seconds, years, nicknames, calendars, RRULE, natural
  language expressions, or implementation-specific cron extensions in V1.
- Do not support one-off timers through the scheduling API; use Job Queue
  `availableAt` for one-time delayed availability.
- Do not support dynamic schedule creation, update, enable, disable, or deletion
  from browser/client code, Capsule mutations, CLI commands, or runtime APIs;
  `enabled` is part of the deployed server declaration.
- Do not support captured-user, arbitrary-user, Session, Capsule-role, or
  browser-credential scheduled actors in V1.
- Do not add an unbounded `all` missed-run policy or replay every occurrence
  after an outage.
- Do not promise exactly-once Job execution. Duplicate occurrence creation is
  prevented, while Job attempts retain at-least-once semantics.
- Do not add distributed leader-election infrastructure or require Redis,
  Bull, a remote cron service, or a Host-wide scheduler.
- Do not expose raw schedule or occurrence tables through Capsule schema or
  `ctx.db`.
- Do not implement automated backups, cleanup policies, reports, or other
  consumers of scheduling in this feature.
- Do not add Capsule roles or change the Privileged server role contract.
- Do not make offline Container or Hosted-volume inspection part of V1.
- Do not define retention or deletion of historical Jobs beyond the existing
  Job Queue contract.
- Do not add a separate Scheduled occurrence history API or duplicate Job
  attempt history in Schedule inspection.
- Do not add a structured Job-handler outcome for deliberately requeueing work;
  that is a future Job Queue contract rather than Job Scheduling behavior.

## Implementation Issues

- `issues/01-add-controllable-runtime-clock.md`
- `issues/02-declare-and-run-static-recurring-privileged-job.md`
- `issues/03-add-dynamic-schedule-payload-factories.md`
- `issues/04-apply-timezone-and-daylight-saving-semantics.md`
- `issues/05-recover-missed-runs-and-reconcile-declarations.md`
- `issues/06-make-occurrence-creation-crash-safe.md`
- `issues/07-inspect-schedules-and-correlate-jobs.md`
- `issues/08-inspect-dev-session-schedules-from-cli.md`
- `issues/09-extend-inspection-to-container-and-hosted-capsules.md`
- `issues/10-publish-job-scheduling-contract.md`

## Further Notes

The scheduler should be deliberately small: it answers when a named occurrence
is due and durably asks the Job Queue to run it. The Job Queue remains
responsible for everything that happens afterward. Keeping that boundary crisp
makes cron and timezone behavior testable without growing a second, moodier
queue beside the first one.
