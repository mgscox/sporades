# Changes

## Unreleased - 2026-08-17

Changes since v0.8.5.

### 🚀 Features

- Migrate additive unique constraints atomically (2cf8381).
- Add conflict-targeted idempotent table inserts (bd2aeaa).
- Expose privileged Team inspections (16d784a).
- Declare unique Capsule table constraints (f638b36).
- Expose exact Team membership counts (6893db7).

### 🐛 Bug Fixes

- Shut down rejected runtime candidates (5ec8198).
- Preserve candidate on activation degradation (302268c).
- Activate replacement jobs after teardown (ee4db9f).
- Serialize job lease recovery (09dca55).
- Refresh job leases after dev handoff (5961f77).
- Recover jobs across runtime handoff (6d2b344).
- Gate jobs on successful runtime initialization (3082aad).
- Validate all schedule cursors (bf3dea0).
- Arm schedule recovery after commit (da43e54).
- Persist schedule upgrade lineage (54d664e).
- Close schedule handoff and root reentry races (281029a).
- Serialize legacy schedule upgrades (9e87fb1).
- Publish schedule incarnations atomically (78da563).
- Make schedule generations authoritative (9005b1e).
- Bind schedules to declaration generations (b478ae7).
- Make schedule claims transactional (960f2c6).
- Seal retained job and libsql lifecycle (c5dc235).
- Recover future leases and schedules safely (fa08688).
- Bound job lifecycle time domains (89149c7).
- Close pre-handler job shutdown races (ffdca81).
- Make runtime shutdown failure atomic (1958f3b).
- Harden transactional lifecycle cleanup (e408f2d).
- Defer transactional job cancellation (2d3cf3e).
- Linearize team reads and job claims (1aa5391).
- Wake retained jobs on startup (0a66d61).
- Settle transactional log writes (43e1b2b).
- Revoke settled transaction adapters (bef9821).
- Abort jobs through the root runtime (5a43040).
- Settle jobs before lifecycle shutdown (51d1d9d).
- Settle job shutdown safely (9d38300).
- Await runtime closure during shutdown (ff688f1).
- Settle scheduled Jobs before runtime shutdown (7e7204e).
- Scope unique migration error translation (9af3b24).
- Preserve non-unique migration errors (2cfb207).
- Fix chained transaction release and async insert type (386ea84).
- Fix async insertOrIgnore documentation (a41f2ac).
- Guard privileged join-link reads (dea4ebc).
- Close privileged Team inspection races (d53136c).
- Redact privileged Team join metadata (ad77482).
- Defer existing table unique changes (e49477d).

### 🔧 Improvements

- Ignore Macos fluff files (d4ae934).

### 📝 Documentation

- Pin final platform contract evidence (65250af).
- Align platform contracts after swarm amendments (8f64c4f).
- Record swarm cleanup (7233572).
- Close combined platform contract swarm (a1862c8).
- Record final combined contract package proof (4c44bf8).
- Record combined contract proof evidence (ac1c48c).
- Record accepted unique migration contract (6c5e484).
- Record accepted idempotent insert contract (19e7b63).
- Align shipped Job lifecycle reference (9b7820f).
- Document atomic Job enqueue lifecycle (9dbeb8a).
- Reject nested database transaction scopes (3cc98b6).
- Record accepted platform contract tickets (6ef6d1c).
- Close unique constraint contract gaps (20baabb).
- Prove unique constraint boundaries across adapters (f6d3517).
- Cover immutable unique schema boundary (4fb81d9).
- Initialize platform contracts swarm ledger (61816a1).
- Add Team subscription platform tickets (494a086).

### 🧪 Tests

- Reset native schedule clock before init (1153643).
- Prove atomic Team Job enqueue failures (09265ab).
- Preserve PostgreSQL quoting recorder transactions (85d2266).
- Cover unrelated rebuild constraint failures (4605ec5).
- Isolate Node 24 SQLite server tests (8542eb9).
- Harden failed mutation cleanup (d43a5ab).
- Bound transaction handler context lifetime (67dccb4).
- Defer runtime Job dispatch until commit (0a04afb).
- Persist Jobs inside handler transactions (b59004f).
- Reject captured transaction reentry and drop rolled-back jobs (952309e).
- Replace async-local transaction ownership (95cbb85).
- Gate transaction connections and track mutation writes (20cda07).
- Serialize shared database connection transactions (425e4f0).
- Isolate composite unique conformance (75ace57).
- Cover Team count membership lifecycle (80d6cd7).
- Accept cross-realm query arrays (55b87a6).
- Reject query argument array subclasses (2171b61).

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

