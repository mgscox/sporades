# 07 — Verify the complete Grant coordination workflow

**What to build:** An executable reference Capsule scenario demonstrates that exchange, rotation, revocation, legacy migration, and notification handoff coordinate one Customer Access Grant through the supported resource contract, with evidence that maps directly to issue #52.

**Blocked by:** 03 — Coordinate Jobs with mutations and endpoints; 04 — Support resource transactions on PostgreSQL; 05 — Define and enforce libSQL compatibility; 06 — Support the proven external handoff boundary.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Exercise all five operations against the same named resource, with authority-sensitive reads performed after acquisition and the expected current actor/resource authorization preserved.
- [ ] Demonstrate notification winning and authority change winning under controlled schedules. Prove one active owner, a clean waiting or rejected contender under the documented policy, and no interleaved partial database state.
- [ ] Kill a worker mid-run, restart against retained storage, and prove eventual recovery without a permanently stranded resource. Separately resume an old paused owner after takeover and verify both protected-write and external-handoff outcomes.
- [ ] Exercise retry, cancellation, lease recovery, shutdown, acknowledgement uncertainty, and an external acceptance followed by commit failure through the reference Capsule, not only internal unit seams.
- [ ] Run the supported scenarios on independent SQLite connections and the approved local Docker PostgreSQL instance. Verify libSQL's declared support or rejection behavior; label skipped or unavailable evidence explicitly.
- [ ] Record an acceptance matrix for every parent criterion, distinguishing database guarantees, external destination participation, proven process/receiver behavior, and any explicit approved amendment. An unmet original criterion remains visibly open.
- [ ] Run typechecking, the full existing test suite, documentation checks, generated-artifact validation, and the real PostgreSQL checks with actual worktree-installed dependencies. Existing Capsules that omit the API retain their behavior.
- [ ] Publish the reference walkthrough and bounded evidence without credentials, customer links, payload secrets, or unsupported claims of exactly-once SMTP delivery. Do not modify or close the parent issue automatically.

**Validation prerequisites:** Matt has approved spinning up a local Docker PostgreSQL instance; it is required for PostgreSQL evidence. Tests will not pass with symlinked `node_modules`; use a real dependency installation in the implementation worktree and verify it before running the suite.
