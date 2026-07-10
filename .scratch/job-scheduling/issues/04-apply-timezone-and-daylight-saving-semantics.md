# 04 — Apply Timezone And Daylight-Saving Semantics

**What to build:** Let each recurring Schedule use an explicit IANA timezone or the runtime server timezone by default, then calculate matching UTC occurrence instants from the effective local wall-clock fields with deterministic daylight-saving behavior.

**Blocked by:** 02 — Declare And Run A Static Recurring Privileged Job.

**Status:** ready-for-agent

- [ ] An explicit timezone must be a valid available IANA timezone; when omitted, Sporades uses the runtime server timezone resolved through Node `Intl` APIs.
- [ ] Schedule inspection exposes the effective timezone, and docs warn that Dev, Container, and Hosted server defaults may differ unless the author pins one.
- [ ] An omitted timezone is re-resolved on startup; a changed server timezone affects only future occurrences and causes no backfill.
- [ ] Cron day-of-month and day-of-week use documented conventional OR behavior when both fields are restricted.
- [ ] A local time that does not exist during a spring-forward transition creates no scheduled occurrence.
- [ ] Both distinct UTC instants matching a repeated fall-back local time are eligible occurrences with distinct identities.
- [ ] Documentation explains that these daylight-saving effects follow from choosing a local timezone and recommends `UTC` when invariant recurrence is required.
- [ ] Normal offsets, non-hour offsets, month boundaries, leap days, and known daylight-saving transitions are covered through the controllable full-runtime seam.
- [ ] Invalid cron or timezone input fails before schedule state or Jobs are committed.
- [ ] Source and generated runtime calculation behavior remains aligned.
