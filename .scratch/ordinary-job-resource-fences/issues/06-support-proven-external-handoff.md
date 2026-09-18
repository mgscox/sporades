# 06 — Accept durable notification intents and expose delivery uncertainty

**What to build:** Implement M1 intent acceptance in the resource transaction, then an independent SMTP delivery worker. The original strict external-handoff fence is unnecessary under M1 and remains unsolved.

**Blocked by:** 02, 04.

Integration against PostgreSQL also requires 04 before 07 can pass.

**Status:** blocked — implementation-dependencies

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [ ] Implement the exact scoped notifications.accept shape, size/address/permission validation and immutable (resource, operationId, notification id) identity. Same payload deduplicates; changed payload conflicts. Return staged only until the owning engine commit; commit receipt, writes and intent atomically.
- [ ] Prove no SMTP submission before commit and no surviving intent on rollback, in ordinary Jobs and outer mutation/endpoint transactions. Scan retained accepted intents after restart; do not depend on a volatile post-commit wakeup.
- [ ] Implement accepted -> submitting -> acknowledged/rejected/unknown -> retry-wait (for unknown/transient outcomes) per recipient, using a persisted attempt token committed before I/O, one envelope per recipient, runtime-owned durable retries, no hidden transport auto-retry, and token-conditional failure updates. Job retry/cancel and resource revocation never erase committed acceptance.
- [ ] Expose per-recipient outcomes and aggregate status per ADR. Recover expired 30-second delivery reservations and retry unknown/transient outcomes with persisted exponential backoff from 30 seconds capped at one hour, without finite exhaustion or deleting pending work. Distinguish this from source Job retries; source Job exhaustion never discards delivery work.
- [ ] Acknowledge monotonically on a positive report from any recorded attempt for the exact immutable recipient/intent; stale failures cannot replace newer state. Test late success suppresses future reservations, while already in-flight duplicates remain possible. Permanent rejection is retained for correction, not silently treated as success.
- [ ] With independent workers and a controlled receiver, prove deterministic intent acceptance races, replay after unknown DB commit, and crash before/after submitting commit. Pause a sender and show a later stale SMTP acceptance is possible and explicitly outside M1; do not label this strict-fence success.
- [ ] Prove accepted-with-lost-reply and no-acceptance twins retain unknown attempt history and both enter scheduled retry; DB persistence failure after final reply retains uncertainty and triggers scheduled retry with acknowledged duplicate risk. SMTP acknowledgement is not delivery. Test restart retains uncertainty, due time and attempt identity; receipt remains committed in every delivery outcome.
- [ ] Prove retry after lost acknowledgement can yield duplicate receiver acceptance, retry of the not-accepted twin succeeds, acknowledged recipients are not resent for another recipient failure, due-time/backoff survives restart, and stale failures cannot regress a late acknowledgement.
- [ ] Record that this new implementation conformance must be run when 06 is dispatched; do not rerun the historical ticket-01 experiment as part of this decision task.
- [ ] Ship types, generated behavior, bounded redacted diagnostics and docs stating possible post-revocation send, automatic retry after crash/uncertainty, possible duplicate acceptance, and no exactly-once or unconditional eventual-delivery promise. Do not claim original #52 is satisfied.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Ticket 02 handoff

02 reserves notifications.accept but always rejects RESOURCE_EFFECT_UNSUPPORTED. Receipts retain intentIdsJson as [] and are their own permanent replay tombstones. Add validated immutable intent staging atomically here; do not infer that reserved types are an implemented acceptance path.
