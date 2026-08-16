# Jobs and Schedules Reference

Durable background work, Schedule declarations, runtime behavior, and CLI inspection.

[Back to the feature reference index](../guide/reference.md).

## Current-user Jobs

Declare durable server-only work with `job()` and enqueue it from a trusted
mutation, Custom endpoint, or App message handler through `ctx.jobs`. Enqueue
captures the current Sporades user; browser credentials are not stored with the
Job.

```ts
import { capsule, job, mutation } from "sporades/server";

export default capsule({
  name: "notes",
  jobs: {
    indexNote: job(async (ctx, input: { id: string }) => {
      // Runs later as the captured current user.
      return { indexed: input.id };
    }),
  },
  mutations: {
    index: mutation((ctx, id: string) =>
      ctx.jobs.enqueue("indexNote", { id }, { idempotencyKey: id }),
    ),
  },
});
```

`ctx.jobs.enqueue` persists the Job atomically inside the same mutation, App
message, or Custom endpoint transaction as `ctx.db` writes. A handler rollback
removes the Job. Worker dispatch starts only after the transaction commits. A
post-commit dispatch registration failure does not reverse or misreport the
committed handler outcome; the durable Job recovers on a later worker wake or
runtime restart. Supply an idempotency key when callers can retry a workflow;
repeating the same key for the same handler and captured user returns the
retained Job.

Jobs may use a one-time future `availableAt` and become `delayed` until then;
this is not recurring scheduling. A bounded `retry` policy records attempts and
uses a deterministic delay. `availableAt` must resolve to the canonical
four-digit UTC timestamp range (`0000` through `9999`); invalid dates and
extended-year timestamps are rejected with `INVALID_JOB_OPTIONS`. Pass a
`string` or `Date`; other coercible scalars such as numbers, booleans, or
`null` are invalid rather than implicit epoch timestamps. Retry policies
allow 1–20 attempts and a non-negative integer `delayMs`, provided every
configured attempt, intervening delay, and attempt claim lease remains inside
the same timestamp range. Legacy stored Jobs with an
invalid availability time or retry policy fail terminally during recovery
and are revalidated before worker claim instead of executing early or blocking
startup. Availability and retry instants must also leave room for the runtime's
bounded claim lease. Retry objects accept only `maxAttempts` and optional
`delayMs`; unsupported members and explicit `null` values are rejected.
`ctx.jobs.cancel(id)` cancels
queued or delayed work, or cooperatively requests cancellation of running work
through its signal.
For transactional mutation, App message, and Custom endpoint handlers, the
running handler is aborted only after the cancellation transaction commits; a
rollback discards the marker and the pending abort together. The pending abort
belongs to the transaction rather than a replaceable middleware context object.
The worker also rechecks the exact running claim after registering its abort
controller and before entering the handler, closing the claim-registration
cancellation window without touching a newer attempt.

The lifecycle states are `delayed`, `queued`, `running`, `succeeded`, `failed`,
and `cancelled`. Only `queued` Jobs are ready to run; `delayed` Jobs wait until
their `availableAt` time. The initial runtime uses a single worker. A running
attempt holds a lease, and lease recovery after interruption may execute that
attempt again. Storage recovery records an expired attempt before Capsule
initialization, but no recovered handler or retry wake starts until the runtime
has completed its `init()` boundary. Long `availableAt` and retry waits are
re-armed in bounded native-timer chunks, so dates beyond the platform timer
limit do not cause early execution or repeated queue scans. If restart happens
before a retained running attempt's lease expires, initialization tracks the
earliest canonical expiry and re-arms recovery in the same bounded chunks. The
attempt is reconciled only after its lease is actually due. A retained running
attempt with a missing or noncanonical lease fails terminally with
`JOB_LEASE_INVALID`; malformed non-null claim ownership fails with
`JOB_CLAIM_INVALID` instead of executing or leaving startup permanently stuck.

Job delivery is **at least once**, not exactly once: an interrupted leased
attempt can be recovered and run again under the same Job ID. Make handlers
duplicate-safe and use idempotency keys for caller retries.

An orderly runtime shutdown or Dev restart stops scheduling new Job work,
clears immediate, delayed, and retry worker timers plus the retained-lease
recovery wake, aborts active Job handlers, and awaits scheduled worker
settlement before the Capsule shutdown hook and
before mail, the Database adapter, and other runtime resources close. An active
worker settles its current attempt without claiming another queued Job, and
worker settlement failure does not skip resource closure. Durable queued and
delayed Job state remains stored and recovers on runtime restart. Each running
attempt owns an opaque claim, so a stale shutdown, recovery, completion, or
cancellation transition cannot overwrite a newer attempt. Cooperative handlers
may finish or observe the abort signal during shutdown. A shutdown abort without
a persisted `cancelRequestedAt` marker is not terminal cancellation and follows
the Job's ordinary retry or exhausted-attempt transition; an unclean
interruption still follows the lease-recovery and at-least-once rules above.
If shutdown wins after a claim but before the Capsule handler boundary, the
worker relinquishes that exact claim without consuming an attempt; a concurrent
durable cancellation marker remains terminal instead of being restored to
queued state.
If enqueue commits while a worker is completing an empty queue scan, the worker
records and runs another scan before relinquishing ownership; committed work is
not left waiting for another enqueue or restart. Signal shutdown stops accepting
and drains HTTP requests before runtime resources close. Capsule shutdown hook
failure still proceeds to Database adapter closure. Candidate initialization is
the Dev replacement ownership boundary: if teardown of the prior runtime then
reports a failure after closing its resources, Sporades promotes the viable
candidate and records a bounded warning instead of retaining a closed runtime or
closing its only usable replacement. Runtime close independently attempts mail,
Database adapter, and file-storage closure; if more than one fails, it reports
the failures together after every closer has been attempted. If worker
settlement or the Capsule shutdown hook fails alongside mail closure, shutdown
preserves and reports both failures.

`ctx.jobs.get(id)` reads one known Job. `ctx.jobs.list(...)` supports bounded,
cursor-based listing by actor. Current-user inspection sees only Jobs for its
captured execution actor. Privileged inspection through an explicit
`ctx.privileged.run(...)` may see all Jobs. In either view, `enqueuedBy` is
provenance—the user who caused the Job to be created—and is distinct from the
captured current-user or Privileged server role actor under which the handler
executes. If a captured user no longer exists when execution begins, the Job
fails terminally with `JOB_ACTOR_UNAVAILABLE`; remaining retry attempts are not
consumed.

One-time delayed availability is Job Queue behavior. For recurring work,
Capsule server code declares a named Schedule alongside its named Jobs:

```ts
import { capsule, job, schedule } from "sporades/server";

export default capsule({
  name: "reports",
  jobs: {
    sendDigest: job(async (_ctx, input: { audience: string }) => {
      return { audience: input.audience, sent: true };
    }),
  },
  schedules: {
    weekdayDigest: schedule({
      expression: "0 9 * * 1-5",
      timezone: "Europe/London",
      job: "sendDigest",
      payload: { audience: "subscribers" },
      retry: { maxAttempts: 3, delayMs: 60_000 },
      missedRun: "latest",
    }),
  },
});
```

Schedules use numeric five-field cron expressions. An explicit `timezone` must
be an IANA timezone available through the Node runtime. When it is omitted,
Sporades resolves the server timezone at each runtime startup. Dev, Container,
and Hosted environments can have different server timezone defaults, so pin a
timezone when recurrence must be portable. A changed server default affects
future occurrence calculation only; Sporades does not backfill under the old
timezone.

Cron fields are matched against local wall-clock time in the effective
timezone. When day-of-month and day-of-week are both restricted, either field
may match (conventional cron OR behavior). A local time skipped by a daylight-
saving spring transition produces no occurrence. During a repeated fall hour,
both matching UTC instants are eligible and have distinct occurrence identities.
Use `UTC` when recurrence must not skip or repeat because of daylight-saving
transitions.

The five fields are minute, hour, day-of-month, month, and day-of-week. Numeric
lists, ranges, and positive steps are supported; seconds, years, nicknames such
as `@daily`, and implementation-specific extensions are rejected. Schedule
declarations are server-only: browser code cannot create or invoke recurring
Privileged work. `payload` is either a JSON-safe value (defaulting to `null`) or
an async-capable payload factory evaluated for each occurrence. Every factory
must also declare a stable `payloadVersion` string of 1 through 128 characters:

```ts
payloadVersion: "weekday-digest-v2",
payload: async (occurrence, ctx) => ({ generatedFor: occurrence.scheduledFor }),
```

Treat `payloadVersion` as the identity of both the factory code and every value
it captures; bump it whenever either changes. Sporades deliberately does not use
`String(payload)` because JavaScript source text cannot reveal closure state.
Static JSON payloads are fingerprinted directly and must not set
`payloadVersion`. Payload factories may run more than once during crash
recovery, so any explicitly privileged side effects must tolerate repetition.
Shutdown aborts active factories and removes queued factories before slot
acquisition; queued factories never start after scheduling stops.
`retry` is the ordinary Job Queue retry policy applied after enqueue; a failed
payload factory is skipped and is not retried as a Job.

The default missed-run policy is `skip`, which resumes at the next future
occurrence after downtime. `latest` enqueues at most the most recent missed
occurrence, then resumes normal recurrence; it never replays an unbounded
backlog. Schedule state and pending occurrences survive runtime restarts through
the configured Database adapter. A deterministic identity based on Capsule,
Schedule name, and scheduled UTC instant prevents overlapping starts or crash
recovery from creating duplicate Jobs for one occurrence. Recovery validates all
three retained identity components together and quarantines a malformed or
mismatched row without letting its unique key fail startup or spin a timer.
Payload calculation can be repeated after a claim expires, but every pending
occurrence also carries its Schedule definition fingerprint. The runtime
rechecks both claim ownership and the live enabled durable definition inside the
write transaction: deterministic Job enqueue, occurrence terminal state, and
the Schedule's latest-occurrence summary commit together. Claim and recovery
use that durable definition as generation authority. A stale runtime therefore
leaves replacement-owned pending work untouched, cannot enqueue or overwrite
the replacement generation's cursor or durable outcome, and stops re-arming its
local copy of the Schedule.
Long waits for the next occurrence are re-armed in bounded native-timer chunks.
Every wake rechecks the current instant before persisting an occurrence, so
monthly, annual, and other distant recurrences cannot be overflow-clamped into
an immediate occurrence by the host timer implementation. Recovery waits for a
retained pending occurrence claim use the same bounded, tracked chunks and
recheck the durable expiry before attempting reconciliation. A transient
recovery failure installs a bounded retry wake rather than abandoning the
pending occurrence, and runtime close waits for active occurrence recovery
before closing its Database adapter. Retained occurrence instants and claim
expiries must be canonical four-digit UTC timestamps; malformed retained state
is terminally quarantined with the stable opaque
`SCHEDULE_OCCURRENCE_INVALID` code and is never left permanently pending.

Changing an expression, timezone, static payload, factory `payloadVersion`,
retry policy, or enabled state affects future occurrences only and does not
rewrite historical Jobs. Pending
occurrences from a changed or disabled definition are terminally quarantined as
`SCHEDULE_OCCURRENCE_SUPERSEDED`. Removing a Schedule forgets its runtime state,
supersedes its pending occurrences, and retains its Jobs; adding the same name
again after removal creates a fresh identity, while re-enabling it or renaming a
Schedule starts from the next future occurrence and cannot resurrect old
pending work. Legacy pending rows without a
definition fingerprint are likewise superseded safely. Disabling or cancelling
a created Job does not disable its Schedule.

Every successfully created Scheduled occurrence becomes an ordinary Job that
executes as the Privileged server role. It retains Job Queue **at least once**
attempt semantics: retries and lease recovery can repeat the same Job attempt,
so handlers must remain duplicate-safe. Schedule duplicate protection prevents
two Job records for one occurrence; it does not promise exactly-once execution.

## Inspect Jobs from the CLI

Administrators can inspect all Jobs for an active Capsule with one explicit
JSON-only command for each runtime location:

```sh
sporades jobs
sporades deploy jobs
sporades host jobs --host <alias> --subname <name>
```

The commands target an active Dev session, running local Container session, or
running Hosted Capsule respectively. Each returns the same structured JSON
envelope with the Capsule name and all Jobs ordered newest first. The bounded
operational state includes handler, status, actor, provenance, attempts, retry
policy, lifecycle timestamps, and safe result or failure metadata. Input
payloads and idempotency-key values are omitted.

This first operator surface intentionally has no filters, cursor, pagination,
human renderer, or offline inspection. Pipe the JSON through tools such as
`jq` when you need to filter or reshape it.

## Inspect Schedules from the CLI

Administrators inspect bounded, read-only Schedule state with the JSON-only
command for the target runtime:

```sh
sporades schedules
sporades deploy schedules
sporades host schedules --host <alias> --subname <name>
```

These commands target an active Dev session, running local Container session,
or running Hosted Capsule. They return schedules ordered by name, including the
effective timezone, policy, next occurrence, and latest safe outcome and Job
correlation. They omit payloads and secrets, do not evaluate or advance a
Schedule, and return `schedules: []` when no schedules exist. V1 has no human
renderer, filters, pagination, or offline inspection.
