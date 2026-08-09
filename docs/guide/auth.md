# Authentication

Every visitor starts with a real Anonymous session. Email, Google OAuth, or
Microsoft OpenID Connect, Sign in with Apple, or Facebook Login links an
authentication method to that identity so existing
Capsule data follows the user.

Follow the [auth workflows](../reference/client-auth-and-preferences.md#auth-workflows) to inspect
configuration, configure Google, Microsoft, Apple, or Facebook sign-in, use email auth,
[reset and change email passwords](../reference/client-auth-and-preferences.md#reset-or-change-an-email-password),
or simulate local identities.

For authorization inside handlers, see [`requireAuth` and table ACL](./server.md).
