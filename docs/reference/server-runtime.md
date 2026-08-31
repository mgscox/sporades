# Server Runtime Reference

Tables, queries, mutations, authorization, Server env, mail, middleware, actors, and Custom endpoints.

[Back to the feature reference index](../guide/reference.md).

## Building the Server Side

### Define Tables

Tables are declared inside `schema`:

```ts
import { Date, Json, Number, Reference, String, table } from "sporades/server";

schema: {
  projects: table({
    name: String(),
    budget: Number().default(0),
    settings: Json().default({}),
    ownerId: String(),
  }),
  tasks: table({
    projectId: Reference("projects"),
    title: String(),
    dueAt: Date(),
  }),
}
```

Every row automatically gets `id`, `createdAt`, and `updatedAt`. App code does
not set or update those fields.

Use capitalized field builders: `String()`, `Boolean()`, `Number()`, `Date()`,
`Json()`, and `Reference("tableName")`.

Fields with `.default(value)` get that value when a write omits the field. A
non-null default is also stored as a SQLite `NOT NULL DEFAULT` constraint, so
fresh tables and migrated tables enforce it the same way.

Fields without defaults are nullable at the storage and table API boundary. If
you add one to a table that already has rows, existing rows read the new field
as `null`; fresh tables use the same nullable column definition. Validate
required business fields in your mutations before calling `ctx.db`.

### Declare unique fields

Use `.unique(...)` to enforce a single-field or composite unique constraint.
It is chainable with `.acl(...)` in either order.

```ts
schema: {
  projectSlugs: table({
    teamId: String(),
    slug: String(),
    externalId: String(),
  })
    .unique("externalId")
    .unique("teamId", "slug"),
}
```

Every named field must be declared on that table. Repeating a field, or
declaring the same set of fields again in another order, is rejected while the
Capsule schema is being loaded. Constraint field order is retained for a
composite declaration; constraints themselves have deterministic schema
metadata ordering.

Unique constraints use ordinary SQL `NULL` semantics on SQLite, libSQL, and
PostgreSQL: a `NULL` in any constrained field does not conflict with another
row. A unique declaration does not make a field required; validate required
business fields separately.

Adding a new unique constraint declaration to an existing table is supported.
Sporades rebuilds it inside one Database adapter transaction, preserving every
non-conflicting row and then recording the new schema metadata. If existing
data conflicts, the migration is rolled back completely and reports only
`Unable to apply unique constraint migration.`; conflicting values and
database-engine diagnostics are not exposed. That opaque translation applies
only when the newly added constraint's row copy detects conflicting existing
data. Foreign-key failures,
unrelated unique failures, and adapter or infrastructure failures retain their
ordinary error path instead of being mislabeled as duplicate migration data.

Every failed attempt preserves the original table, all original rows, and the
prior schema metadata and hash. It leaves no temporary table or other rebuild
debris behind. The runtime chooses a bounded unique temporary table name inside
the migration transaction and checks it against the live schema. A temporary
table name collision with a valid app table leaves that table preserved and
untouched; overlapping migrations use independent internal names.

Removing, replacing, weakening, or changing the field order of an existing
constraint remains an unsupported Capsule schema change. Keep the existing
declaration, or create a separately named table and move data through ordinary
application-controlled reads and writes when that is safe.

Tables can also declare ACL rules next to their fields. ACL rules are an
invisible accept/reject authorization policy around normal `ctx.db` table
operations; app code still reads and writes through the table API instead of
calling permission helpers directly. Rules may be sync or async functions.
`read` applies to row reads. `write` is the fallback for `insert`, `update`,
and `delete` unless that operation has its own rule. Missing rules allow the
operation by default.

```ts
schema: {
  notes: table({
    body: String(),
    ownerId: String(),
  }).acl({
    read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
    write: async ({ previous, next, ctx }) => {
      const ownerId = next?.ownerId ?? previous?.ownerId;
      return ownerId === ctx.auth.userId;
    },
  }),
}
```

Read ACLs filter rows after fetch in the current implementation, so denied rows
are simply absent from query results. Write ACLs receive previous and next row
state: insert receives `previous = null`, update receives both states, and
delete receives `next = null`.

ACL rules receive a constrained `ctx.acl` context for bounded read-only policy
checks. `ctx.acl.db.get()` and `ctx.acl.db.exists()` can inspect Capsule app
tables by stable table name; they cannot access runtime-owned tables such as
auth, system metadata, logs, or raw storage tables. `ctx.acl.storage.get()` and
`ctx.acl.storage.exists()` expose stable storage metadata resources such as
`files`, resolved by File ID or absolute File path. Storage helpers return
logical File metadata such as File ID, absolute File path, owner, bucket,
status, timestamps, size, MIME type, original name, and version; they do not
expose filesystem paths, object keys, Object buckets, runtime table names, or
generated read URLs.

`ctx.acl.teams` adds read-only, explicit-Team decisions for Team-aware
Capsule rows and File metadata policies: `isMember(teamId)`,
`isAdmin(teamId)`, `hasRole(teamId, role)`, and
`hasAnyRole(teamId, roles)`. These helpers require the current linked actor
and never select a current Team, bootstrap a Team, enumerate memberships, or
expose `ctx.teams`. `hasRole` and `hasAnyRole` authorize only currently
declared application roles; inactive or undeclared assignments fail closed.
Team admins do not receive application-role authority unless the ACL checks
`isAdmin` explicitly. The role-set form accepts a non-empty set of at most 32
declared roles.

```ts
documents: table({ teamId: String(), body: String() }).acl({
  read: ({ row, ctx }) => ctx.acl.teams.hasAnyRole(row.teamId, ["author", "reviewer"]),
  write: ({ next, previous, ctx }) =>
    ctx.acl.teams.isAdmin((next ?? previous).teamId),
})
```

When an ACL denies a write, clients receive an opaque `DENIED` error rather than
policy internals. Sporades writes structured internal `acl.denied` log events
with table name, operation, declared rule, actor shape, row IDs, and non-secret
field names. `sporades doctor` may later warn about missing ACLs or
open-to-the-world data; missing ACLs are not deny-by-default today.

### Read With Queries

Queries receive `ctx` and return serializable data:

```ts
queries: {
  myProjects: query((ctx) =>
    ctx.db.projects
      .where("ownerId", ctx.auth.userId)
      .orderBy("createdAt", "desc")
      .all(),
  ),
}
```

Common table operations are:

```ts
ctx.db.projects.where("ownerId", ctx.auth.userId)
ctx.db.projects.orderBy("createdAt", "desc")
ctx.db.projects.limit(20)
ctx.db.projects.get()
ctx.db.projects.all()
```

Prefer filtering by `ctx.auth.userId` for per-user data. That keeps privacy in
the server code where it belongs.

Declared Custom queries can also receive JSON-compatible positional arguments
after `ctx`. Arguments are part of the reactive subscription identity, so use a
Custom query when a client-selected filter belongs in server code:

```ts
queries: {
  projectsForTeam: query((ctx, teamId: string, options: { archived: boolean }) =>
    ctx.db.projects
      .where("teamId", teamId)
      .where("ownerId", ctx.auth.userId)
      .all()
      .filter((project) => options.archived || !project.archived),
  ),
}
```

The runtime accepts only JSON values (no dates, functions, sparse arrays,
custom instances, cycles, or non-finite numbers) and snapshots the complete
argument array independently before handler lookup. Its canonical JSON form may
be at most 65,536 UTF-8 bytes. Runtime-owned queries, implicit table queries,
and legacy rows subscriptions remain argument-free.

### Change Data With Mutations

Mutations receive `ctx` plus the arguments passed from the client:

```ts
mutations: {
  createProject: mutation((ctx, input) => {
    const name = String(input?.name ?? "").trim();
    if (!name) {
      throw new Error("Project name is required.");
    }

    return ctx.db.projects.insert({
      name,
      ownerId: ctx.auth.userId,
      budget: 0,
      settings: {},
    });
  }),

  renameProject: mutation((ctx, id: string, nextName: string) => {
    const project = ctx.db.projects.where("ownerId", ctx.auth.userId).where("id", id).get();
    if (!project) {
      throw new Error("Project not found.");
    }

    return ctx.db.projects.update(id, { name: nextName.trim() });
  }),
}
```

Throw normal errors for user-facing failures. When an error has a `hint`
property, Sporades includes it in structured error output.

### Idempotent Inserts Against Declared Uniqueness

When a mutation may be retried or raced by another request, declare the exact
unique constraint on the table and use `insertOrIgnore` with that same field
tuple in the declared order. It atomically returns the inserted row for the
winning call, or `null` when that named constraint already has a winner:

```ts
subscriptions: table({ teamId: String(), plan: String() }).unique("teamId"),

// Inside a mutation:
const inserted = await ctx.db.subscriptions.insertOrIgnore({ teamId, plan: "pro" }, "teamId");
return inserted ?? await ctx.db.subscriptions.where("teamId", teamId).get();
```

The conflict fields must exactly equal one declared constraint; partial,
reordered, unknown, or empty targets fail before any write. `insertOrIgnore`
does not hide a conflict on another constraint, ACL denial, reference or value
validation failure, or database failure. Ordinary `insert` retains its usual
error-on-conflict behavior.

### Gate Handlers With requireAuth

Use declarative `requireAuth(handler)` when a query, mutation, Custom endpoint,
or App message must reject an Anonymous Session before Capsule middleware or
handler work begins. Use `requireUserAuth(ctx)` for a synchronous check at a
specific point inside already-admitted work:

```ts
import { capsule, endpoint, mutation, query, requireAuth, requireUserAuth } from "sporades/server";

export default capsule({
  accessKeys: {
    scopes: ["projects:read", "projects:delete"],
  },
  queries: {
    myProjects: query(requireAuth({ scopes: ["projects:read"] }, (ctx) => {
      const auth = requireUserAuth(ctx);
      return ctx.db.projects.where("ownerId", auth.userId).all();
    })),
  },
  mutations: {
    deleteAccountData: mutation(requireAuth({
      linked: true,
      credentials: ["session"],
      scopes: ["projects:delete"],
    }, (ctx) => {
      // Reject guest sessions too: require a linked (non-guest) user.
      const auth = requireUserAuth(ctx, { linked: true });
      ctx.db.projects.where("ownerId", auth.userId).all().forEach((project) => {
        ctx.db.projects.delete(project.id);
      });
    })),
  },
  endpoints: {
    profile: endpoint({ method: "GET", path: "/profile" }, requireAuth((ctx) => ({
      status: 200,
      body: { auth: ctx.auth, credential: ctx.credential },
    }))),
  },
});
```

Omitting `credentials` admits any supported credential kind; omitting `scopes`
requires no scope. Credential lists are OR requirements and scope lists are AND
requirements. A permitted Session satisfies declared scope requirements. A
guarded Custom endpoint also accepts a scoped Access key through
`Authorization: Bearer spk_1_<selector>_<verifier>` when `"access-key"` is an
allowed credential kind. Queries, mutations, App messages, and unwrapped
Custom endpoints retain their existing Session behavior; an unwrapped endpoint
owns its own `Authorization` schemes and Sporades does not interpret them.

Declare the Capsule's concrete, case-sensitive scope vocabulary once in
`capsule({ accessKeys: { scopes } })`. Declarations cannot contain `*`. A guard
may require only declared concrete scopes. Invalid, duplicate, wildcard, or
undeclared values fail Capsule registration rather than weakening admission.

Ordinary user contexts expose immutable identity and provenance separately.
For interactive work `ctx.credential` is `{ kind: "session" }`. An admitted
Access key receives the current owning user's `ctx.auth` with provider
`"access-key"` and `{ kind: "access-key", id, name }` provenance. Middleware,
table ACL, Team policy, and Capsule code therefore authorize the real owner and
can separately attribute the named API access. They may inspect these values
but cannot replace or mutate them.

### Manage Access keys

A linked, non-guest Session manages only its own keys through `ctx.accessKeys`:

```ts
mutations: {
  issueAutomationKey: mutation((ctx) => ctx.accessKeys.issue({
    name: "invoice-importer",
    grants: ["projects:read"],
    expiresAt: "2027-01-01T00:00:00.000Z",
  })),
  revokeAutomationKey: mutation((ctx, id: string) => ctx.accessKeys.revoke(id)),
  rotateAutomationKey: mutation((ctx, id: string, lifecycleRevision: number) =>
    ctx.accessKeys.rotate(id, { lifecycleRevision })),
  deleteAutomationKeyHistory: mutation((ctx, id: string) => ctx.accessKeys.delete(id)),
},
queries: {
  myAutomationKeys: query((ctx) => ctx.accessKeys.list({ status: "active" })),
},
```

`issue()` returns the complete token once. Persist it in the caller's secret
store immediately; Sporades stores only an indexed selector and verifier
digest. Later `list()` and `revoke()` results contain safe metadata, never the
token. Names are unique among an owner's current keys. Owner, name, grants, and
optional expiry are immutable; omitted grants default to `*`, meaning any
scope declared by this Capsule. Grant wildcards are matched at request time, so
`projects:*` satisfies both `projects:read` and `projects:delete`.

`rotate()` compare-and-swaps the listed `lifecycleRevision`, preserves the
key's ID, owner, name, grants, and expiry, and returns a replacement token once.
The previous token stops authenticating after rotation commits. Refresh the
list and rotate again if an issue or rotation response is lost; Sporades never
stores plaintext for replay. Revocation is irreversible and idempotent. Only a
revoked historical key may be deleted; active and expired keys continue to
reserve their names until revoked.

Password-reset confirmation retires every current key for that owner in the
same Auth transaction that changes the password and revokes Sessions. Ordinary
password changes do not retire keys. Losing linked status or deleting the
owner retires every current key in the same owner-security transaction with a
distinct cause, and a later relink cannot revive a retired credential.

Access keys cannot manage Access keys. Neither can Anonymous or guest Sessions,
Jobs, Schedules, or lifecycle hooks. A key authenticates its linked owner; it is
not a synthetic user and grants never add authority the owner lacks.

### Manage Service Users

Use a Service User when automation must be a stable actor in its own right,
rather than merely another credential owned by a human. A Service User cannot
sign in: it has no email/password, OAuth identity, browser Session, or implicit
human owner. Its Access keys resolve `ctx.auth.userKind` to `"service"` and keep
the exact named key in `ctx.credential`.

Only a Mutation running under a current linked human Session may use
`ctx.serviceUsers`. This lets the runtime commit its User/key lifecycle in the
same transaction as the Capsule's role, Team membership, and audit rows.

A transaction is a storage mechanism, not authority. Custom endpoints and
other runtime surfaces may execute transactionally, but only the Mutation
dispatcher receives the runtime-owned Service-User capability. Capsule input,
middleware, and context properties cannot mint or forward that capability.

For example:

```ts
mutations: {
  createTriageAgent: mutation(async (ctx) => {
    const issued = await ctx.serviceUsers.create({
      displayName: "Triage Agent",
      accessKey: { name: "production", grants: ["tickets:read"] },
    });
    await ctx.db.insert("Agent", { userId: issued.serviceUser.id });
    return issued; // issued.token is available exactly once, after commit
  }),
  rotateTriageAgent: mutation((ctx, userId: string, keyId: string, revision: number) =>
    ctx.serviceUsers.rotateAccessKey(userId, keyId, { lifecycleRevision: revision })),
  disableTriageAgent: mutation((ctx, userId: string) =>
    ctx.serviceUsers.disable(userId)),
},
```

`create()` always issues the initial named key atomically. Additional keys use
`issueAccessKey()`. `listAccessKeys()`, `rotateAccessKey()`, and
`revokeAccessKey()` take the stable Service User ID; rotation also compare-and-
swaps the listed lifecycle revision. `disable()` is irreversible and revokes
every current key while retaining safe identity and key metadata for historical
attribution. Plaintext is returned only by a committed create, issue, or
rotation and is never recoverable, so move it directly to an external secret
store. Mutation work is drained before commit even if Capsule code forgets to
await it. For `create()`, `issueAccessKey()`, and `rotateAccessKey()`, however,
every produced token must occur in the Mutation's returned JSON data. Returning
an aggregate from `Promise.all`, `allSettled`, `race`, or `any` works when it
contains the token; merely observing or discarding that aggregate rolls the
transaction back rather than silently committing a credential whose one-time
plaintext result was lost. Sporades canonicalizes the Mutation result exactly
once and uses that inert JSON snapshot for both this check and the public result;
stateful getters, proxies, or `toJSON` hooks cannot create a check/transport gap.
Non-secret lifecycle operations are still
drained, and any rejected operation rolls the whole Mutation back.

Service identity and scopes do not grant application authority. The Capsule
must still map the User ID to its own Team membership, role, and resource
policy; effective authority is their intersection. This explicit mapping is
the principal trade-off for avoiding fake human accounts and app-owned bearer
credential tables. Keep a human-owned Access key when the work should continue
to be attributed and authorized as that human instead.

Anonymous and guest Sessions, Access keys, Jobs, Schedules, lifecycle hooks,
Queries, App messages, and Custom endpoints cannot manage Service Users.
Existing human-owned Access keys and Session behavior are unchanged.

An explicit `ctx.privileged.run(...)` callback receives a separate
`ctx.accessKeys` projection with only `list(ownerUserId, options?)`,
`inspect(keyId)`, `revoke(keyId)`, `revokeAll(ownerUserId)`, and
`delete(keyId)`. Its summaries add only `ownerUserId`; they never expose owner
profile data or bearer credential material. It has no issue or rotation method.
The Privileged projection cannot issue, rotate, or receive bearer tokens.
Every projection call emits its own runtime-owned terminal Privileged audit
with the exact action and runtime-resolved owner/key target, in addition to the
surrounding run boundary. Capsule-supplied operation metadata cannot replace
that action audit.

Operators use the same projection through a running Capsule:

```text
sporades access-keys list --user-id <user-id> --session dev
sporades access-keys inspect <key-id> --session container
sporades access-keys revoke <key-id> --session hosted --host <alias> --subname <name> --yes
sporades access-keys revoke-all --user-id <user-id> --session hosted --host <alias> --subname <name> --yes
sporades access-keys delete <key-id> --session dev --yes
```

Dev, Container, and Hosted commands all invoke the generated Bundle action;
the CLI and Host helper do not open Auth tables or duplicate lifecycle SQL.
Action inputs and responses use per-action allowlisted schemas, bind returned
owner/key IDs to the request, and reject unknown fields. Execution source comes
from the running Capsule's trusted runtime session, not from action input.
Stopped Capsules are rejected. List and inspect need no confirmation. Revoke
and delete prompt unless `--yes` is present; bulk revocation requires the exact
owner ID at the prompt or `--yes`. `--json` never implies consent.

Bearer parsing is strict and applies only to guarded Custom endpoints. Invalid,
malformed, expired, revoked, dual Session-plus-Bearer, or owner-ineligible
credentials fail as opaque HTTP `401` responses without fallback. A valid key
with a disallowed credential kind or insufficient scope fails as opaque `403`.
Access-key failures carry a Bearer challenge where applicable and `no-store`;
successful key-authenticated responses default to `private, no-store`.
Credential lookup and scope admission finish before Capsule work opens its
database transaction. The admitted Auth and Credential snapshot then remains
stable for that work. Approximate `lastUsedAt` telemetry is attempted outside
the work transaction at most once per key per runtime process per hour, and a
telemetry failure cannot fail admitted Capsule work.

Runtime denial/failure events and `ctx.log` entries produced after successful
Access-key admission carry reserved actor and Credential attribution. Capsule
log data cannot replace the admitted key ID or name. Lifecycle audit events
record the operation, execution source, outcome, stable owner/key IDs, and
issuance grants without recording token material.

On success `requireUserAuth(ctx)` returns the context's `AuthContext`, so
`userId` and profile fields remain available without copying `ctx.auth`. On
failure it throws a structured auth error with the stable `UNAUTHENTICATED`
code:

```json
{ "ok": false, "error": { "code": "UNAUTHENTICATED", "message": "Unauthenticated.", "hint": "Sign in and retry the request." } }
```

Custom endpoints reply with HTTP `401` and the same structured error body.
Clients can route users to sign-in on the `UNAUTHENTICATED` code alone.

`requireUserAuth(ctx, { linked: true })` additionally requires a linked,
non-guest user. The older inline spelling `requireAuth(ctx, { linked: true })`
remains indefinitely compatible, but is deprecated by name so it is not
confused with declarative credential admission.

The public denial text stays opaque about server internals. Each denial also
emits a structured `auth.denied` platform log entry with diagnostic context
(handler kind, required auth level, and actor auth state) — inspect it with
`sporades logs --json`.

### Use Sealed Server Env

A Sealed Server Environment uses public/private keys to encrypt environment
variables, reducing exposure risk when copying data to and from a Host server.
It does not require any local keychain or secure storage, and is almost
transparent to development operations once enabled.

#### Create and Import Values

Use Sealed Server env for server-only values:

```sh
sporades env init
```

To migrate existing plaintext values, put them in `.env.sporades.server` and
import them:

```text
OPENAI_API_KEY=sk-...
STRIPE_WEBHOOK_SECRET=whsec_...
```

```sh
sporades env import --file .env.sporades.server
sporades env status --json
```

Set or replace one value without putting it in an argument or temporary file:

```sh
printf '%s' "$OPENAI_API_KEY" | sporades env set OPENAI_API_KEY --stdin
```

`env set` removes one final LF or CRLF normally added by line-oriented input,
then preserves and re-seals every other existing value. If no sealed envelope
exists yet, it preserves values from `.env.sporades.server` while creating the
sealed envelope. It never prints the value.

Test for a key without decrypting or printing it:

```sh
if sporades env has OPENAI_API_KEY; then
  echo "OpenAI is configured"
fi
```

`env has` exits `0` when the key is defined and `1` when it is absent. With
`--json`, it emits `{ "name": "...", "defined": true|false }` inside the
standard result envelope and keeps the same exit-status contract.

#### Read Values in Server Code

Read them from `ctx.env`:

```ts
endpoint({ method: "POST", path: "/billing/webhook" }, (ctx) => {
  const secret = ctx.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw Object.assign(new Error("Billing is not configured."), {
      hint: "Import STRIPE_WEBHOOK_SECRET with `sporades env import`.",
    });
  }
});
```

Restart a running Dev session after importing or setting Sealed Server env.

#### Export or Import an Envelope

For portability, export the sealed envelope without private keys or plaintext
values:

```sh
sporades env export --output sealed-server-env.json --json
```

Import an exported sealed envelope explicitly with:

```sh
sporades env import --sealed --file sealed-server-env.json --json
```

#### Push to a Hosted Capsule

For Hosted Capsules, the Host server owns a per-Capsule Sealed Server env
keypair. The CLI reads only the Hosted Capsule public key and fingerprint,
re-encrypts local source values to that public key, and pushes only the sealed
envelope.

```sh
sporades host push --host personal --subname team-notes --json
```

`sporades host push` decrypts the local Sealed Server env with the local
private key, re-encrypts the values to the Hosted Capsule's current Host public
key, and includes `.sporades/sealed-server-env/server-env.sealed.json` in the
release archive. The release archive is copied to the Host server over SSH/SCP
and installed under the Hosted Capsule's immutable `releases/<release-id>/`
directory.

Sporades stores local sealed material under `.sporades/sealed-server-env/`,
which is ignored Runtime state. Host private keys stay in Host-owned
`data/sealed-server-env/keys/` state and are mounted read-only when a release
needs the matching fingerprint. Host private keys never leave the Host server,
plaintext values never cross the local-to-Host boundary, and exported sealed
envelopes never include private keys.

`sporades env reencrypt --host personal --subname team-notes --json` is still
available for explicit inspection and CI preparation. It uses the same
public-key-only Host model and does not print plaintext values or private keys.

#### Recover from Lost Keys

Because those files do not live in the repository, a different developer machine
or Host server may not have access to them (or they may be lost if local
checkout or Host storage is deleted). Sporades creates keypairs automatically,
but a new keypair cannot decrypt envelopes written for an old one.

Recovery is achieved by re-sealing known values:

- If local sealed key material is lost but you still have `.env.sporades.server`
  or another source of truth for the values, run `sporades env import` again.
- If Host private key material is lost, old Host-encrypted envelopes are
  unrecoverable without that private key. Run `sporades host rotate-key`, then
  push a release re-sealed from local Sealed Server env, legacy Server env
  imported explicitly, or another source-of-truth value store.
- If all private keys and all plaintext/source-of-truth values are gone, the
  sealed values cannot be recovered. Regenerate the real provider secrets, add
  them back to Server env, import, and push a new Host-encrypted release.

### Use the Stripe payment boundary

The built-in Stripe payment boundary starts dormant in every blank Capsule and
receives no provider authority until complete activation.

The blank template imports `createStripePaymentIntegration` from the separate
server-only export:

```ts
import { createStripePaymentIntegration } from "sporades/server/stripe";

const stripe = createStripePaymentIntegration({ enabled: false });
const result = await stripe.createCheckoutSession({});
// result.error.code === "STRIPE_PAYMENTS_DISABLED"
```

The boundary exposes only `createCheckoutSession`,
`createCustomerPortalSession`, and `verifyWebhookEvent`. It does not expose a
generic provider request function or the underlying Stripe client. While
disabled, every operation returns a stable `STRIPE_PAYMENTS_DISABLED` result
with an activation hint, performs no provider request, and receives no payment
authority.

Complete `enabled: true` options contain the validated project configuration,
the runtime's Sealed Server env view, and the durable Job AbortSignal. The
enabled `createCheckoutSession` accepts only an explicit server-owned `payment`
or `subscription` mode, server-owned Price ID, bounded quantity, trusted
same-origin return paths, stable business idempotency key, and opaque business
reference. Both modes use the same provider operation and durable Job; there is
no parallel subscription transport. It returns only
`{ ok: true, sessionId, url }` after validating Stripe's matching mode,
account mode, Session identity, and exact `https://checkout.stripe.com` host.
Transient failures are retryable by the durable Job; permanent rejection and
invalid responses are bounded, redacted, and non-retryable. Customer Portal
uses the same narrow pattern: enabled `createCustomerPortalSession` accepts only
an existing Capsule-authorized Customer ID, a trusted same-origin return path,
and a stable idempotency key. It calls only Stripe's Portal Session operation
and returns `{ ok: true, sessionId, url }` after binding the response to the
requested Customer, configured account mode and return URL, and validating the
exact `https://billing.stripe.com/p/session/...` authority. Provider timeouts,
cancellation, retries, permanent rejection, and malformed responses follow the
same bounded and redacted Job policy.

Enabled `verifyWebhookEvent` accepts only an exact `Uint8Array` body copy and
the unmodified `Stripe-Signature` header. The official Stripe verifier checks
the signature and its five-minute timestamp tolerance before JSON parsing. A
successful call returns one frozen `VerifiedStripeEvent` containing provider
Event identity, type, provider creation time, live/test mode, relevant object
identity, and the verified raw provider value. Rejection is always the same
bounded `STRIPE_WEBHOOK_REJECTED` error; provider diagnostics, expected
signatures, payloads, and secrets are not exposed.

The official server Stripe SDK is a Sporades dependency and is not copied into
generated projects or browser Bundles. The real server Bundle inlines it. Keep
provider credentials in Sealed Server env and provider identities in
Capsule-owned server code. Complete activation registers one runtime-owned POST
callback route outside reserved `__sporades` namespaces. It admits every valid
Stripe Event identity into one transaction-owned `_sporades.stripe-event` Job
under the userless Privileged actor and acknowledges only after commit. Duplicate
and concurrent delivery converges on the same Job. The Job payload is not shown
by routine Job inspection, and admission creates no app billing records.
Capsule code cannot enqueue the reserved handler by name, including from
`ctx.privileged.run(...)`; only the active verified callback context receives
the runtime-owned enqueue capability.

Declare the Capsule's single Stripe event handler with the normal server
authoring API; do not define or shadow the provider HTTP route:

```ts
import { capsule, stripeEvent } from "sporades/server";

export default capsule({
  name: "Billing-aware Capsule",
  stripeEvents: stripeEvent(async (ctx, event) => {
    switch (event.type) {
      case "checkout.session.completed":
        // Apply idempotent, order-independent Capsule policy through ctx.db.
        return;
      default:
        // Unknown verified types remain safe to ignore.
        return;
    }
  }),
});
```

The Stripe event handler runs only from the durable runtime-owned Job under the
userless Privileged server role. Every attempt emits the existing `started`,
then `completed` or `errored`, then `finished` audit lifecycle. Thrown failures
follow the Job's bounded retry policy under the same identity; committed
cancellation reaches `ctx.signal`, and callback-scoped Privileged APIs fail once
the attempt settles or aborts. No current user or Team membership is invented.

When one Event must update several app records as one consequence, opt into the
atomic form:

```ts
stripeEvents: stripeEvent({ consequence: "atomic" }, async (ctx, event) => {
  await ctx.db.providerObservations.insert({ providerEventId: event.providerEventId });
  await ctx.db.subscriptions.update(/* Capsule-owned correlation and policy */);
  await ctx.jobs.enqueue("notifyBillingHolder", { providerEventId: event.providerEventId });
})
```

Sporades acquires one per-Capsule Stripe-consequence fence before the first app
read and commits or rolls back the callback's app writes, logs, and Job enqueues
together. Enqueued Jobs are dispatched only after commit. This narrow context
has no provider, mail, File, message, auth-management, Schedule, Access-key,
Team directory, Team-management, or nested Privileged API. Its only Team
surface is `teams.countMembers(teamId)`, which returns `{ totalCount }` for an
existing explicit Team through the same transaction and exposes no member
identities. It is for bounded database
consequences. A 30-second runtime watchdog revokes database and Job authority,
rolls back the attempt, and releases the per-Capsule fence if handler code does
not settle cooperatively; late handler work cannot commit. Keep long-lived
cooperative handlers on the legacy declaration.
Adapter-level fence contention is durably delayed without spending one of the
reserved Stripe Job's delivery attempts, so a valid predecessor cannot exhaust
a following Event merely by holding the serialization lane. Cancellation and
claim ownership still win before the delayed claim is returned.
Delivery remains at least once, so app policy still owns Event idempotency and
equal-time or stale-event decisions.

The handler receives the same bounded `VerifiedStripeEvent` contract returned
by verification. Its `raw` provider value is forward-compatible but sensitive;
do not log or persist it by default. Sporades creates no subscription,
entitlement, invoice, access, Customer, Team, order, export, erasure, or
retention record automatically. Capsule writes use the ordinary Database
adapter and Privileged semantics. Duplicate provider delivery converges on the
completed Job, unknown event types may be ignored, and policy must reject stale
later-arriving observations rather than trusting callback order. Operator Job
inspection omits the payload and does not expose raw provider history.

### Send SMTP mail

`ctx.mail.send(...)` accepts one provider-independent message with `to`,
optional `cc`, `bcc`, `from`, and `replyTo`, plus `subject`, `textBody` and/or
`htmlBody`, and an optional validated `provider` object. It returns a stable
`{ messageId, accepted, rejected }` result. When `mail.smtp` is omitted from
`sporades.json`, calls fail with `MAIL_DISABLED`.

The same Server Bundle and configuration run unchanged in Dev sessions, local
Container sessions, and Hosted Capsules. Credential values remain in Sealed
Server env; configuration stores only their key names. Connection and socket
timeouts are bounded, certificate verification is enabled by default, and
runtime shutdown closes active SMTP sockets.

Postmark and Mailgun fields become their documented, validated SMTP MIME
headers. SMTP2GO and other portable vendors use validated custom `X-*` headers.
The `provider` object is not an arbitrary vendor API payload and cannot alter
addressing, MIME content, credentials, or transport behavior. No provider SDK
is used. See [SMTP configuration and provider examples](../guide/configuration.md#smtp-mail).

Delivery logs contain only the vendor, recipient counts, latency, a stable
result category, and an opaque per-attempt mail identity. They exclude
addresses, subjects, bodies, provider values, provider message IDs,
credentials, Server env, and raw authentication.

Direct SMTP delivery is external and cannot roll back with a failed database
Transaction. Use a [durable mail Job](../guide/configuration.md#durable-mail-with-jobs)
for important notifications, and design application-level idempotency for the
Job Queue's at-least-once execution.

### Add Middleware

Use middleware when multiple handlers need the same derived context or guard:

```ts
export default capsule({
  middleware: [
    (ctx) => ({ ...ctx, tenant: ctx.env.TENANT }),
    (ctx) => {
      if (!ctx.tenant) {
        throw Object.assign(new Error("Missing tenant."), {
          hint: "Import TENANT with `sporades env import`.",
        });
      }
      return ctx;
    },
  ],
});
```

Middleware runs for queries, mutations, endpoints, and app messages.

Query, mutation, endpoint, message, middleware, and mutation hook handlers may
return Promises. Sporades awaits them before sending WebSocket results, writing
HTTP endpoint responses, committing mutation transactions, or refreshing query
subscriptions.

### Choosing a server actor

Most server handlers should use the current user from `ctx.auth`. That identity
is the live Sporades session behind the request or App message, including
Anonymous sessions before sign-up. Use it for ordinary per-user reads, writes,
file ownership, and authorization checks.

The Job Queue uses the bounded Auth and Credential snapshot captured when
enqueue commits for background work that should stay accountable to the user
and named access method that authorized it after the original request ends.
Retries and child Jobs preserve that historical attribution even after key or
owner lifecycle changes; current ACL and Team state still decides resource
authority. That is different from system-owned work.

Use the Privileged server role only for trusted userless work that must run
inside the Capsule without pretending to be a Sporades user:

```ts
mutations: {
  repairIndex: mutation(async (ctx) => {
    return await ctx.privileged.run({
      operation: "search.repairIndex",
      targetResourceKind: "capsule-db",
      metadata: { source: "operator-action" },
    }, async (privilegedCtx) => {
      const rows = privilegedCtx.db.documents.all();
      return { repaired: rows.length };
    });
  }),
}
```

`ctx.privileged.run(...)` is available only in trusted server contexts: queries,
mutations, Custom endpoints, App messages, context middleware, and supported
mutation hooks. The derived `privilegedCtx` exposes `auth.userId` as
`"__privileged__"`, carries `privilegedCtx.signal`, and may use approved
Capsule DB and File operations through the normal runtime boundaries.

Privileged server role is not a Capsule role, app admin, Team, user, session,
service account, or browser credential. It does not make downstream middleware
or handlers privileged, and leaked derived contexts become ineffective after the
callback finishes. Table ACL rules and `sporades/client` cannot call it.

Every privileged run emits Privileged audit events with `started`, `completed`
or `errored`, and `finished` outcomes. If the signal is already aborted, the
callback does not run and the runtime reports `Privileged run aborted`.

Jobs may also execute as the Privileged server role when trusted server code
explicitly enqueues system-owned work. That does not turn the Job into a Capsule
role, app admin, user session, or browser authority; the Job records its
Privileged server role actor separately from who enqueued it.

## Custom HTTP Endpoints

Most app behavior should use queries and mutations. Use endpoints for HTTP
integrations such as webhooks:

```ts
import { capsule, endpoint } from "sporades/server";

export default capsule({
  endpoints: {
    webhook: endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => {
      const signatureInput = ctx.request.bodyBytes.toUint8Array();
      ctx.log.info("Webhook received", {
        path: ctx.request.path,
        byteLength: ctx.request.bodyBytes.byteLength,
      });

      return {
        status: 202,
        headers: { "x-sporades-endpoint": "accepted" },
        body: {
          received: true,
          userId: ctx.auth.userId,
        },
      };
    }),
  },
});
```

Endpoint context includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.log`,
`ctx.messages`, and `ctx.request`. `ctx.request` contains method, path, headers,
query parameters, parsed `body` data, and immutable exact `bodyBytes`.

Both body representations come from the same bounded request-body read.
`bodyBytes` preserves the bytes exactly as received, so JSON whitespace and key
ordering remain available for signed-webhook verification even though `body`
contains the parsed value. The byte view is iterable and supports `at()`;
`toUint8Array()` returns a mutable copy without exposing runtime-owned storage.
Exact bytes are server-only and never automatically logged or added to HTTP
errors, CLI output, or client transport results. Do not log the copy merely
because an integration library accepts it.
