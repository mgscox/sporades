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

## Named API access

A linked user can issue a named, scoped Access key for an automation process
without creating a fake Bot user or giving it an email/OAuth login. The owner
remains `ctx.auth`; `ctx.credential` distinguishes the interactive Session from
the named Access key. Declare the Capsule's scope vocabulary centrally and opt
only the intended Custom endpoints into Bearer admission:

```ts
import { capsule, endpoint, requireAuth } from "sporades/server";

export default capsule({
  name: "imports",
  accessKeys: { scopes: ["imports:read"] },
  endpoints: {
    account: endpoint({ method: "GET", path: "/account" },
      requireAuth({ credentials: ["session"] }, (ctx) => ({ userId: ctx.auth.userId }))),
    importedRows: endpoint({ method: "GET", path: "/imports" },
      requireAuth({ credentials: ["access-key"], scopes: ["imports:read"] },
        (ctx) => ({ userId: ctx.auth.userId, access: ctx.credential.name }))),
  },
});
```

Use `Authorization: Bearer <access-key>` only on explicitly guarded endpoints.
The placeholder is intentionally not a syntactically valid credential. An
unwrapped endpoint does not interpret it, and invalid Bearer attempts never
downgrade to Session or Anonymous authority. See the
[server runtime](../reference/server-runtime.md#gate-handlers-with-requireauth),
[client management flow](../reference/client-auth-and-preferences.md#access-key-management),
and [Files policy](../reference/files-and-realtime.md#file-uploads).
