# Changes

## Unreleased - 2026-08-31

Changes since v0.9.7.

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
