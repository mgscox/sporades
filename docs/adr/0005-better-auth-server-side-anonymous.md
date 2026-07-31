# Historical server-side anonymous auth

Status: Superseded

Superseded by the runtime-owned auth model described in ADR 0015 and the
current product documentation. This ADR remains as the historical decision that
auth should be server-side only and that anonymous data should survive account
linking.

The original implementation notes selected a server-side auth library with an
anonymous-session flow. The important product decision still stands: the server
owns session management, provider linking, OAuth callbacks, and `ctx.auth`
population, while the client stores only an opaque Sporades session token and
does not import a provider SDK.

The current replacement described by ADR 0015 uses runtime-owned auth storage
with Anonymous sessions, email sign-up/sign-in, and provider-neutral OAuth
linking for Google, Microsoft, Apple, and Facebook. Provider configuration
crosses `sporades.json` plus Server env, and Provider identities attach to the
existing Anonymous account so user data follows the Session instead of being
recreated under a new user.
