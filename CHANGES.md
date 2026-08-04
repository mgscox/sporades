# Changes

## Unreleased - 2026-08-04

Changes since v0.6.3.

### ✨ New Features

- Email password management: `auth.setPassword(email, newPassword)` on the
  client SDK and `ctx.serverAuth.setEmailPassword(email, newPassword)` on the
  server context. The runtime handles scrypt hashing and updates the internal
  `sporades_auth_email_credentials` table. Capsule code no longer needs to
  leave `resetPassword` mutations as silent no-ops.

### 🐛 Bug Fixes

- Fix vite plugins (bd40007).

### 📦 Packaging

- Support npm 12 pack JSON output (361b1a4).
