# Changes

## Unreleased - 2026-07-30

Changes since v0.6.0.

### ✨ Features

- Add value-safe Sealed Server env automation with
  `sporades env set <name> --stdin` and `sporades env has <name>`.
- Add HTTPS-domain Sign in with Apple using server-owned `form_post`, runtime
  ES256 client credentials, strict identity-token verification, and
  Anonymous-account linking.

### 🐛 Bug Fixes

- Test for minor bump (996c1e7).
- Fix bundled email sign-in constants (307c8ea).
