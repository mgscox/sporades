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

## Access keys for named API access

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

### Issue and disclose a key once

Build the owner-facing management UI with the framework-neutral `accessKeys`
client singleton. Only a linked user's live Session can use it, and it always
acts on that user's own keys:

```ts
import { accessKeys } from "sporades/client";

const issued = await accessKeys.issue({
  name: "nightly-import",
  grants: ["imports:read"],
  expiresAt: "2027-01-01T00:00:00.000Z",
});

if (issued.error || !issued.data) {
  throw issued.error ?? new Error("Access key issue failed.");
}
const tokenToCopy = issued.data.token;
```

Render `tokenToCopy` for one copy action, then clear it from component state.
Store the copied value in the automation's secret store, never in Capsule data,
browser storage, logs, or source control. Sporades returns plaintext only from
the successful `issue()` or `rotate()` call and stores no recoverable copy. If
that response is lost, list the safe metadata and rotate the key to obtain new
plaintext.

The key's ID, owner, name, grants, and optional expiry are immutable. To change
any of them, issue a replacement and revoke the old key. Rotation changes only
the secret and requires the current `lifecycleRevision` returned by `list()`.
Revocation is irreversible; only revoked history can be deleted.

### Keep actor authority and credential attribution separate

An Access key authenticates its current linked owner. Normal table, Team, File,
and Capsule authorization still decides what that user may do; matching a scope
never grants that authority by itself. Use `ctx.auth.userId` as the actor and
`ctx.credential` when logs or domain records must distinguish the interactive
Session from named API access.

Credential checks snapshot successful admission. Rotation, revocation, expiry,
password reset, owner unlink, or owner deletion blocks later checks but does not
cancel work already admitted. A current-user Job safely retains the admitted
user and named Credential provenance across restart and retry, without storing
the bearer secret or its grants. Resource and Team authorization is still
evaluated from current state when the Job runs.

For private File reads, opt in separately with `files.accessKeys.read`; endpoint
guards do not enable File Bearer access. For operational retirement, use the
[five metadata-only operator commands](../reference/operations-and-hosting.md#inspect-and-retire-access-keys).
Operators cannot issue, rotate, or recover plaintext, and stopped Capsules are
not opened just to reach Auth storage.
