# Changes

## Unreleased - 2026-08-18

Changes since v0.8.6.

### 🚀 Features

- Add transaction-bound trusted reads (9d23493).
- Add user-owned scoped Access keys with explicit Bearer admission, immutable
  Credential provenance, Session-only browser management, private-File and
  durable-Job integration, and audited operator retirement.

### 🐛 Bug Fixes

- Keep admission logs in transaction (5a9d012).
- Revoke trusted reads at settlement (dca0fea).
- Reject trusted reads from snapshots (9abe441).
- Bind Join cancellation to commit (e37058d).
- Close Team admission boundary races (b12dbde).
- Trust Team Join admission reads (32b65ee).
- Close trusted-read review gaps (da0c453).

### 📝 Documentation

- Complete trusted Join admission ticket (0347c0e).
- Complete trusted-read foundation ticket (2a24b7b).

### 🧪 Tests

- Restore PostgreSQL SQL quoting audit (c1fcf7c).
- Tidy up test (f643360).

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
