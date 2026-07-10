# 07 — Inspect Schedules And Correlate Their Jobs

**What to build:** Give trusted server code bounded schedule inspection through the Privileged server role and correlate each scheduled Job and privileged attempt with its originating schedule and occurrence.

Status: done

## Parent

.scratch/job-scheduling/PRD.md

## Blocked by

.scratch/job-scheduling/issues/06-make-occurrence-creation-crash-safe.md

- [ ] Privileged server context can get and list schedule summaries; ordinary current-user contexts have no schedule inspection authority.
- [ ] Each summary includes stable schedule name, normalized expression, timezone, missed-run policy, enabled state, next occurrence, and the latest occurrence summary.
- [ ] The latest occurrence summary includes `scheduledFor`, `enqueued` or `payload-failed`, plus the Job ID or bounded safe error code appropriate to that outcome.
- [ ] Explicitly disabled declarations remain visible with no next occurrence, while removed declarations are absent.
- [ ] Summaries omit payload contents, idempotency-key values, raw claims, secrets, and raw runtime-owned rows.
- [ ] Schedule lists are deterministically ordered by schedule name.
- [ ] Scheduled Job state identifies its schedule and UTC occurrence without changing ordinary Job visibility rules.
- [ ] Job inspection represents `enqueuedBy` as explicit user provenance or scheduler-owned Schedule name plus UTC `scheduledFor`, with no second Schedule field.
- [ ] Capsule enqueue callers cannot supply Schedule provenance, and provenance grants neither visibility nor execution authority.
- [ ] Schedule inspection exposes current summary state and the last associated Job ID only; historical execution remains available through correlated Job inspection.
- [ ] Privileged Job execution audit metadata includes bounded schedule and occurrence correlation.
- [ ] Merely inspecting schedule state does not evaluate schedules, create Jobs, or emit privileged execution events.
- [ ] Browser/client code cannot inspect, forge, or obtain scheduled-work authority.
