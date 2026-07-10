# 02 — Declare And Run A Static Recurring Privileged Job

**What to build:** Let Capsule server code declare a named enabled Schedule that binds a valid five-field cron expression and static JSON-safe payload to an existing Job handler, then enqueues one due Privileged Job for the Job Queue to manage and execute.

Status: ready-for-agent

## Parent

.scratch/job-scheduling/PRD.md

## Blocked by

.scratch/job-scheduling/issues/01-add-controllable-runtime-clock.md

- [ ] Capsule server code declares Schedules in a named map alongside named Jobs, using a server-only declaration whose map key is the stable Schedule identity.
- [ ] Schedule names begin with a letter and then allow letters, numbers, underscores, or hyphens, so integer-like object-key enumeration cannot change declaration order.
- [ ] Advancing the runtime clock to a matching minute creates one Job with stable Scheduled occurrence identity and executes it as the Privileged server role.
- [ ] A static payload is validated under Job Queue JSON limits; omitted `payload` enqueues JSON `null`.
- [ ] Schedules pass only ordinary Job Queue enqueue retry options and reuse existing Job lifecycle, retry, cancellation, lease, and at-least-once semantics.
- [ ] Scheduling does not change `job()`, Job handler behavior, Job execution, or Job Queue management; after enqueue, the Job is an ordinary Privileged Job.
- [ ] The Job receives exactly the declared payload, with no scheduling metadata injected into handler payload or context.
- [ ] Invalid Schedule names, duplicate declarations, missing handlers, invalid payloads, invalid retry options, and unsupported cron forms fail the entire Capsule startup before Schedule state changes.
- [ ] V1 accepts numeric five-field cron syntax with lists, ranges, and steps and rejects seconds, years, nicknames, and implementation-specific extensions.
- [ ] `enabled` defaults to `true`; a fully valid `enabled: false` declaration remains inspectable but creates no occurrences.
- [ ] Simultaneous Schedules begin occurrence processing in declaration order, but their Jobs receive no Schedule-specific execution priority or dependency after enqueue.
- [ ] Schedule declarations and authority are server-only and unavailable through `sporades/client`.
- [ ] Schedule evaluation begins only after successful `init()`, stops before `shutdown()`, and does not alter shutdown/recovery behavior for Jobs already enqueued.
- [ ] Generated runtime artifacts expose the same static declare-to-enqueue behavior as the source runtime.
