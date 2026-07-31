# Provider-neutral OAuth

## Status

Implemented through issue 07. Issue 08 remains `external-blocked` pending real
Google, Microsoft, Apple, and Facebook registrations and secret-safe
credentials for one HTTPS Hosted Capsule.

## Product contract

Capsule code expresses provider sign-in intent through
`auth.signIn(provider)`. Sporades owns provider configuration, full-page
redirects, callback handling, authorization-code exchange, signed identity
verification, stable Provider identities, account linking, Session rotation,
and secret handling.

Google, Microsoft, Apple, and Facebook coexist behind one provider-neutral
runtime seam. Identity authority is `(provider, subject)` rather than email;
same-email identities are never merged automatically. First sign-in links a
verified Provider identity to the current Anonymous user so Capsule data and
runtime-owned preferences follow the user. Provider-specific mechanics remain
server-owned and no provider SDK enters Capsule client code.

## Delivery slices

1. [Stable Provider identities](./issues/01-establish-stable-provider-identities.md)
2. [Runtime-owned provider seam](./issues/02-deepen-runtime-owned-oauth-provider-seam.md)
3. [Independent provider configuration](./issues/03-configure-providers-without-replacing-siblings.md)
4. [Microsoft OpenID Connect](./issues/04-sign-in-with-microsoft.md)
5. [Sign in with Apple](./issues/05-sign-in-with-apple.md)
6. [Facebook Login](./issues/06-sign-in-with-facebook.md)
7. [Provider coexistence and Google compatibility](./issues/07-contract-google-specific-auth-and-prove-coexistence.md)
8. [Real Hosted Capsule provider acceptance](./issues/08-verify-real-providers-on-hosted-capsule.md)

The implementation and review record remains in [the swarm
ledger](./swarm-ledger.md).
