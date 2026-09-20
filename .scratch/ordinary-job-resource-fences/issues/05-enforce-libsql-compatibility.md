# 05 — Fail closed for libSQL in v1

**What to build:** Implement an explicit unsupported-adapter gate for the proposed resource API. The original optional libSQL support investigation is unnecessary in this implementation plan.

**Blocked by:** None.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

**Contract:** [ADR-0054 M1](../../../docs/adr/0054-ordinary-job-authority-does-not-fence-smtp-acceptance.md). Approved by Matt on 2026-09-18; see [approval record](../maintainer-approval.md). These criteria implement the explicit amendment, not the disproved original SMTP guarantee.

- [ ] Return RESOURCE_ADAPTER_UNSUPPORTED for run and status before callback, receipt lookup, application writes or network submission on every libSQL path, including remote and local libSQL configurations.
- [ ] Test callback non-execution, zero application/receipt/intent writes, stable redacted errors, and no fallback to mutex, autocommit, SQLite-like guesses or expiring claims.
- [ ] Keep existing non-opt-in libSQL Job behavior unchanged; test it separately from scope rejection.
- [ ] Publish explicit SQLite/PostgreSQL support and libSQL unsupported declarations consistently in types, generated behavior and canonical docs.
- [ ] Record that future libSQL support requires a separate approved proposal and real representative remote expiry/connection-loss/restart conformance. No fake service test or this rejection gate certifies support.

**Validation prerequisites:** Follow the shared plan: real worktree-installed dependencies via `npm ci`, never symlinked `node_modules`; approved disposable local PostgreSQL and dedicated test harness when PostgreSQL is tested.

## Ticket 02 handoff

02 gates resources.run/status on file-backed SQLite before callback execution. Verify this rejection through the real libSQL entry surface; do not replace it with a local mutex or an autocommit fallback.
