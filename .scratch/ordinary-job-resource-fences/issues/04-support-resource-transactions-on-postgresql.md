# 04 — Support resource transactions on PostgreSQL

**What to build:** A Capsule using PostgreSQL receives the same supported named-resource authority and recovery contract as SQLite, verified against a real local database with independently connected workers.

**Blocked by:** 02 — Run ordinary Jobs inside a resource transaction on SQLite.

**Status:** ready-for-agent

**Parent:** https://github.com/mgscox/sporades/issues/52

- [ ] Start the already-approved disposable local PostgreSQL Docker instance and configure the repository's dedicated PostgreSQL test harness. Do not accept a skipped PostgreSQL suite as validation.
- [ ] Acquire the runtime-owned resource row using PostgreSQL transaction locking before protected application work. Preserve the public API and exact Job-claim ownership rules.
- [ ] Run the shared resource-scope conformance scenarios with independent database connections and workers, including deterministic contention, rollback, process death, paused-owner resumption, connection termination, and recovery.
- [ ] Prove that stale owners cannot publish protected database changes or overwrite the newer Job attempt's lifecycle state, and that surviving workers can recover under the documented rule.
- [ ] Define bounded lock waiting and deadlock behavior. Do not transparently replay a callback that may already have initiated an external effect.
- [ ] Document PostgreSQL's locking granularity and the runtime's connection-serialization limits separately from SQLite's writer contention. Do not promise independent-resource throughput that the current connection model cannot provide.
- [ ] Update shared adapter conformance coverage, generated runtime artifacts, and canonical documentation together. Keep SQLite coverage green and record the actual PostgreSQL version and executed checks.

**Validation prerequisites:** Matt has explicitly approved spinning up a local Docker PostgreSQL instance for this work. Follow the shared test-environment instructions for the dedicated database. Install dependencies in this worktree with `npm ci`; tests will not pass with symlinked `node_modules`.
