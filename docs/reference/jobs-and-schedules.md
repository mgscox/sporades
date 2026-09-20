# Jobs and Schedules Reference

Durable background work, Schedule declarations, runtime behavior, and CLI inspection.

[Back to the feature reference index](../guide/reference.md).

## Current-user Jobs

Declare durable server-only work with `job()` and enqueue it from a trusted
mutation, Custom endpoint, or App message handler through `ctx.jobs`. Enqueue
captures the current Sporades user and whether that user entered through a
Session or a named Access key. The runtime persists only the bounded `AuthContext` and
`CredentialProvenance`; it never stores a bearer token, selector, verifier,
grants, or matched scopes in the Job row.

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

Retries, restart recovery, and child Jobs rehydrate the exact committed,
bounded Auth and Credential snapshot. Service actors retain the explicit
`userKind: "service"` discriminator, so durable execution and audit policy never
reinterpret a headless actor as a legacy human. Older snapshots without the
discriminator remain the backwards-compatible human/Anonymous shape. At capture, profile display metadata
that predates the Job storage bounds is deterministically shortened or omitted;
authority-bearing user and provider identity remains exact. Later profile
edits, Access-key rotation, revocation or deletion, unlinking, owner deletion,
and reuse of the same key name do not rewrite or cancel already-admitted work.
This historical identity is attribution, not restored authority: Table and
File ACLs and Team operations still evaluate current rows, resources,
membership, and roles when the Job runs.

Databases created before Credential provenance receive a deterministic Session
snapshot at startup. Migration uses the retained actor provider and a bounded
capture of the current user profile when one exists; an absent legacy profile
falls back to the bounded `Job enqueuer` display name, null email and picture,
and guest/auth flags derived from the retained provider. The fallback does not
invent an Access key.

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
initialization, but Job dispatch and recovery wakes remain stopped until the
Capsule `init()` hook, retained Schedule validation, declaration reconciliation,
and timer capability gates all succeed. A Job durably enqueued by `init()` does
not dispatch before that boundary. Failed initialization unwinds and awaits all
Job and Schedule runtime work; a later successful open recovers retained Jobs.
Long `availableAt` and retry waits are
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
Durable queued and delayed Job state remains stored and recovers on runtime
restart.

### Reserved Stripe Event payload retention

The runtime-owned `_sporades.stripe-event` Job retains the complete frozen
Verified Stripe event only while delivery is unresolved and for a fixed 30-day
period after successful settlement. Its deadline starts at the successful
Job's durable `completedAt`. If the exact deadline cannot be represented in the
canonical four-digit timestamp range, retention remains explicitly unresolved
rather than expiring early. Safe Job inspection reports
`RETENTION_DEADLINE_UNREPRESENTABLE` for that exception without exposing provider
data. At a representable deadline, bounded runtime maintenance
replaces the payload with a non-sensitive marker and clears its result. The
successful Job row and digest-only idempotency key remain, so callback replay
still returns the same terminal Job and never re-executes the consequence.

Queued, delayed, running, failed (including exhausted attempts), and cancelled
Stripe Event Jobs are unresolved exceptions and are not age-redacted. This
preserves retry and repair evidence rather than silently turning an unresolved
provider delivery into apparent success. Resolve that lifecycle before treating
the provider data as settled. Sporades exposes no generic Job-payload read,
delete, or status-rewrite API.

A legacy successful Stripe Event Job with an absent or noncanonical
`completedAt` is also unresolved: its raw payload remains retained with no
deadline. Operator Job inspection reports `payloadRetention.state` as
`unresolved`, code `INVALID_COMPLETED_AT`, and `deadline: null`; it never reveals
the payload or provider identity. Sporades intentionally exposes no generic Job
editor. If a supported storage recovery or migration restores a canonical
`completedAt`, the next cleanup pass reselects the row and derives the ordinary
30-day deadline. Exact compare-and-set classification cannot overwrite a
concurrent repair. Between the canonical repair and that cleanup pass, safe
inspection reports `CANONICAL_REPAIR_PENDING`; still-malformed sentinel rows
remain `INVALID_COMPLETED_AT` and receive one bounded periodic safety scan every
24 hours rather than repeatedly re-arming cleanup.

Cleanup runs at runtime activation, after restart, and at the next deadline. It
performs at most 100 successful row mutations in total per invocation. It
redacts already-due rows first, then spends only the remaining shared budget
assigning or classifying legacy deadlines. Further restart-safe passes drain a
larger mixed backlog. Exact terminal-state/deadline/lease
compare-and-set guards, so overlapping runtimes are restart-safe and cannot
redact pending work. Successful cleanup emits no log. Failures expose only a
bounded runtime error code—never a Job ID, provider Event ID, object ID,
idempotency key, or payload value. Routine Job and Schedule inspection continues
to omit payloads and idempotency-key values.

Repair discovery reads at most 101 sentinel rows per page. A durable opaque
Job-row keyset cursor advances across rejected impossible dates without using
dialect-specific date parsing; cursor writes do not consume the 100-Job-mutation
budget. Non-final pages re-arm immediately, the cursor survives restart, and
compare-and-set advancement lets concurrent cleaners converge. Completing a
fully malformed cycle resets the cursor and stores a durable 24-hour safety
deadline rather than hot-looping. A canonical repair made behind the cursor or
after wrap is therefore detected within 24 hours plus the time needed to drain
bounded 100-row pages ahead of it. Restart before that deadline does not scan
early. The maintenance state stores only the opaque cursor and safety deadline,
never provider identity, idempotency value, or payload data.

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
closing its only usable replacement. Candidate viability initialization keeps
its Job recovery and dispatch stopped. The Job activation timer is preflighted
before prior-runtime teardown without dispatching a handler. If activation
scheduling degrades after teardown, Dev still promotes the request-capable
candidate and records a bounded `dev.runtime.job_activation_degraded` warning
instead of retaining the closed prior runtime. After prior-runtime teardown
settles, successful or not, the promoted candidate activates and refreshes tracked
running-lease recovery before another Job worker pass. Lease recovery is single-flight: a
refresh requested during an active scan runs afterward at the earliest requested
instant, and shutdown awaits that complete chain. A claim acquired after the
candidate's startup scan, retained by failed teardown, relinquished, or delayed
during handoff therefore cannot wait indefinitely for an unrelated enqueue or
restart.
Runtime close independently attempts mail,
Database adapter, and file-storage closure; if more than one fails, it reports
the failures together after every closer has been attempted. If worker
settlement or the Capsule shutdown hook fails alongside mail closure, shutdown
preserves and reports both failures.

`ctx.jobs.get(id)` reads one known Job. `ctx.jobs.list(...)` supports bounded,
cursor-based listing by actor. Current-user inspection sees only Jobs for its
captured execution actor. Privileged inspection through an explicit
`ctx.privileged.run(...)` may see all Jobs. In either view, `enqueuedBy` is
provenance—the user and Session-or-Access-key credential that caused the Job
to be created—and is distinct from the
captured current-user or Privileged server role actor under which the handler
executes. Owner deletion does not erase or prevent execution of the bounded
historical snapshot, but it can make current resource and membership checks
deny the work.

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
an async-capable payload factory evaluated for each occurrence. A factory can
declare a stable `payloadVersion` string of 1 through 128 characters:

```ts
payloadVersion: "weekday-digest-v2",
payload: async (occurrence, ctx) => ({ generatedFor: occurrence.scheduledFor }),
```

Treat `payloadVersion` as the identity of both the factory code and every value
it captures; bump it whenever either changes. It is optional for compatibility
with v0.8.5 declarations. Without it, Sporades preserves the legacy
`String(payload)` fingerprint, which cannot reveal closure state and therefore
cannot detect captured configuration changes.
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
occurrence also carries its Schedule definition fingerprint and a distinct
per-publication incarnation token. The runtime rechecks claim ownership and the
live enabled durable incarnation inside the
write transaction: deterministic Job enqueue, occurrence terminal state, and
the Schedule's latest-occurrence summary commit together. Claim and recovery
use that durable incarnation as generation authority. Every successful runtime
publication rotates the token, including same-definition restarts, so an older
runtime cannot regain authority after A-B-A replacement, removal and re-addition,
or disable and re-enable. A stale runtime therefore
leaves replacement-owned pending work untouched, cannot enqueue or overwrite
the replacement generation's cursor or durable outcome, and stops re-arming its
local copy of the Schedule. The complete declaration set and its new incarnations
publish in one Database transaction only after candidate recovery validation and
timer capability preflight succeed. Live occurrence and recovery timers are
armed only after that transaction commits, so their callbacks do not retain its
transaction ownership. A
failed candidate rolls back that publication and leaves the live scheduler
authoritative. Compatible pending work is transferred during a same-definition
restart only after reconciliation locks and rotates the durable Schedule row, so
an overlapping outgoing claim cannot insert between the transfer scan and the
new incarnation. Reconciliation, claim, and finalization consistently lock the
Schedule row before occurrence rows. Legacy rows are first backfilled from the
pre-reconciliation durable Schedule. A one-time migration records durable
adoption lineage only for genuine v0.8.5 rows. An uninterrupted matching enabled
definition keeps that lineage open; change, disablement, removal, or restoration
closes it irreversibly, including across later same-definition restarts. While
one is open, a tracked discovery timer uses an indexed scan of at most 100
wholly legacy pending rows once per second, allowing rows written after startup by an overlapping
v0.8.5 runtime to be adopted without a hot scan. Shutdown cancels the timer and
awaits an active batch. Closed lineages are never transferred or adopted.
Long waits for the next occurrence are re-armed in bounded native-timer chunks.
Every wake rechecks the current instant before persisting an occurrence, so
monthly, annual, and other distant recurrences cannot be overflow-clamped into
an immediate occurrence by the host timer implementation. Recovery waits for a
retained pending occurrence claim use the same bounded, tracked chunks and
recheck the durable expiry before attempting reconciliation. A transient
recovery failure installs a bounded retry wake rather than abandoning the
pending occurrence, and runtime close waits for active occurrence recovery
before closing its Database adapter. A recovery wake discovered by a losing
retained-state compare-and-set is returned as a transaction result and armed
only after commit, so its callback can open a fresh transaction. Every
retained or freshly calculated Schedule `nextOccurrence` cursor must be a
canonical four-digit UTC timestamp. A malformed or coercible retained cursor,
or a startup calculation beyond that domain, fails startup with
`SCHEDULE_STATE_INVALID` before persistence or any live timer arms. Privileged
and operator inspection applies the same domain to the next cursor and latest
occurrence timestamp. Enabled, exhausted, and cursor state is also canonical:
an enabled active Schedule has a cursor, an enabled exhausted Schedule has no
cursor, and a disabled Schedule is non-exhausted with no cursor. Startup and
inspection reject every other combination before writes or timers. If an already-due occurrence
is the final representable instant, its Job or bounded failure outcome and
latest summary commit atomically and future scheduling becomes durably
exhausted. Inspection reports `enabled: true` with `nextOccurrence: null`;
restart does not re-arm a timer. When restart finds that final cursor already
due, `latest` recovers the occurrence and then exhausts the Schedule atomically;
`skip` exhausts it without enqueueing. A late final occurrence and its single-attempt
Job clamp their claim leases to the remaining canonical domain; a retry policy
requiring later attempts commits the bounded enqueue-failure outcome. Retained occurrence
instants and claim expiries must be canonical four-digit UTC timestamps;
malformed retained state
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
pending work. Legacy pending rows without a definition fingerprint are migrated
from a matching pre-reconciliation durable Schedule before publication; if no
matching enabled declaration remains, they are superseded safely. Disabling or cancelling
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

Reserved Stripe Event Jobs additionally include a non-sensitive
`payloadRetention` projection. `retained` includes the canonical deadline;
`redacted` includes the deadline and redaction time; and `unresolved` includes
an opaque reason code and an absent deadline. The unresolved codes are
`JOB_NOT_SUCCESSFULLY_SETTLED`, `RETENTION_DEADLINE_UNASSIGNED`, and
`INVALID_COMPLETED_AT`; a canonical settlement whose exact deadline is outside
the timestamp range uses `RETENTION_DEADLINE_UNREPRESENTABLE`, and a canonically
repaired classified row temporarily uses
`CANONICAL_REPAIR_PENDING`. None disclose provider values or make inspection a
repair API.

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

<a id="sqlite-resource-transactions-ticket-02"></a>

## SQLite and PostgreSQL resource transactions and notifications (tickets 03–06)

An ordinary SQLite or PostgreSQL Job can call the server-only `ctx.resources.run` once, as
its first application database or framework provider operation. It uses a
pre-existing app row as the authorization anchor:

```ts
return ctx.resources.run({
  resource: { table: "grants", id: payload.grantId },
  operationId: payload.operationId,
  input: payload,
}, async scope => {
  const current = await scope.db.grants.where("id", payload.grantId).get();
  // Validate the current business state, then use scope.db and scope.jobs.enqueue.
  return { found: current !== null };
});
```

The resource identity is the retained Capsule database plus the exact declared
table name and row ID. Names/IDs are nonempty, well-formed UTF-8 strings up to
128 bytes. Input and result are canonical JSON up to 65,536 UTF-8 bytes each,
with at most 64 levels of nesting; object keys are sorted and negative zero is
zero. Cycles, sparse arrays, getters, symbols, nonfinite numbers, undefined and
non-plain objects are rejected. No actor, token or lease options are accepted.

A dedicated SQLite `BEGIN IMMEDIATE`, with zero busy timeout, holds writer
authority through commit/rollback. SQLite excludes **all writers in that database**;
there is no per-resource parallel-throughput or fairness promise. Contention
returns `{ code: "RESOURCE_BUSY", retryable: true }` on an Error with the fixed
message `Resource transaction is busy.` No callback runs on acquisition failure.
Use ordinary Job retry/backoff; the runtime never secretly reruns the callback.
Acquisition also returns immediate busy when this runtime already has an active
or queued root transaction. In the reverse order, ordinary root operations queue
behind an acquired resource transaction. Resource acquisition itself never queues.

Anchor read/update ACLs and each operation's ACL/Team checks run inside that
transaction under the captured Job actor. Previously captured parent DB handles
cannot reenter the root connection. The scope exposes DB operations, Job enqueue,
`signal`, bounded payload-free `log.info/warn/error`, and durable notification
surface. Logs buffer at most 100 severity events; arguments are deliberately not
recorded. Detached admitted DB/ACL work drains before commit; escaped scoped
handles reject `RESOURCE_SCOPE_INACTIVE`. Nested resource/Privileged entry,
Files, provider calls, messages and lifecycle transitions are unsupported.
Arbitrary JavaScript I/O and independently imported provider clients cannot be
sandboxed or detected by this API; they must not be used in a scope.

After a valid resource entry attempt, including busy, deadline or lost-claim
failure, the parent context's DB and provider capabilities remain unavailable for
the rest of that Job invocation. Parent `ctx.log` is available again after the
attempt settles, so handlers can report outcomes; during the scope use only its
transactional `scope.log`. `run` and `status` both consume the invocation's one entry.
There is no fallback to ordinary DB work after a failed acquisition. A rejected
admitted DB/ACL operation poisons the transaction even if the callback catches its
error. An invalid `scope.notifications.accept` attempt is tracked and also
poisons the transaction, including when its rejection is caught or not awaited.
The 101st scope log call throws `RESOURCE_INVALID_INPUT`; log arguments are
never retained. Scope ACL denial diagnostics are suppressed rather than written
outside the owning transaction; callers still receive the opaque authorization
error, and ordinary Job failure reporting remains available.

The exact running Job ID, claim token, stored deadline and cancellation marker
are checked at entry and immediately before COMMIT. The original 30,000ms lease
is never renewed. Entry and new DB work require more than 1,000ms remaining;
that reserve is for draining and commit admission, not a maximum OS pause.
A stopped process retains its SQLite lock beyond the deadline. Only actual
engine commit/rollback or connection/process death releases authority. Graceful
shutdown aborts and rolls back an unsettled scope; a watchdog revokes its DB
capabilities before requesting rollback. A commit already admitted may finish
past the deadline while still holding engine authority.

Application writes, child Jobs and the operation receipt commit together.
`sporades_resource_receipts` is created lazily on first opt-in and uses primary
key `(resourceTable, resourceId, operationId)` within the database. It stores
SHA-256 input and actor-binding digests, canonical result JSON, intent-ID JSON,
and `committedAt`. The actor digest binds the complete captured
Auth/Credential snapshot and Privileged mode. Receipts are also the v1 replay
tombstones and are retained indefinitely; SQLite needs no separate lock row or
durable resource lease. The `sporades_resource_` and `sporades_notification_`
table namespaces are reserved.

A same-bound retry reauthorizes and returns the recorded result without invoking
the callback. Changed input or actor returns `RESOURCE_OPERATION_CONFLICT`.
Failure later in the Job does not undo a committed scope. On
`RESOURCE_COMMIT_UNKNOWN`, retry the same binding: only a receipt read **after
reacquisition** can reconcile the outcome. `ctx.resources.status({resource,
operationId})` consumes the same first/once entry and returns either
`{state: "absent"}` or `{state: "committed", result, intentIds, intents}` under
current anchor authorization and actor binding. Each intent includes aggregate
and per-recipient delivery state. Absence after acquisition rules out an
older transaction still committing.
If post-commit child-dispatch or JSONL publication fails, the scope reports the
redacted `RESOURCE_STORAGE_ERROR` without running rollback hooks. Its receipt,
application writes, child Jobs and indexed log events remain committed. Retry
with the same binding or use a new invocation's `status` to reconcile; a failed
JSONL copy is not rolled back or guaranteed to be republished.

Other fixed resource errors are `RESOURCE_INVALID_INPUT`,
`RESOURCE_CONTEXT_UNSUPPORTED`, `RESOURCE_ADAPTER_UNSUPPORTED`,
`RESOURCE_EFFECT_UNSUPPORTED`, `RESOURCE_DEADLINE_EXCEEDED`,
`RESOURCE_CLAIM_LOST`, `RESOURCE_SCOPE_INACTIVE`, `RESOURCE_COMMIT_UNKNOWN`, and
`RESOURCE_STORAGE_ERROR`. They omit caller values. PostgreSQL constraint,
connection, and other storage failures before COMMIT, including tracked
mutation/endpoint scoped Database operations and runtime-owned receipt
statements, use the fixed `RESOURCE_STORAGE_ERROR` code and message without
SQLSTATE, constraint, or engine metadata. The tracked operation promise itself
rejects with this fixed error, so awaiting and catching it inside the resource
callback cannot inspect engine metadata; detached failures remain drained and
poison outer settlement. An error deliberately thrown by the
resource callback remains that callback error, including when its `code` happens
to resemble a SQLSTATE. Cancellation keeps the existing Job cancellation
outcome; authorization keeps opaque ACL errors.

This slice supports ordinary Jobs, including the existing audited Privileged
Job path, plus Custom mutations and Custom endpoints on file-backed SQLite.
Mutations/endpoints may call once as their first application database operation;
they join the enclosing transaction, hold its SQLite writer authority after the
scope callback returns, and return provisional data which becomes visible only
when the outer transaction commits. An outer rollback removes the receipt and
protected writes. Their outer transaction receives the same 30-second budget and
one-second admission reserve as an ordinary Job claim, including an adapter-owned
check at the actual commit decision. A lost outer COMMIT acknowledgement reports
`RESOURCE_COMMIT_UNKNOWN`, invalidates the scoped handles, and is reconciled only
by a later authorized receipt read; it is never reported as rollback. Resource
log index events and their bounded payload-free JSONL copies publish only after a
known outer commit, so an unknown outcome intentionally has no JSONL publication
claim. PostgreSQL Jobs and outer scopes first verify the exact ordered resource
lock and receipt columns, text types, nullability, absence of extras, primary
keys, ordinary permanent-table identity without partitioning or inheritance,
and absence of every index except the primary-key backing index. The readiness query uses a separate bootstrap connection so it remains
independent of any root transaction awaiting rollback. A missing or folded legacy schema is published by a separate
short transaction whose transaction-scoped advisory guard remains held through
its commit; initialized scopes take no bootstrap guard and lock the same
`FOR UPDATE NOWAIT` resource row in their respective transaction. They then
lock the authorization anchor before evaluating its current ACL and retain both
locks through settlement. A PostgreSQL COMMIT acknowledgement loss discards that
connection before the later receipt lookup reconnects. PostgreSQL lock contention
aborts its transaction, so a mutation or endpoint cannot catch `RESOURCE_BUSY`
and still settle successfully: the outer transaction is poisoned, rolls back,
and reports the same bounded error. This also rolls back runtime-owned work which
preceded resource entry, such as reauthentication-proof consumption. libSQL fails closed
before callback execution; its ticket is 05.

`scope.notifications.accept({id, to, subject, text, html?})` validates one to
100 existing-mail-compatible ASCII recipient addresses, a 1–128-byte ID, a
subject, at least one nonempty text or HTML body, and canonical notification JSON
of at most 65,536 bytes. It uses only the configured sender and SMTP authority.
It returns `{id, state: "staged"}`: no SMTP socket opens in the resource
transaction. Identity is `(resource, operationId, notification id)`. The same
canonical payload deduplicates; changing it returns
`RESOURCE_OPERATION_CONFLICT`. The receipt, protected writes, immutable intent,
and recipient rows commit atomically; outer rollback removes all of them.

After commit, an independent runtime worker durably scans accepted recipients.
Each attempt first commits a random reservation token, sequence, and 30-second
deadline, then submits exactly one SMTP envelope for one recipient using the
intent's stable Message-ID. The transport does not auto-retry. Recipient states
are `accepted`, `submitting`, `unknown`, `retry-wait`, `acknowledged`, or
`rejected`. A positive final DATA reply acknowledges SMTP submission, not inbox
delivery. Definitive 5xx or invalid configuration/address failures remain
rejected for operator correction. 4xx, timeout, connection loss, lost reply,
crashed sender, or failed outcome persistence remain uncertain and retry on the
runtime-owned schedule. Expired reservations become unknown and wait
`min(30s * 2^(min(attempt - 1, 7)), 1h)`; persisted backoff has no finite attempt
cutoff. Restart scanning preserves attempts and due times and does not depend on
a volatile post-commit wakeup.

A positive report from any recorded attempt token is monotonic and suppresses
future reservations. Token-conditional negative updates cannot regress it.
Reservation expiry cannot revoke SMTP bytes already in flight, so a late old
sender and a retry may both be accepted. Source Job retry, cancellation,
exhaustion, or later resource/Grant revocation never retracts a committed intent;
an accepted intent may therefore send after revocation. Uncertainty and crashes
are retried automatically, and duplicate receiver acceptance is possible. This
is neither exactly-once delivery nor a promise of unconditional eventual
delivery. Diagnostics retain only bounded attempt timing and outcome categories,
never credentials, raw SMTP replies, recipients, subjects, or bodies. Ordinary Jobs that never opt in retain
their existing nontransactional behavior. See
[ADR-0054](../adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md).

A cancellation or recovery writer on an independent SQLite connection may receive
SQLite busy and must retry after engine release. The existing same-runtime gate
queues independent root work behind an acquired resource; resource acquisition
against an already-busy gate instead rejects immediately. "Wait for release" is an ordering guarantee, not
transparent callback replay: cancellation cannot commit its marker while the
resource writer holds the engine, and a later cancellation cannot undo its receipt.
