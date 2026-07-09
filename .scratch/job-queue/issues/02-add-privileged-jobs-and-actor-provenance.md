# Add Privileged Jobs And Actor Provenance

Status: ready-for-agent

## Parent

.scratch/job-queue/PRD.md

## What to build

Extend the working current-user queue path with explicit system-owned Jobs.
Keep `enqueuedBy` provenance separate from execution authority, run privileged
attempts through the implemented Privileged server role boundary, and let
Privileged server role context get or list every Job belonging to the Capsule.

## Acceptance criteria

- [ ] Trusted Capsule server code can explicitly enqueue a system-owned Job whose execution actor is the Privileged server role rather than a fake user or Session.
- [ ] Job state records bounded safe `enqueuedBy` provenance separately from the captured-user or Privileged server role execution actor.
- [ ] Every privileged Job attempt executes through `ctx.privileged.run(...)` and emits its mandatory `started`, `completed` or `errored`, and `finished` audit events.
- [ ] Privileged audit metadata includes bounded safe Job ID, handler, attempt number, operation, and correlation identity without payloads, credentials, Server env values, or raw errors.
- [ ] Privileged server role context can get and cursor-list all Jobs in its Capsule, while normal user context still sees only Jobs assigned to that captured user.
- [ ] Privileged get/list operations run through `ctx.privileged.run(...)` and emit the existing mandatory audit evidence.
- [ ] `enqueuedBy` never grants visibility, and unauthorized get behavior remains indistinguishable from an unknown Job ID.
- [ ] Browser/client code cannot enqueue, execute, inspect, or list Jobs with Privileged server role authority.
- [ ] If a captured user no longer exists when execution starts, the Job becomes terminally `failed` with bounded safe code `JOB_ACTOR_UNAVAILABLE`; no fallback actor is used.
- [ ] Captured-user Jobs evaluate current ACL policy at execution time rather than preserving an authorization snapshot from enqueue time.
- [ ] Tests cover current-user and privileged execution, actor provenance, ACL reevaluation, missing captured users, scoped listing, mandatory audit sequences, redaction, client non-exposure, and generated-runtime parity.

## Blocked by

- .scratch/job-queue/issues/01-run-and-inspect-current-user-jobs.md
