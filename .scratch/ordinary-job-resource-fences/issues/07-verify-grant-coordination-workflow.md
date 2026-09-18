# 07 — Verify the amended Grant workflow and map remaining original gaps

**What to build:** Validate the complete reference Capsule against explicitly approved M1, preserving a visible mapping of original #52 guarantees that were dropped.

**Blocked by:** 03, 04, 05, 06.

**Status:** blocked — implementation-dependencies

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [ ] Verify the linked maintainer M1 approval before execution. Map each original parent criterion to unchanged, amended, or unmet; never mark strict stale-SMTP prevention or authority-through-SMTP-completion proved by intent acceptance.
- [ ] Exercise exchange, rotation, revocation, legacy migration and notification preparation against the same existing Grant anchor with historical execution actor, current ACL/Team checks and post-acquisition reads.
- [ ] Prove both intent-before-revocation and revocation-before-intent schedules with deterministic independent workers and no partial DB state. Demonstrate that committed intent can still send later and that current Grant checks reject use of revoked links; distinguish message disclosure from link-use authorization.
- [ ] Kill/restart an owner, separately pause/resume it after connection loss/takeover, and verify DB/intent rejection. Exercise scope success then handler failure/retry, current-actor receipt access, cancellation ordering, expiry, shutdown and unknown commit recovery through the Capsule API.
- [ ] Exercise delivery acknowledgement loss and not-accepted twin, crash before send, durable automatic retry of unknown/transient outcomes, duplicate acceptance after lost reply, restart-preserved backoff, permanent rejection visibility, and monotonic late acknowledgement. Do not count a durable intent as receiver acceptance.
- [ ] Run real independent SQLite and approved local Docker PostgreSQL scenarios plus libSQL fail-closed behavior. Record exact engines/counts and distinguish source checks, process evidence and actual controlled receiver observations.
- [ ] Run typechecking, full existing suite, docs checks, generated-artifact validation and real PostgreSQL checks with real worktree-installed dependencies. Existing non-opt-in behavior must stay green; do not weaken/delete/skip tests.
- [ ] Publish a walkthrough and redacted evidence with the accepted amendment and remaining limits. Do not modify or close #52 automatically.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Ticket 02 handoff

02 has SQLite ordinary-Job receipts and process-lock evidence only. Its mutation/endpoint and notification surfaces remain fail closed until 03/06. Verify completed surfaces and adapters independently; do not label reserved signatures or SQLite-only evidence as complete workflow conformance.
