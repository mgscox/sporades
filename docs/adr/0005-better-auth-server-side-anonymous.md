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

Current behavior is runtime-owned auth storage with anonymous sessions, email
sign-up/sign-in, Google OAuth provider linking, local identity simulation, and
provider configuration through `sporades.json` plus Server env. Provider-linked
accounts attach to the existing anonymous account so user data follows the
session instead of being recreated under a new user.
