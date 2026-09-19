# 04 — Implement PostgreSQL resource transactions and receipt conformance

**What to build:** Implement the same amended transaction/receipt API on real PostgreSQL, including connection-loss and uncertain-commit behavior.

**Blocked by:** 02.

**Status:** complete

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [x] Start the approved disposable local PostgreSQL container using the dedicated harness. Record engine version and exact counts; skipped PostgreSQL checks do not establish support.
- [x] Use a dedicated READ COMMITTED connection, unique runtime resource row and FOR UPDATE NOWAIT, followed by exact Job row and authorization locks in ADR order. Bound initial row-creation conflicts with server lock timeout and return RESOURCE_BUSY; never wait indefinitely or replay a callback automatically.
- [x] Prove deterministic first-row creation contention and existing-row contention using independent workers/connections. Every protected read follows acquisition; document participation requirements, row-lock granularity and current connection serialization without promising independent-resource throughput.
- [x] Terminate only A backend after its final check, permit B to acquire, then resume A. Prove A cannot write, create a receipt or accept an intent via old, parent, retained or newly reconnected scoped handles. This is a DB assertion, not a claim about ordinary SMTP.
- [x] Prove process death/restart, live pause at expiry, cancellation/recovery row conflicts, rollback, exact claim settlement, and lost COMMIT response with authoritative receipt lookup after lock acquisition. Do not return a connection to the pool while its commit outcome is unresolved.
- [x] Run shared SQLite/PG conformance for receipt replay, input/actor conflicts, current ACL/Team authorization, deadline reserve and unknown commit. 06 adds delivery integration after these primitive tests; a fake is not PostgreSQL proof.
- [x] Ship adapter code, generated artifacts and canonical docs together; retain SQLite/non-opt-in compatibility tests.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Ticket 02 handoff

02 uses adapter.withResourceTransaction plus a synchronous SQLite precommit ownership check. PostgreSQL must provide its own asynchronous, dedicated-connection protocol; do not copy the synchronous check or treat SQLite process tests as PG evidence. Preserve the receipt binding and public error shapes.

## Completion evidence

The criterion-to-test map and review repair history are recorded in
[`../evidence/ticket04-index.md`](../evidence/ticket04-index.md). The final required
real-PostgreSQL four-file gate passed 187 tests with zero failures and zero skips.
