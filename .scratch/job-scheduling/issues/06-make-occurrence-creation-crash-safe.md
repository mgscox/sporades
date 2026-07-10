# 06 — Make Occurrence Creation Crash-Safe And Duplicate-Resistant

**What to build:** Ensure repeated evaluation, overlapping runtime starts, and crashes on either side of Job creation converge on one durable Job identity for each scheduled UTC occurrence.

**Blocked by:** 05 — Recover Missed Runs And Reconcile Declarations.

Status: ready-for-agent

- [ ] Each occurrence has a deterministic identity derived from Capsule identity, schedule name, and scheduled UTC instant.
- [ ] Conditional persistent evaluation claims allow only one active evaluator for a due occurrence and expired claims recover safely.
- [ ] A crash after recording a pending occurrence but before enqueue eventually creates its Job.
- [ ] A crash after enqueue but before occurrence bookkeeping completes reuses the existing Job through an internal deterministic idempotency key.
- [ ] Overlapping runtime starts produce no more than one Job identity for the same occurrence.
- [ ] Occurrence deduplication does not change the Job Queue's at-least-once attempt contract.
- [ ] Scheduled enqueue records unspoofable `enqueuedBy` Schedule name and UTC `scheduledFor` provenance rather than inventing a user, Session, or privileged sentinel; execution remains separately the Privileged server role.
- [ ] Cancelling or retrying one occurrence's Job neither disables nor advances its recurring schedule.
- [ ] High-seam clock and restart tests cover each crash boundary without coupling to private SQL or scheduler-loop implementation.
