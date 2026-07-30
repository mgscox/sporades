# Authentication

Every visitor starts with a real Anonymous session. Email, Google OAuth, or
Sign in with Apple links an authentication method to that identity so existing
Capsule data follows the user.

Follow the [auth workflows](./reference.md#auth-workflows) to inspect
configuration, configure Google or Apple OAuth, use email auth, or simulate
local identities.

For authorization inside handlers, see [`requireAuth` and table ACL](./server.md).
