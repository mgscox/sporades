# Changes

- Expose the verified provider-free Team Billing projection to active Capsule
  query and mutation contexts and to exact-Team Join admission. Current members
  may be authorized for safe reads while all customer-directed commands remain
  current-Team-admin operations; retained context handles are revoked.
- Add an offline `sporades/server/team-billing-import` seam for exact,
  provider-free import of verified legacy Subscription snapshots and replay
  guards. Incomplete or conflicting evidence fails closed, including drift in
  durable Event ordering, terminal-latch safety fields, and contradictory
  Subscription Event/state tuples. The public adapter type now declares the
  complete named-dialect, execution, prepared-statement, and transaction seam.

## Unreleased - 2026-08-24

Changes since v0.9.0.

### 🚀 Features

- Expose verified billing state to capsule policy (946f0736).
- Add safe legacy Team Billing import seam (dab78ad9).
- Add provider-safe Team Billing erasure (9d334c0c).
- Add managed Team Billing convergence (ebdfd265).
- Add explicitly configured Team Customer Portal (760e5c4d).
- Add durable headless Team Checkout (4738b0fb).
- Add headless Team Billing foundation (57670d13).
- Add atomic Stripe consequence handling (04274543).

### 🐛 Bug Fixes

- Prove Stripe test Team Billing lifecycle (2aedbbcb).
- Fix packed blank Capsule typechecking (1662dd27).
- Prevent Stripe retention repair starvation (671f9537).

### 📝 Documentation

- Clarify private Team billing retention (8db4f2f8).
- Expose safe Team billing quarantine inspection (0dd71f85).
- Harden Team billing evidence validation (7b91b311).
- Converge verified Team billing state atomically (f962d06c).
- Document unrepresentable Stripe retention (27a852f1).
- Prove Stripe contention across runtimes (1ed35c38).
- Preserve cancellation and exact Stripe retention (c8591c52).
- Defer atomic Stripe fence contention durably (47e93072).
- Expose Team counts to atomic Stripe consequences (9f43dbe7).
- Periodically recheck Stripe retention repairs (9e5908e8).
- Recover classified Stripe retention repairs (f6c853f9).
- Harden Stripe payload retention cleanup (0b163187).
- Bound Stripe Event Job payload retention (cf2cf6eb).
- Harden atomic Stripe consequence recovery (92b55f5d).

### 🧪 Tests

- Preserve Team Portal capability across transient reads (7ffba828).
- Revalidate Team Portal authority at every seam (fcb4380e).
- Reconcile Checkout state after final lease expiry (c51ab5f7).
- Terminally settle exhausted Team Checkout retries (6fcb803f).
- Serialize Team Billing authority with Team lifecycle (987a4750).
- Validate Team Billing projection semantics (e7f05b20).
- Fail closed on Team Billing correlation drift (003e24af).
- Classify near-ceiling Stripe settlement (92cba517).

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

