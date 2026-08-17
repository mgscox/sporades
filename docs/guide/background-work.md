# Jobs and Schedules

Jobs are durable server-only work. Schedules create ordinary Privileged Jobs at
declared times; they do not introduce a second execution system.

Declare a named `job()` when work must outlive the request that created it.
Enqueue as the captured current user when later ACL checks should retain that
identity; use the Privileged server role only for system-owned work. Handlers
must tolerate duplicate execution because delivery is at least once.

Declare `schedule()` only for recurrence. Pin an IANA timezone when wall-clock
meaning must remain consistent across Dev, Container, and Hosted environments.
Schedules enqueue Jobs; retry and execution semantics remain Job Queue semantics.
Dynamic Schedule payload factories should declare `payloadVersion`; bump it
whenever factory code or captured configuration changes, because closure state
cannot be derived from JavaScript source text. The field is optional only for
compatibility with v0.8.5 declarations, whose factory source text remains their
weaker identity. Static JSON payloads are fingerprinted directly.
Occurrence claim ownership, deterministic enqueue, terminal occurrence state,
and latest Schedule summary are committed together under the live Schedule
incarnation token. Each successful runtime publication rotates that token; the
enabled durable incarnation is the authority during
claim and recovery. Payload factories may be evaluated again after claim
recovery, but a stale evaluator leaves replacement-owned pending work untouched
and cannot persist a Job or overwrite a replacement generation's cursor or
winning outcome. A runtime that loses this generation check stops re-arming its
stale local Schedule. Declaration reconciliation and ownership publication are
one transaction and occur only after a candidate can validate retained recovery
state and preflight timer capability, so a failed
candidate leaves the previous scheduler functional. Shutdown removes queued factories before they can acquire
an evaluation slot. Changing, disabling, or removing a Schedule terminally
supersedes its own pending occurrences; later reuse starts with the next future
occurrence instead of resurrecting old work. During upgrade, legacy pending
occurrences inherit their matching pre-reconciliation durable identity before a
compatible runtime publication transfers them. Actual occurrence and recovery
timers are armed only after their owning transaction commits, including recovery
wakes discovered by a losing retained-state compare-and-set. Sporades keeps
a durable legacy-adoption lineage: only an uninterrupted same-definition v0.8.5
upgrade remains open, while change, disablement, removal, or later restoration
closes adoption permanently. While a lineage is open, a tracked once-per-second
indexed scan checks at most 100 wholly legacy rows written after startup;
shutdown cancels the scan. Reconciliation, claim, and finalization lock the Schedule row
before its occurrence rows so PostgreSQL races cannot invert the lock order.

One-time `availableAt` values and retry instants stay within canonical
four-digit UTC timestamps. Supply availability as a timestamp string or `Date`;
coercible scalar values, invalid dates, and extended-year values are rejected;
invalid retained timing state fails safely during recovery and is revalidated
before worker claim. The same canonical timestamp rule applies to retained
Schedule occurrence and claim-expiry state; malformed values become the opaque
terminal `SCHEDULE_OCCURRENCE_INVALID` outcome rather than a stranded pending
occurrence. The runtime validates the retained id, Schedule name, and scheduled
instant together and skips a malformed unique-key occupant without failing
startup or spinning its timer. Every retained or freshly calculated Schedule
`nextOccurrence` cursor is also canonical; malformed retained state or a
startup calculation outside the four-digit UTC domain fails startup with
`SCHEDULE_STATE_INVALID` before persistence or a live timer is armed. An active
enabled Schedule has a cursor, an exhausted enabled Schedule has none, and a
disabled Schedule is non-exhausted with no cursor; startup and inspection reject
all inconsistent retained combinations before writes or timers.
If an already-due occurrence is the final representable instant, its Job or
bounded failure outcome commits with the latest Schedule summary and future
scheduling becomes durably exhausted. Inspection reports `enabled: true` and
`nextOccurrence: null`; restart does not re-arm a timer. If restart discovers
that final cursor already due, `latest` recovers it before exhaustion while
`skip` exhausts without enqueueing. A late final occurrence
and its single-attempt Job clamp their claim leases to the remaining canonical
domain; a retry policy requiring later attempts becomes the bounded enqueue
failure.
Inspection applies the same domain to the next cursor and latest occurrence.
Availability and retry
instants leave room for the runtime claim lease, and retry objects contain only `maxAttempts` and
optional `delayMs`. A missing captured user is also terminal rather than
retryable.

Read the
[Job Queue and Schedule walkthrough](../reference/jobs-and-schedules.md#current-user-jobs),
then use the
[actor-selection guidance](../reference/server-runtime.md#choosing-a-server-actor)
to choose a captured current user or the Privileged server role.

Use `sporades jobs` and `sporades schedules` for bounded JSON inspection of an active Dev session; equivalent `deploy` and `host` commands inspect other environments.
