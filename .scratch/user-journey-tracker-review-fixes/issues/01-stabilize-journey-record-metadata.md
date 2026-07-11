# 01 — Stabilize Journey Record Metadata

**What to build:** Make every public Journey record include a required
`metadata` field, using `null` when the publisher supplies no metadata, across
set results, lists, snapshots, changes, public types, and generated runtime
artifacts.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Parent

.scratch/user-journey-tracker-review-fixes/PRD.md

- [ ] A regression test first proves a Journey published without metadata still
  returns and broadcasts a complete record containing `metadata: null`.
- [ ] Set results, list snapshots, subscription snapshots, and realtime changes
  always include the required `metadata` field.
- [ ] Explicit JSON-safe metadata objects remain unchanged.
- [ ] Public client types require `metadata` and represent its absent value as
  `null`.
- [ ] Source and generated runtime artifacts remain aligned.
- [ ] Focused runtime, client, and type tests pass.

