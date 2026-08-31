# Client, Authentication, and Preferences Reference

Subscribed client state, authentication workflows, provider configuration, and current-user preferences.

[Back to the feature reference index](../guide/reference.md).

## Building the Client Side

### Use Queries

`useQuery(name)` returns `{ data, error, loading }`:

```tsx
function ProjectList() {
  const projects = useQuery("myProjects");

  if (projects.loading) {
    return <p>Loading...</p>;
  }

  if (projects.error) {
    return <p>{projects.error.message}</p>;
  }

  return (
    <ul>
      {(projects.data ?? []).map((project) => (
        <li key={project.id}>{project.name}</li>
      ))}
    </ul>
  );
}
```

The query name must match a server query key.

For a declared Custom query, pass JSON-compatible positional arguments after
the query name. The same trailing-argument convention is used by
`queries.subscribe`, `useQuery`, Vue `useQuery`, Solid `createQuery`, Svelte
`queryStore`, Lit `queryController`, and Inferno `queryAdapter` (after their
existing host argument where applicable):

```tsx
const projects = useQuery("projectsForTeam", teamId, { archived: false });
```

Sporades snapshots those values and treats recursively key-sorted objects as
the same subscription; array order remains significant. Re-rendering with a
new but canonically equal object therefore keeps the same channel. Arguments
must be JSON values and their canonical JSON array is limited to 65,536 UTF-8
bytes. Do not use query arguments with runtime-owned or implicit table queries.

Framework-neutral code follows the same order:

```ts
const subscription = queries.subscribe(
  "projectsForTeam",
  (state) => render(state),
  teamId,
  { archived: false },
);
```

### Use Mutations

`useMutation(name)` returns `{ run, error, loading }`:

```tsx
function NewProjectForm() {
  const createProject = useMutation("createProject");
  const [name, setName] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await createProject.run({ name });
    if (!result.error) {
      setName("");
    }
  }

  return (
    <form onSubmit={submit}>
      <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <button disabled={createProject.loading}>Create</button>
      {createProject.error ? <p>{createProject.error.message}</p> : null}
    </form>
  );
}
```

The mutation arguments are sent as-is to the server mutation after `ctx`.

### Use Auth State

The scaffold exposes auth through `useAuth()`:

```tsx
const session = useAuth();

if (session.loading) return null;

return (
  <div>
    <span>{session.auth?.displayName ?? "Anonymous"}</span>
    {session.isAuthenticated() ? (
      <button onClick={() => session.signOut()}>Sign out</button>
    ) : null}
  </div>
);
```

Anonymous auth is available by default. It creates a real persistent session, so
data can follow the user if they later link a provider.

## Auth Workflows

### Check Auth Configuration

```sh
sporades auth status
sporades auth status --json
```

The status command reports every built-in provider's `enabled`, `configured`,
and `runtimeAvailable` state. OAuth entries report their callback path and, when
the provider accepts it, the exact local callback URL for a fixed Dev port.
Apple requires an HTTPS callback: its status has a null `callbackUrl` locally
and guidance to use the Capsule's Hosted HTTPS origin or an HTTPS development
tunnel. JSON output contains env-var names and non-secret options, never
credential values.
Facebook status and client provider state also report the effective
`graphVersion`. A genuinely omitted value is normalized to `v23.0`; explicit
null, non-string, malformed, and unsupported values leave Facebook unavailable.

### Configure OAuth Providers

`sporades auth set <provider>` merges one provider into the existing provider
map. It does not replace configured siblings or turn off Anonymous sessions.

```sh
sporades auth set microsoft --client-id <id> --client-secret <secret> --tenant organizations
sporades auth set apple --client-id <services-id> --team-id <team-id> --key-id <key-id> --private-key <pem>
sporades auth set facebook --client-id <app-id> --client-secret <app-secret> --graph-version v23.0
sporades auth set email
sporades auth set microsoft --disable
```

Google, Microsoft, Apple, and Facebook accept provider-specific credential
files through `--client-json`. Sporades stores secret values only in Server env
(or Sealed Server env after import); `sporades.json` keeps provider shape,
non-secret options, and env-var names. Restart a running Dev session after any
provider change.

Apple private keys may be supplied as ordinary multiline PEM values in the
credential JSON file. Sporades serializes them reversibly into one Server env
entry; it does not copy the key into `sporades.json` or command output. Register
`/__sporades/auth/apple/callback` on an HTTPS origin. Do not register a
localhost or plain-HTTP callback for Apple.

### Configure Sign in with Apple

In Apple Developer, create or select all of the following:

- an App ID with Sign in with Apple enabled;
- a Services ID used as the OAuth `client_id`;
- a Website URL on the Capsule's public HTTPS domain;
- the exact return URL
  `https://<capsule-domain>/__sporades/auth/apple/callback`;
- a Sign in with Apple private key, recording its Key ID and the developer
  account's Team ID.

The Website URL and return URL must use an HTTPS domain. Apple sign-in is hidden
from generated sign-in controls on HTTP, localhost, and IP-address origins, and
an attempted start fails before redirect with guidance to use an HTTPS
development tunnel or Hosted Capsule.

Sporades does not trust `X-Forwarded-Host` or `X-Forwarded-Proto` merely because
a client supplied them. Behind an HTTPS tunnel or reverse proxy, configure the
exact public origin with `SPORADES_PUBLIC_ORIGIN`. The browser `Origin`, `Host`,
and any forwarded host/protocol headers must agree with that configured origin.
Without a configured public origin, OAuth uses the validated request `Host` and
the actual TLS socket; forwarded headers are rejected. Keep the Capsule runtime
unreachable from untrusted networks when a reverse proxy is its public edge.

Configure the provider directly:

```sh
sporades auth set apple \
  --client-id com.example.capsule.web \
  --team-id ABCDE12345 \
  --key-id 1A2B3C4D5E \
  --private-key "$(cat AuthKey_1A2B3C4D5E.p8)"
```

For automation, prefer a provider credential JSON file:

```json
{
  "servicesId": "com.example.capsule.web",
  "teamId": "ABCDE12345",
  "keyId": "1A2B3C4D5E",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
}
```

```sh
sporades auth set apple --client-json ./apple-sign-in.json
```

The private key is stored only in Server env (or Sealed Server env). At each
code exchange Sporades signs a short-lived ES256 client-secret JWT in memory;
the generated credential, private key, authorization code, and Apple tokens
are not returned to the browser or written to normal logs.

The Apple key must be an unencrypted private EC key on P-256 (`prime256v1`), as
issued by Apple. RSA keys, other EC curves, public-only keys, encrypted keys,
and malformed PEM fail with a bounded credential error before code exchange.

Apple returns the person's name only on the first authorization. Sporades
accepts the bounded `form_post` payload, sanitizes the name, and saves it in the
same Auth transaction as the verified Provider identity. Later sign-ins work
without a name. Private-relay email may change or disappear; the verified Apple
`sub` claim remains the account identity key.

If Apple reports a redirect mismatch, compare the registered return URL
character-for-character with the HTTPS callback generated from the public
Capsule origin. If signing fails, confirm that the Team ID, Key ID, Services ID,
and `.p8` private key belong together. If relay mail does not arrive, verify
the domain and sender registration in Apple's private email relay settings.
Cancellation and failed callbacks spend the local OAuth state, so restart
sign-in rather than replaying the callback. The `form_post` body is capped at
16 KiB and accepts only an unambiguous URL-encoded callback. Once one exact
state value is identified, duplicate code/error/user values, mixed
success/cancellation responses, and malformed downstream fields spend that
state before failing. Form names and values require strict UTF-8 and reject
encoded or raw control characters, replacement characters, and Unicode
noncharacters. A duplicate or malformed state, malformed parameter name,
unsupported media type, or oversized body cannot identify a trustworthy state
and therefore fails without consuming one.

Apple identity tokens and signing-key responses are bounded before JSON
parsing. Sporades accepts only plain-object JWT headers and claims, verifies
RS256 against a matching Apple signing JWK, and reloads Apple's key set on each
completion so ordinary key rotation does not require a runtime restart.

Provider updates stage `sporades.json` and Server env replacements beside their
targets, then commit them with atomic renames. If either commit fails, Sporades
attempts every required restore and reports whether recovery completed without
printing file contents. Transaction targets are compared as absolute,
lexically-normalized paths before any filesystem operation, so `a`, `./a`, and
`dir/../a` cannot enter the transaction twice. The generic helper does not
dereference symlinks, detect hard-link aliases, or infer case-folding volume
identity; callers must provide canonical non-symlink targets, must not repeat an
inode through hard links, and must use the filesystem's canonical case. The
OAuth command uses its two fixed normal project-file paths.

### Configure Google OAuth

Create a Google OAuth **Web application** client. In Google Console, set:

- **Authorized JavaScript origins**: the Capsule origin, with no path, for
  example `http://localhost:4000` for a local Dev session or
  `https://team-notes.example.com` for a Hosted Capsule.
- **Authorized redirect URIs**: the same origin plus Sporades' Google callback
  path: `/__sporades/auth/google/callback`.

> ---
> **Configuring Google OAuth Web application client in Google Console**
>
> For the usual local Dev session URL, the redirect URI is:
>
> ```text
> http://localhost:4000/__sporades/auth/google/callback
>```
>
> If you run Dev on another port, use the URL printed by `sporades dev`. For a
> Hosted Capsule, use its Hosted Capsule URL, for example:
>
> ```text
> https://team-notes.example.com/__sporades/auth/google/callback
> ```
> ---

#### Importing the OAuth client into Sporades

Once the client is setup in the Google console, you can use the client Id and secret directly, or download and use the JSON representation.

Using explicit values:

```sh
sporades auth set google --client-id <id> --client-secret <secret>
```

Or, using the downloaded Google OAuth web client JSON file:

```sh
sporades auth set google --client-json ./client_secret_google.json
```

Sporades writes Google auth values to `.env.sporades.server` and stores the environment variable names in `sporades.json`.
Restart any running Dev session after changing auth configuration.

> Run `sporades env import` after setting auth values if you want them in Sealed Server env.

### Configure Facebook Login

Create a Meta app with Facebook Login for the Capsule. Sporades supports Meta
Graph API `v23.0`; configure it explicitly or allow the CLI to write that
default:

```sh
sporades auth set facebook \
  --client-id <app-id> \
  --client-secret <app-secret> \
  --graph-version v23.0
```

The App ID is stored through `FACEBOOK_CLIENT_ID` and the App Secret through
`FACEBOOK_CLIENT_SECRET` in Server env. `sporades.json`, `auth status`, client
messages, inspection output, and normal logs never contain the secret or a
Facebook access token.

In Facebook Login settings, register the exact Valid OAuth Redirect URI:

```text
http://localhost:4000/__sporades/auth/facebook/callback
```

Replace the origin and port with the value reported for the Capsule, including
the Hosted HTTPS origin in production. Do not add or remove a trailing slash.
The browser performs a top-level redirect; Capsule client code uses
`auth.signIn("facebook")` and does not import the Facebook JavaScript SDK.

Sporades requests `public_profile,email` and reads only `id,name,email,picture`
from Graph `/v23.0/me`. The stable Facebook `id` is required. Email, name, and
picture are optional, so declining email does not block sign-in.

While the Meta app is in Development mode, sign-in is limited to app
administrators, developers, and testers. Add test accounts or roles before
testing; switch the app to Live only after its required setup and review are
complete. Restart Sporades Dev after changing credentials or Graph version.

If Facebook sign-in fails:

- `FACEBOOK_APP_RESTRICTED`: check Development/Live mode and the account's app
  role or tester access.
- `FACEBOOK_PERMISSION_DENIED`: retry and grant the requested permissions.
  Email may still be declined without preventing login.
- `FACEBOOK_REDIRECT_MISMATCH`: copy the exact callback URL from
  `sporades auth status --json` into Valid OAuth Redirect URIs.
- `FACEBOOK_EXCHANGE_FAILED`: check the App ID, App Secret, app mode, and
  callback URI.
- `FACEBOOK_GRAPH_FAILED` or `FACEBOOK_PROFILE_ID_MISSING`: check Graph API
  access and that the supported `v23.0` `/me` response includes a stable `id`.

Sporades accepts only the built-in HTTPS Facebook and Graph endpoints in normal
operation. Redirect responses are refused, requests have finite deadlines, and
provider JSON is capped before parsing. For an opt-in real-browser regression
tracer, install Playwright and Chrome, then run:

```sh
SPORADES_REAL_FACEBOOK_BROWSER=1 node --test test/facebook-oauth-browser.test.js
```

The tracer scaffolds a real React Capsule, clicks its runtime-derived Facebook
button in Chrome, and observes top-level navigation at a loopback authorization
receiver. Its insecure loopback seam is process-only and cannot be enabled from
`sporades.json`.

### Configure Microsoft sign-in

Create an app registration in the Microsoft Entra admin center. Choose the
supported account types that match the Capsule's tenant selection, add a
**Web** redirect URI, and create a client secret. The redirect URI must exactly
match the Capsule origin plus:

```text
/__sporades/auth/microsoft/callback
```

For example, a fixed local Dev session on port 4000 uses:

```text
http://localhost:4000/__sporades/auth/microsoft/callback
```

A Hosted Capsule uses its public HTTPS origin. Configure the registration with:

```sh
sporades auth set microsoft \
  --client-id <application-client-id> \
  --client-secret <client-secret> \
  --tenant organizations
```

`--tenant` accepts:

- `common` for work, school, and personal Microsoft accounts;
- `organizations` for work and school accounts;
- `consumers` for personal Microsoft accounts;
- one tenant GUID or verified tenant domain for a single organization.

A Microsoft credential JSON file with `clientId`, `clientSecret`, and optional
`tenant` fields can be used through `--client-json`. The default tenant is
`common`. Sporades writes credentials to Server env and stores only env-var
names and the tenant selection in `sporades.json`. Restart a running Dev
session after changing the registration.

Microsoft sign-in uses discovery-owned OpenID Connect endpoints and requests
only `openid profile email`. Sporades performs a full-page authorization-code
redirect with PKCE, state, and nonce, exchanges the code on the server, and
verifies the signed ID token. No Microsoft SDK or access token enters Capsule
client code. A verified tenant ID plus subject is the identity key; email and
`preferred_username` are optional mutable profile claims.

If sign-in fails:

- `OAUTH_PROVIDER_ACTION_REQUIRED` means the user must complete a Microsoft
  consent or account prompt;
- `OAUTH_TENANT_REJECTED` means the account is outside the configured tenant;
- `OAUTH_EXCHANGE_FAILED` commonly means the secret or exact callback URI does
  not match the app registration;
- `OAUTH_ID_TOKEN_*` means signed identity evidence failed verification or
  Microsoft discovery/signing-key data was unavailable or invalid.

Provider response details and tokens are deliberately omitted from browser
errors and normal logs. Sporades rejects redirects on provider network calls,
uses finite deadlines and response limits, and caches discovery/signing keys
for a bounded period. Concurrent sign-ins share cache fills and the single
key-rollover refresh, rather than multiplying provider requests. Missing key
IDs use a short per-key retry cooldown so provider propagation can complete
before the document TTL expires. Cache and cooldown entry counts are bounded.
If every cache slot is serving an active distinct provider request, another
distinct key fails safely and may be retried after capacity becomes available;
no untracked request is launched.
Start a new sign-in after any failure because OAuth state
is single-use.


#### Using OAuth sign-in in the client

Client sign-in uses the provider name:

```tsx
import { auth } from "sporades/client";

for (const [provider, state] of Object.entries(session.providers)) {
  if (state.enabled && state.configured && state.runtimeAvailable) {
    await auth.signIn(provider);
  }
}
```

### Use Email Auth

Enable email in `sporades.json`:

```json
{
  "auth": {
    "providers": {
      "anonymous": true,
      "email": true
    }
  }
}
```

Then call the provider-neutral auth methods:

```tsx
const signUp = await auth.signUp("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
  name: "Mira",
});

const signIn = await auth.signIn("email", {
  email: "mira@example.com",
  password: "correct horse battery staple",
});
```

Check `result.data` and `result.error`; do not assume sign-in succeeded.

### Registration Admission

Declare `auth.registration` when creating a new linked identity must be gated by
Capsule data. `admit` receives a transaction-bound read-only `db`, normalized
`evidence`, and the optional client admission. It must return `{ allow: true,
state? }` to continue. `finalize` receives a write-capable transaction-bound
`db`; its second argument contains the evidence plus the admitted `state`.

```ts
auth: {
  registration: {
    admit: async ({ db, evidence, admission }) => {
      const invite = await db.invites.get(admission?.invite);
      return invite?.email === evidence.email
        ? { allow: true, state: { inviteId: invite.id } }
        : { allow: false };
    },
    finalize: async ({ db }, admitted) => {
      await db.invites.update(admitted.state.inviteId, { usedBy: admitted.userId });
    },
  },
}
```

Pass the admission as the optional third argument:

```ts
await auth.signUp("email", credentials, { registration: { admission: { invite } } });
await auth.signIn("google", undefined, { registration: { admission: { invite } } });
```

The admission must survive `JSON.stringify`, must not contain secrets that need
to outlive the attempt, and is limited to 4 KiB encoded as UTF-8. A policy may
deny a missing admission; oversized, cyclic, explicitly denied, throwing, or
failing-finalizer paths return the same bounded `REGISTRATION_DENIED` error. The
Auth identity, credential, User,
initial Team and membership, Session transition, and finalizer writes share one
transaction, so denial or failure commits none of them. Callback database
handles are revoked after settlement.

For OAuth, missing admission is a legitimate value only when the OAuth start did
not carry one. A malformed ciphertext, unknown retained key, invalid binding, or
authentication-tag failure denies before `admit` or `finalize` runs and cannot
fall through to a first-user or database-only allow rule.
The encrypted envelope accepts exactly four segments, canonical undecorated
base64url binary components, a 12-byte IV, a 16-byte authentication tag, and non-empty
ciphertext; extra segments, permissive decoder aliases, and wrong lengths fail
closed before key lookup or policy execution.

A runtime-owned database write fence serializes new-registration policy across
separate SQLite, libSQL, and Postgres connections. The waiter evaluates policy
only after the previous transaction's finalizer and identity writes commit, or
after they roll back. Keep `admit` and `finalize` bounded and provider-free:
they deliberately hold this per-Capsule registration fence.

Admission runs only when an anonymous user would create a new linked identity.
Sign-in to an existing identity, recovery of a pre-Teams linked identity, and
linking another provider to an already-linked user bypass it. Consequently this
is a creation gate, not an ongoing ACL or role system.

For OAuth, Sporades encrypts the admission with AES-256-GCM. The authenticated
data binds provider, anonymous Session token, exact callback URI, nonce, and
expiry. The ciphertext stays in the single-use OAuth state row, is never sent to
the provider or redirect, and becomes unusable if any binding changes or the
state expires. New envelopes name an immutable random key ID. On an upgrade,
admission-enabled runtimes transactionally migrate the former 43-character
`active` material to an immutable material row before any callback is accepted,
and retain a read-only `active` alias through the latest outstanding legacy
state expiry, with a minimum ten-minute grace.

Runtime release and recovery tooling has three exact maintenance operations:

- `reconcileOAuthRegistrationKeys(database)` creates or migrates the active
  immutable key under the Auth transaction fence.
- `rotateOAuthRegistrationKey(database)` atomically swaps the pointer and
  returns safe metadata: the new and previous key IDs and `retainUntil`.
- `retireOAuthRegistrationKeys(database)` deletes old material only when its
  retention deadline and every matching OAuth state expiry have passed.

They are internal runtime exports, not supported `sporades/server` Capsule
imports, and never return key material. Normal Capsule operators do not need to
invoke them: reconcile and safe retirement run at startup when registration
admission is enabled. Do not directly edit `oauth-registration-key:*` metadata.
For a missing or malformed active key, pause new OAuth registration and restore
the database from a protected backup; reopening then reconciles state. OAuth
attempts that expire during recovery must be restarted. Unknown or malformed
envelope key IDs fail closed and cause no metadata write.

Use this feature for database-backed invitations, a first-administrator claim,
or an existing tenant allow-list. Its benefits are consistent provider policy,
atomic application/runtime state, and bounded denials. Its costs are database
availability on the registration path, short-lived encrypted key lifecycle,
and the requirement that callbacks remain fast and deterministic. Do not use it
for request authorization, post-registration roles, provider verification, or
network policy calls.

### Reset or Change an Email Password

The runtime exposes `auth.setPassword(email, currentPassword, newPassword)` on the client SDK
and `ctx.serverAuth.setEmailPassword(email, newPassword)` on the server context.
The client call requires the signed-in user to prove knowledge of their current
password; the server API is trusted for reset and administrative flows. Both
update an existing email credential's password with server-side scrypt hashing
and a fresh random salt. The runtime never exposes the password hash, salt, or
internal credential table to Capsule code.

From the client (e.g. a settings page where the user is already signed in):

```tsx
import { auth } from "sporades/client";

const result = await auth.setPassword(
  "mira@example.com",
  "current-secure-password",
  "new-secure-password",
);
if (result.error) {
  // show result.error.message
}
```

From a server mutation (e.g. a token-based password reset flow where the
mutation validates a reset token and then sets the new password):

```ts
resetPassword: mutation(async (ctx, token: string, newPassword: string) => {
  // validate token, extract email from the token record…
  await ctx.serverAuth.setEmailPassword(email, newPassword);
  // mark token as used…
  return { ok: true };
}),
```

`ctx.serverAuth.setEmailPassword` throws if the email is not registered or the
password is shorter than 8 characters. Wrap it in a try/catch if you want to
return a user-facing error instead of throwing.

### Retire a Human's Runtime Credentials Atomically

An authenticated Capsule mutation may call
`ctx.serverAuth.revokeHumanSecurity(userId)` when an application-level
administrative transition must remove one human's runtime credentials in the
same transaction as its own authority rows. Sporades validates one existing
authenticated, non-guest human, deletes all of their Sessions, retires their
current Access keys, and returns only revocation counts. If the mutation later
throws, both runtime and application writes roll back.

Initiate this operation during the mutation handler's initial synchronous
dispatch, before its first `await`. The returned Promise may be awaited later
or left for the runtime's pending-work drain. New lifecycle calls from a
post-`await` continuation, timer, microtask, or detached Promise are denied;
this structured boundary prevents escaped context capabilities from acting as
ambient transaction authority. A
missing `await` therefore cannot let revocation continue after commit or after
the adapter closes: the Mutation waits for it, and a rejection rolls back the
whole transaction. Await it when the returned counts are part of your result.

This method is intentionally unavailable to queries, endpoints, messages,
Jobs, and unauthenticated mutations. It does not suspend or delete identity,
change application roles, or affect service/Agent credentials. The Capsule
must separately authorize its administrator, normally require a purpose-bound
reauthentication proof, update its own domain state, and record its audit event.
Use it for atomic suspension or comparable high-risk human security
transitions; do not use it as sign-out, password reset, or generic auth-table
administration.

If administrator, replay, or target checks must query application tables first,
call `ctx.serverAuth.reserveRevokeHumanSecurity(userId)` during initial dispatch,
perform those async checks, then return
`ctx.lifecycle.continue(reservation, callback)`. Reservation is write-free; the
runtime performs the revocation and then the callback atomically only when that
exact one-shot continuation is returned by the owning Mutation. Unused,
duplicated, copied, detached, cross-handler, and post-settlement reservations
cannot act. Prefer the direct API for simple flows; use the validated
continuation when authorization genuinely depends on async application state.

### Simulate Local Identities

For local browser testing, start a Dev session, then run:

```sh
sporades auth as email --email mira@example.com --display-name "Mira Vale" --json
sporades auth as email --email invited@example.com --registration '{"invitation":"invite-1"}' --json
```

To push the simulated session into a connected browser:

```sh
sporades auth clients --json
sporades auth as email --email mira@example.com --client current --json
sporades auth as email --email mira@example.com --client all --json
sporades auth as email --email mira@example.com --client client-abc123 --json
```

This is local identity simulation. It is useful for tests and development, but
it is not OAuth and does not validate third-party tokens.
`--registration` forwards a JSON object to the Capsule's Registration Admission
policy for a newly simulated local identity. The CLI rejects malformed, non-object,
or larger-than-4096-byte input before contacting Dev. Treat invitation values as
sensitive shell history and prefer short-lived development-only credentials.
Without the flag the CLI omits registration admission entirely (`undefined`);
an explicitly supplied nested JSON `null` remains `null`.

## Access-key management

`accessKeys` is the framework-neutral, Session-only browser surface for a
Capsule-owned management page. It exposes exactly `list`, `issue`, `rotate`,
`revoke`, and `delete`; Sporades derives status and effective scopes on the
server, so UI code does not reproduce lifecycle or wildcard rules.

Keep an issue or rotation secret only in transient component state:

```ts
import { accessKeys } from "sporades/client";

let page = await accessKeys.list();
let disclosedToken: string | null = null;

async function issueBotKey() {
  const result = await accessKeys.issue({
    name: "invoice-importer",
    grants: ["invoices:read"],
  });
  if (result.error) return showError(result.error);
  disclosedToken = result.data.token; // render one copy action
  page = await accessKeys.list();      // refresh safe metadata separately
}

function dismissDisclosure() {
  disclosedToken = null;
}
```

Do not put `disclosedToken` in durable browser storage, Auth state, a query
subscription, logs, or a framework-wide store. The client runtime returns it
only to the resolving `issue()` or `rotate()` call and does not cache or replay
it. If that response is lost, list the safe metadata and rotate the same key;
the original plaintext cannot be recovered. Refresh `list()` after each
mutation, and clear the disclosure when it is copied, dismissed, or the page
unmounts.

A one-shot operation whose connection closes before its reply returns
`error.code === "TRANSPORT_CLOSED"`. Sporades does not replay it: reconnect,
call `list()` to inspect the committed lifecycle revision, then rotate an issued
or rotated key to obtain fresh plaintext.

Anonymous and guest Sessions are denied. Access-key-authenticated Custom
endpoints also cannot reach this projection: owner management always requires
the browser's live linked Session, never a client-supplied owner ID or
Credential value.

## User Preferences

Use the `preferences` API from `sporades/client` for durable per-user UI and
behavior settings:

```tsx
import { onMessage, preferences } from "sporades/client";

const current = await preferences.get();
const next = await preferences.update({
  theme: "dark",
  density: "compact",
});

const unsubscribe = onMessage()
  .filter("preferences.updated")
  .subscribe((message) => {
    console.log("preferences changes", message.data.changes);
    console.log("current preferences", message.data.preferences);
  });
```

`preferences.get()` returns the current Sporades user's stored preference
object. New users start with `{}`. `preferences.update(...)` accepts a partial
JSON object, shallow-merges it into the current object, persists it in
runtime-owned storage, and returns the next value.

Preferences are keyed to the current Sporades user identity, including the
Anonymous session identity, rather than to Capsule app tables. Use this SDK for
common durable per-user settings instead of creating your own preference table,
queries, and mutations.

Because Anonymous sessions are real Sporades accounts, preferences written
before sign-up or provider sign-in move to the signed-in identity when the
current user is still Anonymous. This applies when an Anonymous user signs up
with email, signs in to an existing email account, or completes Google or
Microsoft provider sign-in.
If the signed-in account already has preferences, the Anonymous preferences are
shallow-merged over the stored signed-in preferences so the current browser's
explicit Anonymous choices win for matching keys.

Sporades only performs this preference move from an Anonymous session. Linking
additional login methods while already signed in does not copy or merge
preferences between users. Signing out resolves the client to a fresh Anonymous
session with its own preference object; signing back in restores the linked
account's stored preferences. Other connected clients for the same user receive
a `preferences.updated` message after an update, while clients for different
users keep their own preference objects. Local identity simulation through
`sporades auth as ... --client ...` also switches preference reads and writes to
the delivered simulated user.

The update notification is a convergence signal for other connected clients.
It includes `message.data.changes`, the accepted shallow update object, and
`message.data.preferences`, the full preference object after the merge. The
client that calls `preferences.update(...)` should use the returned value; other
clients for the same user can listen for `preferences.updated` and refresh their
UI from the notification data or by calling `preferences.get()`.
App code should still use app tables for domain data such as notes, projects,
memberships, and records. Preferences are for small durable UI and behavior
settings.
