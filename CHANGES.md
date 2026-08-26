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




