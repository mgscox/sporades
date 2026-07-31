# Changes

## Unreleased - 2026-07-30

Changes since v0.6.0.

### ✨ Features

- Add server-only, provider-independent SMTP delivery through
  `ctx.mail.send(...)`, with portable configuration across Dev sessions, local
  Container sessions, and Hosted Capsules; validated Postmark, Mailgun,
  SMTP2GO, and generic SMTP extensions; bounded transport behavior; and
  secret-safe diagnostics.
- Expand runtime-owned OAuth from Google to a provider-neutral contract for
  Google, Microsoft, Apple, and Facebook. Capsule client code continues to call
  `auth.signIn(provider)` while Sporades owns provider configuration, callbacks,
  identity verification, Session linking, and secret handling.
- Add Microsoft OpenID Connect sign-in with tenant-aware discovery, PKCE,
  nonce, signed identity-token verification, and stable tenant-qualified
  subjects.
- Add HTTPS-domain Sign in with Apple using server-owned `form_post`, runtime
  ES256 client credentials, strict identity-token verification, and
  Anonymous-account linking.
- Add Facebook Login through a server-owned authorization-code flow and
  versioned Graph profile lookup, using the stable Facebook ID rather than
  mutable or optional email as identity authority.

Real-provider acceptance for all four OAuth providers on one HTTPS Hosted
Capsule remains pending provider registrations and credentials; local,
protocol, browser, generated-runtime, and Container verification is complete.

### 🐛 Bug Fixes

- Test for minor bump (996c1e7).
- Fix bundled email sign-in constants (307c8ea).
