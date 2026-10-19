# Changes

## Unreleased - 2026-10-19

Changes since v0.9.32.

### 🚀 Features

- Add opt-in Host-managed GlitchTip and Umami (#258) (ae2a8038).
- Add opt-in CSP nonces, Hosted HSTS, report URIs and observability forwarding (#248) (5f6931c5).
- Add opt-in same-origin error and analytics collection (#246) (98dd12ee).
- Add encrypted Capsule backups, restore and scheduling (#253) (6fb5bf57).
- Add privileged-only table ACL helpers and doctor guidance (#252) (39c37618).
- Add opt-in required Server env checks (#250) (93b94739).
- Add File upload policy and privileged orphan-sweep listing (#245) (27a12114).
- Add Capsule rate limits and trusted client addresses (#243) (82c67500).
- Add HTML-safe mail helpers and reset-body placeholders (#242) (736a6a88).
- Allow documentation PR builds to run concurrently (#247) (e359a6ed).

### 🐛 Bug Fixes

- Fix authenticated reload crashes from delayed table reads (#256) (db7ca81c).

### 📝 Documentation

- Propose Capsule container services (ADR 0056) (#260) (d80e1b26).
- Reconcile roadmap with v0.9.x delivered work (#257) (6e450668).
- Expose canonical public origins for Capsule links (#241) (8ebd1147).
- Protect destructive Team operations with atomic Capsule policy (#254) (d7edadd4).
- Expose payment activation through usePayments (#251) (06d786a5).
- Move workflow execution to Tower (e9d03972).

### 📦 Packaging

- Follow the current Node LTS release (9a8ef846).

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














