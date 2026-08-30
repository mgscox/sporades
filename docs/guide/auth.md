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
      requireAuth({ credentials: ["session"] }, (ctx) => ({
        body: { userId: ctx.auth.userId },
      }))),
    importedRows: endpoint({ method: "GET", path: "/imports" },
      requireAuth({ credentials: ["access-key"], scopes: ["imports:read"] },
        (ctx) => ({
          body: { userId: ctx.auth.userId, access: ctx.credential.name },
        }))),
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

## Admit newly linked registrations

Capsules may opt into `auth.registration` to decide, and atomically record, a
new email or local simulated identity before Sporades creates its credential,
linked User, singleton Team, membership, or Session. The callback receives only
normalized identity evidence and a bounded opaque `admission` value supplied as
the optional third argument to `auth.signUp`.

```ts
export default capsule({
  name: "controlled-registration",
  auth: {
    registration: {
      admit: async ({ db, evidence, admission }) =>
        (await db.bootstrapClaims.all()).length === 0 && admission?.key === "approved"
          ? { allow: true } : { allow: false },
      finalize: async ({ db, evidence }) => {
        await db.bootstrapClaims.insert({ userId: evidence.userId });
      },
    },
  },
});
```

Both callbacks run in the same Auth transaction. A denial, invalid input, throw,
or finalizer failure returns the bounded `REGISTRATION_DENIED` result and rolls
back both application and runtime changes. The database handles are
transaction-bound and reject use after either callback settles. Omitting the
declaration preserves existing registration behaviour.

For first-time OAuth linking, pass the same option to `auth.signIn`. Sporades
stores the admission only as authenticated ciphertext bound to that provider,
anonymous Session, callback URI, nonce, and expiry; it is consumed with the
single-use OAuth state and is never added to redirects, provider traffic, or
callback errors.

### Purpose-bound reauthentication

Use Reauthentication Proofs when an already signed-in human must freshly
verify the identity behind the current Session before a high-risk mutation,
such as administrator promotion or relinquishment. Do not use them for routine
authorization: the Capsule must still recheck its own administrator, Team and
resource rules inside the mutation.

```ts
export default capsule({
  auth: { reauthentication: { purposes: {
    "administrator-authority": { maxAgeSeconds: 900 },
  } } },
  mutations: {
    promote: mutation(requireAuth({
      credentials: ["session"],
      reauthentication: "administrator-authority",
    }, async (ctx, input) => promoteAdministrator(ctx, input))),
  },
});
```

The browser verifies the current linked identity without receiving proof
material:

```ts
await auth.reauthenticate("email", { email, password }, "administrator-authority");
await mutations.promote({ userId });
```

The runtime stores the proof in its own database, bound to the User, exact
Session, Capsule and purpose. Its maximum declared lifetime is 15 minutes.
Minting and consumption re-read the exact Session from the database inside the
same transaction, so sign-out, revocation or expiry in another tab takes effect
even when a browser connection still holds cached auth state. A proof row may
remain after Session revocation or expiry for bounded cleanup and audit, but it
is unusable and cannot be consumed.
Consumption is part of the guarded mutation transaction: a rejected command
preserves the proof, one concurrent successful command wins, and commit makes
it unusable even after restart. URLs, Capsule arguments and successful replies
contain no proof handle or bearer.

The advantage is a small, auditable step-up boundary with atomic consumption
and no second client credential. The trade-offs are an extra identity-provider
interaction, server-side proof state, and a deliberately narrow purpose list;
it does not replace normal authorization, credential revocation, throttling or
transactional domain invariants. Capsules that omit `auth.reauthentication`
retain their existing authentication and mutation behavior.

Use Registration Admission when a Capsule must make its first-user or invite
decision from application state atomically with creating an identity. It is not
an authorization hook for existing users: linking an existing identity bypasses
admission. The admission must be JSON-safe and no larger than 4 KiB; its benefit
is a single durable allow/deny decision, while the tradeoff is that slow or
external policy work belongs before sign-in, not inside the transaction.
Sporades fences that decision with a runtime-owned database row. Separate
libSQL and Postgres connections therefore serialize before reading policy
state, then re-evaluate after the prior registration commits or rolls back;
the fence does not depend on one Node runtime's in-memory transaction queue.
The read-only `admit` database capability is revoked as soon as `admit` settles,
before `finalize` receives its separate transaction-scoped write capability;
captured or unawaited admission reads cannot overlap or observe finalizer writes.

Good uses include an invitation key, a one-time bootstrap administrator claim,
or a tenant allow-list that already lives in the Capsule database. Do not use it
for per-request authorization, post-registration roles, provider token
validation, or a policy that must make a network request. Those belong in the
normal authorization model, the registration finalizer, the OAuth provider
adapter, or work completed before `auth.signIn`/`auth.signUp`, respectively.
Admission is any JSON-safe value up to 4096 UTF-8 bytes, including explicit
`null`; omission remains the distinct `undefined` case.

The advantages are one policy for email, local simulation, and first-time OAuth
linking; atomic policy reads and finalizer writes; and no half-created identity
after denial. The costs are deliberate coupling of registration availability to
the Capsule database, a short transaction whose callback must remain bounded,
and an encrypted OAuth hand-off that needs runtime-owned key maintenance. A
broken policy denies new identities with `REGISTRATION_DENIED`; it does not
disable sign-in for an already-linked identity.

OAuth admission persistence is encrypted with the exact callback binding above.
Its active key is an immutable 22-character identifier pointing to separate
43-character material. Upgrades migrate the former `active` material once and
retain a bounded `active` alias until every outstanding legacy OAuth state has
expired (at least ten minutes). New envelopes always carry the immutable ID.
Malformed, unknown, or expired IDs fail closed without creating key rows; an
invalid envelope, unknown key, or authentication-tag failure is distinguished
from a legitimately absent admission and denies before Capsule policy or
finalizer code runs. Envelopes have exactly four dot-separated components;
their encoded binary components use canonical undecorated base64url, with a 12-byte IV and
16-byte authentication tag. An operator must restore the retained material if it is lost, after which affected
OAuth starts should be retried.

Sporades performs legacy-key reconciliation and safe retirement automatically
when an admission-enabled Capsule opens. Framework release and recovery tooling
uses the runtime maintenance API `reconcileOAuthRegistrationKeys(database)`,
`rotateOAuthRegistrationKey(database)`, and
`retireOAuthRegistrationKeys(database)`. These functions are runtime-internal,
not imports for Capsule code: rotation atomically swaps the active pointer and
returns only key IDs plus `retainUntil`; retirement removes an old material row
only after both that deadline and every matching OAuth state expiry. Never edit
the `oauth-registration-key:*` rows by hand or copy their values into logs.
There is intentionally no Capsule-facing key command in this release. If key
material is missing or corrupt, stop accepting new OAuth registrations, restore
the database from a protected backup, reopen the Capsule to reconcile, and ask
users whose state expired during recovery to start OAuth again.
