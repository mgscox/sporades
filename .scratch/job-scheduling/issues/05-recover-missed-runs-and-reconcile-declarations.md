# 05 — Recover Missed Runs And Reconcile Declarations

**What to build:** Persist schedule evaluation state across runtime restarts, apply bounded missed-run behavior, and reconcile deployed declaration changes without rewriting history or producing surprise backfills.

**Blocked by:** 03 — Add Dynamic Schedule Payload Factories; 04 — Apply Timezone And Daylight-Saving Semantics.

**Status:** ready-for-agent

- [ ] Schedule state survives Dev, local Container, and Hosted Capsule runtime restarts through the configured Database adapter.
- [ ] The default `skip` policy creates no Jobs for missed occurrences and resumes at the next future occurrence.
- [ ] The `latest` policy creates at most the most recent missed occurrence and then resumes normal recurrence.
- [ ] A recovered `latest` occurrence retains the most recent missed cron instant as its identity and payload-factory `scheduledFor`, rather than substituting startup time.
- [ ] Missed-run policy applies only during startup or recovery; a timer armed by a running scheduler still enqueues its intended occurrence when it fires late.
- [ ] No arbitrary grace period classifies ordinary event-loop or timer latency as missed work.
- [ ] Newly declared schedules begin at deployment/startup time and do not backfill time before the declaration existed.
- [ ] Changed expressions, timezones, payloads, retry policies, or missed-run policies affect future occurrences only.
- [ ] A declaration with `enabled: false` remains persisted and inspectable but creates no occurrences; re-enabling starts from that deployment without disabled-period backfill.
- [ ] Disabled declarations still require every valid field and existing Job handler needed when enabled; only occurrence and payload evaluation are suppressed.
- [ ] `enabled` defaults to `true`, and inspection always exposes the resolved boolean.
- [ ] Removing a declaration deletes its runtime Schedule state while existing Jobs retain historical schedule/occurrence metadata.
- [ ] Re-adding a removed map key or renaming a Schedule creates a fresh identity without remapping prior state or history.
- [ ] Disabling or removing a Schedule leaves already-enqueued Jobs untouched but aborts/discards active factories and abandons pending occurrences that have not produced a Job.
- [ ] SQLite, libSQL, and Postgres adapter tests cover persistence and reconciliation using existing conditional service seams.
