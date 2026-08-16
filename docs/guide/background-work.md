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

One-time `availableAt` values and retry instants stay within canonical
four-digit UTC timestamps. Supply availability as a timestamp string or `Date`;
coercible scalar values, invalid dates, and extended-year values are rejected;
invalid retained timing state fails safely during recovery and is revalidated
before worker claim. Availability and retry instants leave room for the runtime
claim lease, and retry objects contain only `maxAttempts` and optional
`delayMs`. A missing captured user is also terminal rather than retryable.

Read the
[Job Queue and Schedule walkthrough](../reference/jobs-and-schedules.md#current-user-jobs),
then use the
[actor-selection guidance](../reference/server-runtime.md#choosing-a-server-actor)
to choose a captured current user or the Privileged server role.

Use `sporades jobs` and `sporades schedules` for bounded JSON inspection of an active Dev session; equivalent `deploy` and `host` commands inspect other environments.
