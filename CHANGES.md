# Changes

## Unreleased - 2026-08-04

Changes since v0.6.5.

### ✨ New Features

- Runtime-owned password reset links. `ctx.serverAuth.sendEmailPasswordResetLink(email)`
  issues a single-use Reset code and mails it; `createEmailPasswordResetLink(email)`
  returns the link for Capsules that deliver it themselves. Browsers use
  `auth.sendPasswordResetLink`, `auth.verifyPasswordResetCode`, and
  `auth.confirmPasswordReset` and only ever hold an opaque code. The reset page
  is always a Capsule route configured as `auth.email.passwordReset.path` — a
  same-origin path, not a URL, so there is no redirect target to abuse.
  Verification does not spend the code, so mail link-scanners cannot consume a
  link before the recipient clicks it; confirming spends it, revokes every
  Session for the account, and does not sign the browser in. Requests for
  unregistered addresses are indistinguishable from registered ones.

### 🔒 Security

- Hardened authorization on `auth.setPassword`. The client transport path now
  requires a linked, non-guest Session that owns the email credential being
  changed. Capsules that called it from an unauthenticated page must move that
  flow to a password reset link. The server-only
  `ctx.serverAuth.setEmailPassword` API is unchanged.
- Password reset mail is delivered by a durable Job rather than sent inline,
  keeping delivery behaviour out of the request path.

Upgrading is recommended for any Capsule using email/password accounts.

### 🐛 Bug Fixes

- User preferences (cebd9f0).
