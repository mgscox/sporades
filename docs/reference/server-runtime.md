# Server Runtime Reference

Tables, queries, mutations, authorization, Server env, mail, middleware, actors, and Custom endpoints.

[Back to the feature reference index](../guide/reference.md).

## HTTP request admission

A deployer-owned `admissionPolicy.path` can deny one canonical exact HTTP pathname
before Capsule auth, File routes, endpoint middleware/handlers or public assets.
Exact-path and trusted Hosted address/CIDR rules support denial and per-process
fixed-window quotas. The first matching enabled rule decides. A denial returns
an opaque `403` with
`Cache-Control: no-store` and constant `Forbidden\n` bytes; the request invokes no
Capsule code. Genuine authenticated runtime-health and connection-token controls
stay outside admission, and policy validation rejects their reserved targets.

See the [policy contract](projects-and-configuration.md#request-admission-policy-publication)
for trusted identity, opaque `429`/`Retry-After`, bounded eviction diagnostics,
compatible reloads, canonicalization, hot generations and the
measured no-policy latency budget. No declaration preserves existing routing.

## Capsule rate limits

Every Capsule handler context (`ctx` in queries, mutations, endpoints, and
Jobs) exposes synchronous `ctx.rateLimit(key, { limit, windowMs })`.
Capsule-principal [File ingress admission](./files-and-realtime.md#charging-a-signed-resource-before-staging)
exposes the same method during its active callback and signal lifetime. Calls
with the same key and parameter tuple share a counter across admission and
those handler types in one runtime:

```ts
const admission = ctx.rateLimit("password-reset", {
  limit: 5,
  windowMs: 15 * 60_000,
});
if (!admission.ok) {
  return {
    status: 429,
    body: { error: "RATE_LIMITED", retryAfterMs: admission.retryAfterMs },
  };
}
```

The result is `{ ok: boolean, retryAfterMs: number }`. Allowed calls return
`retryAfterMs: 0`; denied calls return the ceiling of the remaining window in
milliseconds. A fixed window begins at the first call for a bucket. Denied
attempts count up to the limit and then saturate. Keys must be non-empty and
at most 1024 UTF-8 bytes. `limit` and `windowMs` must be positive safe integers,
`limit` must be below `Number.MAX_SAFE_INTEGER`, and `windowMs` cannot exceed
24 hours.

The in-memory table is shared by handlers and Capsule-principal File ingress
admission in a runtime and holds at
most 10,000 buckets with deterministic least-recently-used eviction. Its
counters are separate from HTTP request admission and authentication's
existing email and Session counters. Transaction rollback does not refund a
rate-limit attempt. Restart resets the table; limits are per process and can
allow bursts at window boundaries. High key churn can evict live buckets.

Custom endpoint contexts may include readonly `ctx.request.clientAddress`.
This address is present only when the request crossed the trusted Hosted Caddy
boundary. Queries and mutations expose the same connection address as readonly
`ctx.auth.clientAddress`. Both values are `undefined` in Dev and Container
sessions. Public `X-Forwarded-For`, `X-Real-IP`, and `CF-Connecting-IP` headers
do not establish trust; no additional trusted-proxy configuration is introduced.
Jobs do not inherit an endpoint's request address.

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

For server-owned tables, import `acl` from `sporades/server` and opt into
`.acl(acl.privilegedOnly())`; `acl.denyAll()` is an alias. Both return read
and write deny rules, covering insert, update, and delete through the existing
write fallback. Ordinary reads return no rows (`get()` returns `null`) and
writes fail with opaque `DENIED` errors. Existing tables without ACL rules keep
their allow-by-default behavior in 0.9.x.

```ts
import { acl, String, table } from "sporades/server";

const appSecrets = table({ key: String(), value: String() })
  .acl(acl.privilegedOnly());
```

Trusted server code accesses these rows inside an explicit audited
`ctx.privileged.run({ operation: "secrets.load", targetResourceKind: "capsule-db" },
privilegedCtx => privilegedCtx.db.appSecrets.all())` callback. The helper grants
no Privileged authority. Keep authorization and returned data under server
control: returning secret rows from a query or endpoint still exposes them.
Privileged table handles expire when the callback ends.

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
generated read URLs. These helper reads may resolve synchronously on SQLite or
asynchronously on remote database engines; portable ACL rules should be
`async` and `await` every helper result. A synchronous rule that starts an
asynchronous helper read without returning or awaiting it is denied fail-closed.

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
  read: async ({ row, ctx }) => await ctx.acl.teams.hasAnyRole(row.teamId, ["author", "reviewer"]),
  write: async ({ next, previous, ctx }) =>
    await ctx.acl.teams.isAdmin((next ?? previous).teamId),
})
```

When an ACL denies a write, clients receive an opaque `DENIED` error rather than
policy internals. Sporades writes structured internal `acl.denied` log events
with table name, operation, declared rule, actor shape, row IDs, and non-secret
field names. `sporades doctor` names tables with missing ACL rules and lists
every table with no declared rules (including `.acl({})`) as allow-all. It
suggests `acl.privilegedOnly()` for server-owned data. Doctor inspects declarations
without executing policy functions; a complete declaration that always returns
`true` still passes this structural check. Missing ACLs are not deny-by-default
today.

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

Await terminal table operations (`get`, `all`, `insert`, `insertOrIgnore`,
`update`, and `delete`) before using their results. They can return a Promise
on any adapter, including SQLite while another transaction owns the connection.
Returning an operation directly from a handler also lets the runtime await it.
The shipped `TableApi` types describe these results as `MaybePromise<T>`.

```ts
const projects = await ctx.db.projects.all();
return projects.map(project => project.name);
```

Keep reads inside their handler's lifetime. A read whose context expires while
waiting for storage or an asynchronous ACL rejects with opaque `DENIED` instead
of exposing rows. The runtime observes discarded read rejections so they cannot
trigger a fatal restart; discarding a Promise still cannot produce a usable
synchronous result. Awaiting a live read preserves its ACL result or rejection.

Prefer filtering by `ctx.auth.userId` for per-user data. That keeps privacy in
the server code where it belongs.

Declared Custom queries can also receive JSON-compatible positional arguments
after `ctx`. Arguments are part of the reactive subscription identity, so use a
Custom query when a client-selected filter belongs in server code:

```ts
queries: {
  projectsForTeam: query(async (ctx, teamId: string, options: { archived: boolean }) =>
    (await ctx.db.projects
      .where("teamId", teamId)
      .where("ownerId", ctx.auth.userId)
      .all())
      .filter((project) => options.archived || !project.archived),
  ),
}
```

The runtime accepts only JSON values (no dates, functions, sparse arrays,
custom instances, cycles, or non-finite numbers) and snapshots the complete
argument array independently before handler lookup. Its canonical JSON form may
be at most 65,536 UTF-8 bytes. Runtime-owned queries, implicit table queries,
and legacy rows subscriptions remain argument-free.

Subscribed queries re-run after a mutation that writes and after a Job
finishes. On SQLite, Postgres and libsql, the runtime re-runs only the subscriptions whose last run
read a table written since the previous refresh; a statement whose table it
cannot identify re-runs every subscription, and a subscription whose last run
failed re-runs on every refresh. A query result that depends on the
clock or other state outside the database therefore does not update on
unrelated writes. Transaction statements are tracked too; rolled-back writes
may cause an extra refresh. Dedicated Postgres resource transactions retain their
changed tables until settlement and then publish them, including on rollback or
an unknown commit outcome. A concurrent refresh before commit cannot consume
the notification for the committed writes. Recognized single-table statements that
report zero changed rows do not refresh subscriptions. Multi-statement and
unparseable writes conservatively refresh every subscription even if their final
result reports zero rows: earlier statements or a data-modifying CTE may have
committed writes. Rejected Postgres and libsql prepared writes also retain
conservative invalidation: a batch can commit before a later statement rejects,
or a remote write can commit before its HTTP acknowledgement is lost.
The original error still propagates. libsql resource transactions remain unsupported.

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

### Opt Out of Implicit Table Mutations

Besides the names declared under `mutations`, the runtime answers undeclared
mutation names that describe a table. `addNote` inserts a row into `notes`: the
`ownerId` field becomes the caller's identity, a `text` field takes the first
argument, the remaining fields take positional arguments in declaration order or
their declared defaults, and the insert still runs the table's `insert` ACL
rule. `updateNoteText` updates one row's `text` field (`update<Table><Field>`):
on a table with an `ownerId` field only the caller's own row is touched, and the
table's `update` ACL rule still applies. These implicit entries answer
`{ ok: true, error: null }` without row data and are the 0.9.x compatibility
surface. They stay enabled unless the Capsule opts out:

```ts
export default capsule({
  implicitMutations: false,
  // ...
});
```

With `implicitMutations: false`, every mutation name without a declared handler
answers the ordinary `Unknown mutation: <name>` result — the same bounded
refusal the runtime gives a name it cannot resolve at all — before context
middleware runs, before the transaction opens, before any fallback write, before
before- and after-mutation hooks, and before anything that depends on a
successful write, including the deferred query rebroadcast. Undeclared names
therefore leave no write, no hook effect, and no success notification behind.

Omitting the flag or passing `true` keeps that 0.9.x surface unchanged; `false`
retires only the dispatch surface. Nothing else moves: declared mutations keep
their context middleware, hooks, table ACLs, reauthentication and transaction
behavior; a declared handler preserves `false`, `0`, and `""` results, returns a
null data payload for `null` or `undefined`, and never falls back to an implicit
write; a declared name that
resembles an `add…`/`update…` fallback name runs the declared handler; server
code keeps `ctx.db`; and implicit table queries keep answering. One detail
shifts: a bundled declared mutation whose source matches the generated scaffold
`add…` body — the shape older `sporades create` emitted — normally travels
through the implicit path while that surface is enabled, and travels as the
declaration it is once the Capsule opts out.

Present values must be booleans; anything else — including `"false"` and `null`
— fails at authoring and at Capsule startup (`INVALID_IMPLICIT_MUTATIONS`)
rather than half-applying at runtime. The flag bounds mutation dispatch only.
It is not a substitute for declaring a check: place business rules inside
declared mutations, in table ACL rules, or in a before-mutation hook, all of
which still see every declared write. It changes nothing about queries —
implicit table queries remain available — and there is no per-table switch.

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
    }, async (ctx) => {
      // Reject guest sessions too: require a linked (non-guest) user.
      const auth = requireUserAuth(ctx, { linked: true });
      for (const project of await ctx.db.projects.where("ownerId", auth.userId).all()) {
        await ctx.db.projects.delete(project.id);
      }
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
allowed credential kind. Queries, mutations, App messages, and ordinary Custom
endpoints retain their existing Session behavior; an unwrapped endpoint owns
its own `Authorization` schemes and Sporades does not interpret them.

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
same Auth transaction that changes the password and revokes Sessions. Trusted
`setEmailPassword` writes do not retire keys. Native browser password
changes and `serverAuth.reserveChangeEmailPassword` retire all current human
Access keys, Sessions, purpose proofs and outstanding Reset codes atomically.
The reservation also supports app outbox and Job staging in its enclosing
Mutation through `ctx.lifecycle.continue`; see [atomic password changes](client-auth-and-preferences.md#atomic-capsule-password-change-and-outbox).
Losing linked status or deleting the
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
Service-User lifecycle work must also be initiated during the Mutation
handler's initial synchronous dispatch, before its first `await`. Its returned
Promise remains awaitable and transaction-drained, but timers, microtasks,
detached Promises, and post-`await` continuations cannot start new lifecycle
operations through a retained context reference.
Existing human-owned Access keys and Session behavior are unchanged.

When application authorization or idempotency checks require database reads
before lifecycle work, reserve the write-free operation during initial dispatch
and return a validated continuation after those checks:

```ts
const operation = ctx.serviceUsers.reserveDisable(userId);
const membership = await ctx.db.agentMemberships.where("userId", userId).first();
if (!membership || !mayAdminister(ctx.auth.userId, membership)) throw new Error("Denied");
return ctx.lifecycle.continue(operation, async (disabled) => {
  await ctx.db.agentMemberships.update(membership.id, { status: "removed" });
  return disabled;
});
```

Reservations are opaque, write-free, one-shot, and bound to the owning Mutation
transaction. Only the exact continuation returned by that Mutation is adopted;
copies, unused or duplicate reservations, detached callbacks, other handlers,
and calls after settlement cannot execute them. An array declares multiple
approved lifecycle operations explicitly and any failure rolls all of them
back. Operations execute sequentially in declared order, so a later operation
observes every earlier lifecycle transition rather than racing it. Sporades canonicalizes reservation arguments immediately, so later
mutation of caller-owned objects or arrays cannot retarget the operation, and
the frozen public facades cannot be replaced. The TypeScript type uses a private
required unique-symbol brand for compile-time opacity; the runtime still
validates exact WeakMap identity rather than trusting types. This costs a little ceremony but
allows async application validation without reopening ambient authority.

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

Declare required key names with [`env.required` in sporades.json](./projects-and-configuration.md#required-server-env).
This opts doctor and Host push into presence checks. Boot logs one names-only
error for missing keys; `env.failClosed: true` refuses startup.

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

`ctx.env` exists only in trusted server code. No runtime-owned query, App
message or browser API returns it, and a client request for an undeclared
query name such as `ctx.env` receives the ordinary unknown-query error with no
environment data. A Capsule that needs a browser to know about configuration
declares its own query and returns only a bounded, non-secret value through the
normal declaration, authorization and result contract.

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
`htmlBody`, an optional `autoSubmitted: "no" | "auto-generated" | "auto-replied"`,
and an optional validated `provider` object. `autoSubmitted` emits exactly one
standard `Auto-Submitted` header for every SMTP vendor; omission emits none.
Invalid values and attempts to supply the standard header through
`provider.headers` fail before transport handoff. See
[automated responses](../guide/mail.md#automated-responses). It returns a stable
`{ messageId, accepted, rejected }` result. Delivery is partial by recipient:
an address the server rejects at RCPT is returned in `rejected` while the
message still reaches every address in `accepted`. The call fails only when no
recipient was accepted or the conversation itself failed, with `MAIL_REJECTED`
when every rejection was definitive (5xx) and `MAIL_CONNECTION_FAILED` when any
was transient (4xx greylisting, rate limiting, temporary unavailability), which
a later attempt may still deliver. When `mail.smtp` is omitted from
`sporades.json`, calls fail with `MAIL_DISABLED`. When `mail.smtp` is configured
but its named credentials are absent from Server env, the Capsule still starts,
`ctx.mail.enabled` is `false`, and calls fail with `MAIL_CREDENTIAL_MISSING`;
neither failure names a Server env key.

::: v-pre

`sporades/server` exports `escapeHtml(value)` and the `html` tagged template for
HTML text and quoted attributes. Nested `Html` fragments and joined arrays
compose safely; `html.raw(trusted)` explicitly bypasses escaping. `htmlBody`
accepts either a string or an `Html` fragment. Custom password-reset bodies
support `{{link}}` and `{{expiresAt}}`, with HTML-escaped substitution and a
redacted warning for custom bodies missing `{{link}}`. See
[HTML-safe mail bodies](../guide/mail.md#html-safe-mail-bodies) and
[custom password-reset bodies](../guide/mail.md#custom-password-reset-bodies).

:::

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

### Call an OpenAI-compatible model

`ctx.ai.chat(input)` sends one provider-neutral request to the endpoint declared
by `sporades.json` `ai` (Chat Completions by default, or the Responses API with
`store: false`). Input is `{ messages, system?, maxTokens?, timeoutMs?, temperature?, jsonSchema?, provider?, signal? }`;
`messages` holds 1–64 `user`/`assistant` turns, `timeoutMs` defaults to 2000 and
is bounded to 100–30000, and `provider: { api?, baseUrl?, model?, apiKey? }`
overrides the project settings for one call. Overrides work even when `ai` is
undeclared or `enabled: false`; values a call omits fall back to whatever `ai`
declares, and a call with no override leaves a disabled or undeclared project
dormant. The project key is sent only to the project base URL, so a call to any
other base URL must pass its own `apiKey` or it resolves `AI_UNCONFIGURED`.

The call never throws and never retries. It resolves
`{ ok: true, text, json?, usage: { inputTokens, outputTokens, totalTokens }, model }`
or `{ ok: false, code, message, status? }` with `AI_UNCONFIGURED`,
`AI_INVALID_REQUEST`, `AI_TIMEOUT`, `AI_ABORTED`, `AI_UPSTREAM_ERROR` (`status`
for non-2xx answers) or `AI_INVALID_RESPONSE`. `json` is present for
`jsonSchema` calls and is parsed, not schema-validated. When the key named by
`ai.keyEnv` is unset the Capsule still starts, `ctx.ai.enabled` is `false`, and
calls resolve `AI_UNCONFIGURED`; the key is not a required Server env key.

Requests use `redirect: "error"`, read at most 1 MiB of response, and discard
provider error bodies. Prompt and response content never reaches logs: each
call emits one `ai.call` metering event with api, model, outcome, optional
status, `usage.input`/`usage.output`/`usage.total` token counts, and latency.
A model call is external and cannot roll back with a failed mutation. See the
[AI checks guide](../guide/ai.md).

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

For example, delete a File as that actor without round-tripping through the
browser:

```ts
const deletedFile = await ctx.files.delete(fileReference);
```

This returns deleted File metadata directly and applies ownership or a declared
`files.acl.delete` rule using the frozen `ctx.auth` and `ctx.credential`
snapshot admitted when the handler context was created. Replacing either
context property cannot change that actor. Userless lifecycle hooks cannot call
this operation by synthesizing Session provenance; use an explicit audited
privileged File operation for intentional maintenance.

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
mutations, ordinary Custom endpoints, App messages, context middleware, and
supported mutation hooks. The derived `privilegedCtx` exposes `auth.userId` as
`"__privileged__"`, carries `privilegedCtx.signal`, and may use approved
Capsule DB and File operations through the normal runtime boundaries.

Privileged File deletion is deliberately explicit:

```ts
const result = await privilegedCtx.files.delete(fileReference);
if (result.ok) console.log(result.data.file.id);
```

Unlike `ctx.files.delete(...)`, this userless operation can delete any exact
live Capsule File without applying current-user ownership or
`files.acl.delete`. Use it only when that bypass is intended and auditable.

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

Endpoint handlers also receive user-scoped `ctx.files.delete(fileReference)`.
It coexists with multipart `claim`/`inspection`/`status` and declared
`attachment` methods without widening those separate authority boundaries.

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

Ordinary endpoint context includes `ctx.db`, `ctx.auth`, `ctx.env`, `ctx.services`, `ctx.log`,
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

### Explicitly sessionless public endpoints

For a stateless public probe, opt in with `session: "none"`:

```ts
import { capsule, endpoint } from "sporades/server";

export default capsule({
  name: "status",
  endpoints: {
    health: endpoint({ method: "GET", path: "/health", session: "none" }, () => ({
      status: 200,
      body: { ok: true },
    })),
  },
});
```

Omitting `session` preserves ordinary endpoint behavior, including creating an
Anonymous User and Session for a tokenless request. The only accepted explicit
value is `"none"`. This is an endpoint declaration; it does not change the
runtime-owned health/probe routes or provider callbacks.

The handler receives `SessionlessEndpointContext`: only `app`, `env`, `services`, `log`,
`rateLimit`, `signal` and the ordinary bounded `request` (including exact
`bodyBytes`). `endpointFor(schema)` supports the same declaration without
adding schema or Database authority. There is no Auth or Credential identity,
Database, resource, File, Team, billing, Job, mail, AI, message, Access-key,
Service User, server-auth, lifecycle or Privileged capability. `env` is a readonly
snapshot of string Server env values. `services` is the frozen trusted companion
connection view described in the [container service contract](projects-and-configuration.md#declare-a-container-service), including generated API keys. These remain trusted server input;
do not return secrets or incoming credential values.

**General Capsule context middleware is skipped for sessionless endpoints.**
It expects the ordinary authority-bearing context and could add capabilities.
These handlers run without the ordinary identity-bound endpoint transaction.
The runtime does not resolve supplied Session, cookie or Access-key credentials,
create or touch auth records, record credential usage, or automatically upgrade
the request to an identity. Credential headers remain ordinary request data and
confer no authority.

HTTP security and request-admission policy still run before the handler. Body
limits, JSON parsing, response validation and opaque handler errors use the
ordinary HTTP mechanisms. `signal` tracks client cancellation; `rateLimit`
uses the existing bounded process-local Capsule limiter with no transaction
refunds, and `log` uses the existing runtime logger and payload bounds.

Sessionless endpoints cannot use `requireAuth` wrappers, multipart ingress,
File-attachment responses, MCP exposure or runtime-owned provider callbacks.
Declarations are checked in authoring helpers and again at runtime startup and
dispatch. Use an ordinary endpoint for identity-bound or stateful integrations.

### Expose an endpoint to MCP clients

Add `mcp: true` or `mcp: { description }` to an endpoint's options to list it
as a tool on the Capsule's key-guarded MCP bridge. Endpoints without `mcp` are
never exposed. The bridged request carries no caller credential, so the
handler must authorize it. See the [MCP bridge reference](./mcp-bridge.md).
