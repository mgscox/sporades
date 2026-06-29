# Implement real provider auth beyond anonymous sessions

Status: done

## What to build

Support real provider-backed authentication beyond anonymous sessions, with Google as the first concrete provider target. Do not trust previous issue status or docs that claim Google OAuth is already implemented: the current code needs investigation and likely replacement.

The server must do all trusted auth work. The client should only call the Sporades client SDK, and the SDK should hide the redirect flow from app developers. Login must always use a full-page redirect, not a popup window. App code should never construct provider URLs, handle OAuth callbacks, exchange codes, verify identity tokens, import Better Auth, import Google SDKs, or manually mutate auth state.

## Investigation findings

- The scaffolded client does not render a login/sign-in option.
- `createHooks()` exposes `useAuth()`, but `useAuth()` only reads auth state and has no login/sign-in method.
- The low-level client connection exposes `auth()` and `isAuthenticated()`, but no public provider sign-in command.
- The server handles `auth.signInWithGoogle` by returning a Google authorization URL, but there is no real OAuth callback handler or authorization-code exchange.
- The server handles `auth.completeGoogleSignIn` by trusting a client-supplied profile over WebSocket. That is not real Google OAuth and must not be treated as authenticated identity.
- `package.json` does not include `better-auth`, despite product docs claiming Better Auth owns the auth lifecycle.
- The CLI can write `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into `.env.sporades.server`, but that alone does not make auth functional or safe.

## Acceptance criteria

- [x] The fake `auth.completeGoogleSignIn` profile-trust path is removed or restricted to an explicit test-only harness that cannot ship in normal runtime code.
- [x] The server performs a real Google OAuth flow, including callback handling, authorization-code exchange, and verified identity/profile extraction.
- [x] The server owns provider redirect URL generation and validates all callback state before linking an account.
- [x] Required auth dependencies are installed and bundled intentionally, or the implementation documents why no auth library is needed.
- [x] Provider secrets live in Server env.
- [x] `sporades.json` stores provider env var names, not secret values.
- [x] Apps can configure provider auth without exposing secrets in normal CLI output.
- [x] The Sporades client SDK exposes an intent-level provider sign-in API, preferably `auth.signIn("google")`.
- [x] The client SDK handles the necessary full-page browser redirect mechanics internally so scaffold/app code does not need OAuth route or callback knowledge.
- [x] The client SDK preserves the current browser URL before redirect and restores it after auth completes.
- [x] Provider login does not use popup windows.
- [x] Scaffolded apps that enable provider auth include a visible login/sign-in control that only calls the Sporades client SDK.
- [x] Guestbook is used as the live-site acceptance test for Google authentication.
- [x] Signing in with a provider links the identity to the current anonymous session instead of creating an unrelated account.
- [x] `ctx.auth` reflects provider-backed identity fields such as display name, email, picture, authentication state, and provider.
- [x] Misconfigured provider auth fails with structured errors and actionable hints.
- [x] The auth surface leaves room for future providers beyond Google.
- [x] Tests cover the real auth boundary rather than only sending a synthetic client profile over WebSocket.

## Blocked by

None - can start immediately.
