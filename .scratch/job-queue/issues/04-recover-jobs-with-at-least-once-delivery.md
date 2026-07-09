# Recover Jobs With At-Least-Once Delivery

Status: done

## Parent

.scratch/job-queue/PRD.md

## What to build

Make execution claims and restart recovery durable. Workers should claim Jobs
atomically with leases, recover expired running claims predictably, and expose
an explicit at-least-once delivery contract so Capsule handlers can be written
for duplicate-safe execution.

## Acceptance criteria

- [ ] A Capsule worker atomically claims one eligible Job at a time using a bounded lease, preventing two live workers from intentionally owning the same claim.
- [ ] The public contract explicitly guarantees at-least-once execution and does not promise exactly-once delivery.
- [ ] An expired running lease records the interrupted attempt as consumed, then moves the Job to `delayed` for another attempt or to terminal `failed` when attempts are exhausted.
- [ ] Queue startup recovers expired claims before selecting newly eligible work and preserves deterministic `availableAt`, then Job ID ordering.
- [ ] Dev session restarts preserve queued and delayed Jobs and recover expired running claims.
- [ ] Local Container sessions persist queue state in the existing runtime data location and recover eligible work after container restart.
- [ ] Hosted Capsules persist queue state in hosted runtime data and recover eligible work after release start or restart.
- [ ] Idempotency behavior remains stable across restart: the same Capsule, handler, execution actor, and retained idempotency key resolves to the existing Job.
- [ ] Recovery does not retry a Job whose handler is unavailable under a different handler or actor; it records a bounded safe failure outcome.
- [ ] Tests cover competing claims, lease expiry, crash-after-side-effect behavior, attempt consumption, retry exhaustion, Dev restart recovery, Container fake seams, Hosted helper/runtime seams, and generated-runtime parity.

## Blocked by

- .scratch/job-queue/issues/03-add-delays-retries-and-cancellation.md

## Comments

- Integrated by the Job Queue swarm as `9897c78`, `57c22a0`, `9cf771b`, `0ac7ec8`, `c932161`, and `3d58b91` after independent review accepted worker SHA `f9728983b2c47a3db2e8d7c41d499bcfe0e91b8e`.
- Integration checks: build plus lease/recovery and all prior queue suites passed. Existing runtime data paths cover Container/Hosted persistence; no narrow queue-specific fake seam exists without synthetic infrastructure.
