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
Occurrence claim ownership, deterministic enqueue, terminal occurrence state,
and latest Schedule summary are committed together under the live Schedule
definition fingerprint. Payload factories may be evaluated again after claim
recovery, but a stale evaluator cannot persist a Job or overwrite a replacement
generation's cursor or winning outcome. A runtime that loses this generation
check stops re-arming its stale local Schedule. Changing, disabling, or removing
a Schedule terminally supersedes its pending occurrences; later reuse starts
with the next future occurrence instead of resurrecting old work.

One-time `availableAt` values and retry instants stay within canonical
four-digit UTC timestamps. Supply availability as a timestamp string or `Date`;
coercible scalar values, invalid dates, and extended-year values are rejected;
invalid retained timing state fails safely during recovery and is revalidated
before worker claim. The same canonical timestamp rule applies to retained
Schedule occurrence and claim-expiry state; malformed values become the opaque
terminal `SCHEDULE_OCCURRENCE_INVALID` outcome rather than a stranded pending
occurrence. The runtime validates the retained id, Schedule name, and scheduled
instant together and skips a malformed unique-key occupant without failing
startup or spinning its timer. Availability and retry instants leave room for
the runtime claim lease, and retry objects contain only `maxAttempts` and
optional `delayMs`. A missing captured user is also terminal rather than
retryable.

Read the
[Job Queue and Schedule walkthrough](../reference/jobs-and-schedules.md#current-user-jobs),
then use the
[actor-selection guidance](../reference/server-runtime.md#choosing-a-server-actor)
to choose a captured current user or the Privileged server role.

Use `sporades jobs` and `sporades schedules` for bounded JSON inspection of an active Dev session; equivalent `deploy` and `host` commands inspect other environments.
