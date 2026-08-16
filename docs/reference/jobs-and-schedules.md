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
uses a deterministic delay. `ctx.jobs.cancel(id)` cancels queued or delayed
work, or cooperatively requests cancellation of running work through its signal.

The lifecycle states are `delayed`, `queued`, `running`, `succeeded`, `failed`,
and `cancelled`. Only `queued` Jobs are ready to run; `delayed` Jobs wait until
their `availableAt` time. The initial runtime uses a single worker. A running
attempt holds a lease, and lease recovery after interruption may execute that
attempt again.

Job delivery is **at least once**, not exactly once: an interrupted leased
attempt can be recovered and run again under the same Job ID. Make handlers
duplicate-safe and use idempotency keys for caller retries.

`ctx.jobs.get(id)` reads one known Job. `ctx.jobs.list(...)` supports bounded,
cursor-based listing by actor. Current-user inspection sees only Jobs for its
captured execution actor. Privileged inspection through an explicit
`ctx.privileged.run(...)` may see all Jobs. In either view, `enqueuedBy` is
provenance—the user who caused the Job to be created—and is distinct from the
captured current-user or Privileged server role actor under which the handler
executes.

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
an async-capable payload factory evaluated for each occurrence. Payload
factories may run more than once during crash recovery, so any explicitly
privileged side effects must tolerate repetition. `retry` is the ordinary Job
Queue retry policy applied after enqueue; a failed payload factory is skipped
and is not retried as a Job.

The default missed-run policy is `skip`, which resumes at the next future
occurrence after downtime. `latest` enqueues at most the most recent missed
occurrence, then resumes normal recurrence; it never replays an unbounded
backlog. Schedule state and pending occurrences survive runtime restarts through
the configured Database adapter. A deterministic identity based on Capsule,
Schedule name, and scheduled UTC instant prevents overlapping starts or crash
recovery from creating duplicate Jobs for one occurrence.

Changing an expression, timezone, payload, retry policy, or enabled state affects
future occurrences only and does not rewrite historical Jobs. Removing a
Schedule forgets its runtime state while retaining its Jobs; adding the same name
again or renaming a Schedule creates a fresh identity. Disabling or cancelling a
created Job does not disable its Schedule.

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
