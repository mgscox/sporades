# 01 — Prove the external-side-effect contract

**What to build:** A deterministic experiment and recorded contract showing what a Capsule can safely promise when a Job coordinates database changes and an external side effect with another worker. Select a concrete implementable recovery and handoff design before downstream implementation begins.

**Blocked by:** None — can start immediately.

**Status:** experiment-complete; feasibility-gate-blocked

**Parent:** https://github.com/mgscox/sporades/issues/52

- [x] Use two independent workers/connections and a controlled SMTP receiver to observe database authority, callback execution, and external acceptance separately.
- [x] Pause worker A immediately before submission, including after its last ownership check; invalidate its database authority, allow worker B to acquire the resource, then resume A. Record whether A can still submit or mutate state.
- [x] Exercise process death, a live but paused process, database connection loss, lease expiry, restart, and an accepted message whose acknowledgement is lost. Do not conflate these failure modes.
- [x] Record a precise authority acquisition point, ownership-loss rule, recovery rule, external acceptance boundary, and retry/uncertainty policy. State whether the external destination must participate in fencing and what deployments can support that contract.
- [x] Compare the proposed transaction scope with a durable conditional-update protocol and explain the selected shape. Do not infer a conditional write guarantee from ordinary filtered table updates.
- [x] Capture the decision and relevant domain vocabulary in an ADR, respecting the existing distinction between database consequences and provider calls.
- [ ] Produce a concrete API and state-transition contract sufficient for tickets 02 and 06 to implement, including time bounds, operation eligibility, actor authorization, and escaped-capability behavior. Prototype code, if needed, remains clearly experimental and does not expose an unproven production promise.
- [ ] Clear this blocking edge only with a proven implementable design meeting the parent, or an explicitly approved contract amendment recorded with its rationale. If proof fails, record the unresolved requirement and keep dependent tickets blocked; do not silently substitute database-only fencing or close the parent.

**Validation prerequisites:** Follow the shared test-environment instructions. PostgreSQL experiments require the already-approved local Docker instance. Install dependencies in the worktree; symlinked `node_modules` cannot be used.

## Ticket 01 result — 2026-09-18

The deterministic experiment and ADR are complete, but the proposed external
contract is disproved for ordinary SMTP under recoverable ownership loss.
**The proof gate is not cleared. Tickets 02-07 remain blocked.** The two unchecked
items above are deliberate; no API satisfying the parent has been selected and no
contract amendment is approved. This negative result does not authorize weaker
acceptance criteria or a database-only substitute.

- Draft evidence PR: https://github.com/mgscox/sporades/pull/54 (head `38b6103b3830ac6293f620eee9677152c3c84b9e`).
- Evidence branch: `codex/issue-52-ticket01-external-contract`.
- ADR: `docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md`.
- Reproduction and raw observations: `experiments/issue52-external-contract/`.
- 16/16 deterministic scenarios passed (7 SQLite, 9 real PostgreSQL), 0 skipped.
  Independent worker/backend PIDs and explicit barriers distinguish database
  authority, callback continuation and SMTP acceptance.
- After A's final check, OS pause plus lease expiry or PostgreSQL connection loss
  allowed B to acquire; resumed A still reached SMTP acceptance. Guarded DB writes
  failed. Process death and fresh-process restart were separately exercised.
- Accepted-with-lost-reply and not-accepted yielded the same sender uncertainty;
  rollback did not retract acceptance, and retry accepted the same Message-ID twice.
- Existing scoped tests: 32 passed, 0 skipped with PostgreSQL enabled; documentation
  checks: 46 passed; typecheck passed; diff whitespace checks clean.
- The remaining contract requires a proven participating acceptance authority or
  proven old-owner/in-flight-effect quiescence before transfer, or an explicitly
  approved amendment. A final database check, AbortSignal, outbox, or SMTP proxy
  forwarding ordinary SMTP does not supply that proof.
- The ordinary Job claim is still fixed at 30 seconds without renewal. Acquisition,
  execution and draining must use the remaining original claim budget; no bounded
  watchdog makes an arbitrary pause or uncertain SMTP acceptance safe.
- Parent #52 and ticket files 02-07 are unchanged.
