# Changes

## Unreleased - 2026-09-21

Changes since v0.9.25.

### 🚀 Features

- Add durable notification intents (#75) (8885992b).
- Add PostgreSQL resource transaction locks (f52eb67e).
- Add outer resource watchdog regression coverage (447f186f).
- Implement SQLite Job resource transactions and durable replay receipts (d2553b24).

### 🐛 Bug Fixes

- Preserve URL health route contract (#88) (10db3e3d).
- Harden request target rejection (#84) (d7514796).
- Fix HTTP failure logging liveness (#82) (fa53a5d8).
- Fix issue #77 suite baseline failures (#78) (2f52fd41).
- Fix File URL locking and resource acquisition deadlines (4571679e).
- Fix postgres resource callback lock waits (f3f5374f).
- Fence ACL and resource schema races (16200025).
- Fix ACL Promise combinator tracking (4da46e89).
- Reject unsafe resource table identity (c9d6bda0).
- Harden ACL lineage and resource readiness (602a968e).
- Harden ACL promise settlement and reject rewrite rules (901f34ba).
- Reject all resource table triggers (e7546547).
- Lock resource ACL dependencies and reject mutating triggers (fbdb4b53).
- Support async postgres ACL helpers (cfa01f1f).
- Close four findings in PostgreSQL resource handling (b353f1cf).
- Retain lazy reconnect after an unknown COMMIT outcome (08188c67).
- Deny a missing locked anchor before authorization (010a1785).
- Isolate postgres resource error boundaries (91684477).
- Redact PostgreSQL outer resource storage errors (619e0ab5).
- Fix postgres resource failure settlement (6a049ac7).
- Harden PostgreSQL resource authorization (d2dc57cb).
- Make PostgreSQL Job claim locks nowait (0fdfea3d).
- Publish PostgreSQL resource bootstrap atomically (d4f2b435).
- Bound PostgreSQL resource bootstrap lock (cdcc950f).
- Serialize PostgreSQL resource bootstrap (d5afdd21).
- Fix PostgreSQL resource identifier casing (d2bcd317).
- Harden resource transaction adapter seam (be2fe86d).
- Lock PostgreSQL resource authorization (b5f45cfb).
- Settle cancelled PostgreSQL resource Jobs (d4810820).
- Correct PostgreSQL Job loss capability assertion (2958562d).
- Fix outer resource logging settlement (4afe9504).
- Fix outer watchdog mutation race regression (2f849575).
- Fix authentication provider labels and migrate corrupted user rows (63d2f16a).
- Fix stale page-token recovery and bound unstable reconnects (b601a9ab).
- Repair resource constructor typing and regenerate shipped CLI fixes (98e22936).
- Fix SQLite resource review findings and document invocation boundaries (b1c0fe4b).
- Correct ticket 06 dependency metadata for resource swarm (cdba60a9).

### 🔧 Improvements

- Reconcile monolith HTTP import census (#87) (9c897f7a).
- Reconcile HTTP runtime module census (#85) (a9a66a68).
- Keep ACL race and any fail closed (84a8fc8e).
- Clarify PostgreSQL resource evidence boundaries (abcc32e3).
- Fail closed for noneligible resource adapters (c25db850).
- Race outer resource hooks with deadline (43a99c76).
- Guard endpoint files after resource binding (bb42a116).
- Mark ticket 02 done: merged as e31b4dfe (#61) (fa640cd1).

### 📝 Documentation

- Track request admission research (#90) (1d5f27a1).
- Reconcile HTTP re-export census (#89) (1220e9f9).
- Complete HTTP runtime caller census (#86) (0955f7c3).
- Book ticket 07 completion (32759b21).
- Verify amended Grant workflow boundaries (#76) (14eda541).
- Book ticket 06 complete (f0d905e5).
- Book ticket 05 complete (PR #74) (45258174).
- Fail closed for libSQL resource scopes (#74) (d9f036d5).
- Unblock fence tickets 05/06 after 02/04 merged (687f58d1).
- Reject partitioned PostgreSQL resource tables (f198d2de).
- Reject unexpected resource indexes (fa474fd6).
- Await Team ACL helpers (82d8b4ef).
- Configure engineering skills for GitHub issues (831fc4bf).
- Prove PostgreSQL endpoint receipt recovery (be719200).
- Complete PostgreSQL resource receipt recovery (675120bd).
- Mark ticket 03 merged and update resource fence frontier (9229ea96).
- Reconcile outer resource commits and publish logs (d033d108).
- Regenerate resource API reference (be2c0dba).
- Document outer resource transaction joining (9851aba0).
- Track unsupported notification attempts through resource rollback (8b094c59).
- Map resource connection acquisition errors and retain durable planning links (869bb009).
- Align Stripe dependency and pinned API version on 22.6.2 (2b5cc9c6).
- Expose auth.sessionToken() for same-origin public endpoints (#62) (0a87a800).
- Carry approved M1 resource transaction plan from decision PR 57 (28e95c2e).

### 🧪 Tests

- Preserve literal HTTP request-target semantics (#83) (9b4eb84b).
- Quarantine Postgres backend on deadline cancellation (61162981).
- Bound PostgreSQL cancellation delivery (1d97423f).
- Fence cancelled Postgres queries and nested ACL promises (70f09f18).
- Bind File deletion authorization to locked metadata (d1b497ca).
- Bound PostgreSQL resource callback lock waits (709d14f2).
- Normalize PostgreSQL ACL lock contention (6c8ed5f8).
- Bound PostgreSQL ACL dependency locks (59005492).
- Bound Job resource authorization contention (1d0a407c).
- Preserve resource callback SQLSTATE errors (6cdb5476).
- Reject generated Postgres resource columns (098753ad).
- Reject unsafe Postgres resource schemas (568c50e2).
- Prove PostgreSQL resource schema publication (91ce4717).
- Census carried resource and billing modules (85285957).
- Prove resource transaction seam boundary (656bddf3).
- Cover PostgreSQL Job claim conflicts (6cd34a7f).
- Prove PostgreSQL paused-owner recovery (ec9a17e0).
- Prove PostgreSQL resource process death recovery (846fb131).
- Reset PostgreSQL commit-loss fixture (67ed81b3).
- Prove PostgreSQL commit acknowledgement loss (6d6f0c31).
- Assert revoked PostgreSQL Job scope handles (1e543513).
- Fence PostgreSQL Job claims through commit admission (951c1fd6).
- Cover PostgreSQL Job resource receipts (bb614495).
- Prove PostgreSQL resource lock contention and backend loss (c50007ab).
- Harden outer resource admission and failures (205df5da).
- Prove outer resource dispatch causally (a9c750ff).
- Poison admitted outer resource failures (4b0c7a71).
- Quarantine SQLite root after uncertain outer commit (81322daa).
- Redact postcommit resource log publication failures (76a11538).
- Keep outer cleanup watchdog coverage runtime-owned (7fbc2e19).
- Prove outer notification rejection settlement (a246cb65).
- Fence outer resource settlement and parent logging (11ab4cfe).
- Cover outer resource uncertainty across endpoints (181ad213).
- Prove outer resource commit uncertainty outcomes (fd8af841).
- Classify outer resource commit uncertainty (c5990fa3).
- Quarantine uncertain outer resource connections (a21fa98d).
- Fence outer resource middleware and commit deadline (b07bfe1e).
- Track nested resource table operations (a6285359).
- Prove watchdog reaches pending log cleanup (177d08a4).
- Make outer hook watchdog proof self-contained (e79596a2).
- Cover watchdog during resource cleanup (5de7d131).
- Assert Grant state inside protected Jobs (56342516).
- Prove joined Grant mutations across runtimes (464e69fe).
- Cover real multipart endpoint resource file guards (ab61e05a).
- Cover endpoint resource file guards (e3c71ed0).
- Cover outer resource hook deadline (0cbe976e).
- Exercise the token route in Journey reconnect integration tests (5884446a).
- Abort outer cleanup after resource deadline (8fbcab4d).
- Cover outer resource log transactions (260a9270).
- Poison caught outer resource failures (6d00d514).
- Prove membership ACL ordering across runtimes (2da4cddd).
- Prove Grant resource ordering across workers (cda02216).
- Cover endpoint resource deadline parity (62160e8e).
- Prove outer resource transaction ordering (b7c9d4e4).
- Keep outer resource deadline through transaction settlement (7ae38c07).
- WIP: fence outer resource transaction deadline (34da2523).
- WIP: join mutation and endpoint resource scopes (1092d072).
- Reconcile resource cancellation from independent runtimes (93a1442b).
- Preserve cancelled Job settlement for resource abort errors (fa2b08c3).

### 📦 Packaging

- Bound PostgreSQL quarantine lock release (bff3a21c).

## v0.9.11 - 2026-09-02

Corrects the incomplete `0.9.10` npm package, which was published from a stale
local checkout before the merged release commit was pulled. This release
contains the reviewed Human Security, Service User, and lifecycle-continuation
runtime, generated artifacts, and documentation from merged `main`.

## v0.9.10 - 2026-08-31

Changes since v0.9.9.

### 🚀 Features

- Add purpose-bound reauthentication proofs (c4ddd032).
- Preserve provider-free headless Team Billing platform mechanics while Capsule UI remains app-owned.
- Add transaction-bound human Session and Access-key retirement for administrative security transitions.
- Add first-class Service Users and service-owned Access keys for named
  automation, with atomic Session-authorized lifecycle management and exact
  actor/credential provenance.

### 📝 Documentation

- Preserve the provider-free, headless Team Billing boundary: Sporades owns
  mechanics while Capsules render subscriber-visible product experience.
- Document when to use Service Users, their authority intersection, and the
  lifecycle and operational trade-offs.
- Request Google signed reauthentication time (2fa291dc).
- Verify OAuth reauthentication freshness (7a6c989a).
- Persist and serialize email reauthentication (74ef1c50).
- Harden email reauthentication contracts (a919df94).
- Sweep expired proofs before guarded mutations (c888d70c).
- Harden reauthentication lifecycle (c8189c58).
- Bind reauthentication to active sessions (e692028f).

### 🧪 Tests

- Cover Service-User rollback, lifecycle races, restart denial, provenance,
  compatibility, and secret redaction.
- Retire proofs during Session rotation (b1e25b48).
- Harden reauthentication failure and ordering proof (8f933b91).
- Require active User for proof consumption (465bf5a4).
- Recheck OAuth authorization at callback (19c4159c).

## Unreleased - 2026-08-26

Changes since v0.9.4.

### 🐛 Bug Fixes

- Dispatch Team billing after mutation commit (62482c15).
- Stage Team billing from mutation transactions (fd649a91).

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











