# Changes

## Unreleased

Changes since v0.8.5.

### 🚀 Features

- Let current Team members read exact accepted membership totals through the
  count-only `teams.countMembers(teamId)` API without directory access.
- Give audited Privileged server callbacks safe read-only Team inspections for
  exact member counts, bounded member pages, active Join-link metadata, and
  Join-link capability previews without current-user or mutation authority.
- Let Capsule tables declare single-field and composite unique constraints,
  use atomic `insertOrIgnore(...)` writes against an exact declared constraint,
  and add unique constraints through atomic additive schema migration.
- Persist `ctx.jobs.enqueue(...)` inside the mutation, App message, or Custom
  endpoint transaction so handler writes and Job creation commit or roll back
  together while worker dispatch begins only after commit.

### 🐛 Bug Fixes

- Serialize multi-statement Team inspections with Team lifecycle writers,
  including a post-lock Join-link capability re-read, so PostgreSQL
  `READ COMMITTED` callers never combine stale authorization and projections.
- Make orderly shutdown and Dev restart clear every Job worker wake, defer
  recovered execution until runtime initialization, and use attempt-scoped
  claim ownership so stale shutdown, recovery, completion, or cancellation
  work cannot mutate a newer attempt. Active handlers are aborted and settled
  before runtime resources close; transactional cancellation aborts only after
  commit even across middleware context replacement, the worker reconciles a
  cancellation committed during claim registration before entering the handler,
  shutdown that wins during pre-handler reconciliation relinquishes the exact
  claim without consuming an attempt, far-future and retry wakes use bounded
  native-timer chunks instead of overflow-clamped rescans,
  a commit during an active empty queue scan guarantees another worker pass,
  and shutdown alone cannot misclassify retained work as user-cancelled. Signal
  shutdown stops accepting and drains HTTP requests before runtime resources
  close. Every runtime resource closer is attempted even when another closer
  throws synchronously, with multiple failures reported together. Worker or
  shutdown-hook failures are preserved alongside mail-closure failures. Jobs
  reject coercible non-date values, invalid or extended-year availability, and
  retry delays outside the supported four-digit UTC time domain; retained
  invalid state fails safely at recovery and worker-claim boundaries
  instead of executing early or blocking restart. Claim leases remain in the
  same domain, and retry policies reject unsupported members. A missing
  captured Job actor is terminal even when retry attempts remain. Shutdown
  failures still close database resources, and when prior-runtime
  teardown fails after candidate initialization, Dev promotes that viable
  candidate instead of retaining a closed runtime or leaking both instances.
- Allocate additive-migration temporary table names without colliding with valid
  Capsule tables, preserving those tables on both successful and rolled-back
  SQLite, libSQL, and PostgreSQL migrations.
- Reject query argument array subclasses while continuing to accept arrays
  created in another JavaScript realm (2171b61).

## 0.8.5 - 2026-08-15

Changes since v0.8.1.

### 🚀 Features

- Add JSON-safe positional arguments to reactive Custom queries across the
  client transport and framework adapters (5b882f5).
- Add exact pagination and join admission (63f68a0).

### 🐛 Bug Fixes

- Resolve npm audit vulnerabilities (a6a4b51).

### 📝 Documentation

- Describe parameterized queries (287ef63).
- Plan reactive query arguments (4876db8).

## 0.8.1 - 2026-08-14

Corrects the incomplete `0.8.0` package release with the merged `main` runtime,
generated artifacts, and documentation.

### 📝 Documentation

- Require current password to change email credentials (bfba651).

### ✨ Built-in Teams

- Add runtime-owned Teams for Capsule collaboration: multi-Team memberships,
  admin lifecycle, email-bound Join links, membership application roles, and
  explicit Team decisions in table and File ACLs. Teams are built in but do
  not select a current Team or automatically partition Capsule data; Sporades
  never sends Join-link email. See the [Built-in Teams reference](https://mgscox.github.io/sporades/reference/teams).
