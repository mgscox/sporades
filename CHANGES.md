# Changes

## Unreleased - 2026-08-30

Changes since v0.9.5.

### 🚀 Features

- Add opt-in runtime-owned purpose-bound Reauthentication Proofs for sensitive Session mutations.
- Persist encrypted OAuth registration admission (920f4a71).
- Persist ingress receipts in runtime storage (015b03d0).
- Stream bounded multipart ingress parts (3996fe29).
- Add email registration admission seam (70168d34).
- Add trusted multipart file ingress leases (b51afa4e).

### 🐛 Bug Fixes

- Publish ingress leases with CAS (9627b286).
- Preserve absent registration and stream file caps (7d5b35b4).
- Preserve null registration admission (252cf282).
- Close ingress and admission lifetimes (fa026b59).
- Preserve optional stable ingress keys (0002dc04).
- Align admission and ingress validation (1856cef4).
- Enforce multipart boundary grammar (44c43a3e).
- Complete local admission and ingress lifecycle (80d1d1c6).
- Validate OAuth admission envelope grammar (904b572d).
- Enforce multipart and OAuth admission bounds (ed405e88).
- Replay legacy principal ingress receipts (42290032).
- Fence registration and harden multipart framing (0f0a7429).
- Compensate failed multipart staging (2bcd0f2b).
- Honor trusted multipart ingress policy (7a425e98).
- Complete registration admission release parity (baeee2eb).
- Fix integrated endpoint ingress compatibility (5149e47f).
- Fix registration finalizer rollback (ed6d2129).
- Recover legacy actor ingress receipts (7fcb4994).
- Harden OAuth registration admission keys (582f0d90).
- Bind ingress ownership to explicit authority (033f4c6e).
- Migrate OAuth registration key pointers (fa7df6e9).
- Retire expired ingress leases safely (1b6a6cc5).
- Serialize ingress claims across runtimes (dc6c00c0).
- Persist ingress claim completion transactionally (2d3f98e1).
- Serialize ingress receipt acquisition (47d74918).
- Retain multipart parser state across chunks (a3d0ca92).
- Preserve multipart endpoint policy at runtime (cc4353ec).

### 📝 Documentation

- Clarify the provider-free headless Team Billing platform boundary: Sporades owns mechanics while Capsules render product UI.
- Prove fragmented MinIO ingress cleanup (e4d9c7c6).
- Complete trusted file ingress parity (dd50047f).
- Fix registration admission option examples (a18f91e6).

### 🧪 Tests

- Prove ingress claim transaction rollback (60a4b98c).
- Register ingress storage in adapter conformance (0001d96d).
- Prove ingress response loss recovery (c41025df).
- Prove ingress descriptor conflict race (0a12ed19).
- Prove concurrent ingress receipt acquisition (996db64d).
- Prove multipart ingress denial and disconnect cleanup (f2a08da5).
- Prove bounded multipart streaming (d3824243).

### 📦 Packaging

- Refresh host helper auth runtime (9248fc86).
- Prepare Sporades 0.9.6 integration candidate (50bb32ae).

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
