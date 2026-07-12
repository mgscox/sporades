# Authentication

Every visitor starts with a real Anonymous session. Email or Google OAuth links
an authentication method to that identity so existing Capsule data follows the user.

Follow the [auth workflows](./reference.md#auth-workflows) to inspect configuration, configure Google OAuth, use email auth, or simulate local identities.

For authorization inside handlers, see [`requireAuth` and table ACL](./server.md).
