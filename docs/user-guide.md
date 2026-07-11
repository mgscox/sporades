# Sporades User Guide

This guide is for building, running, inspecting, and publishing Sporades
Capsules. It assumes Sporades is already installed locally. If you are preparing
a Linux Host server for remote Hosted Capsules, read
[server-installation.md](./server-installation.md) first.

For the documentation split between conceptual guides, generated SDK reference,
and source comments, see [sdk-documentation.md](./sdk-documentation.md).

**Note:** This guide assumes you have installed `sporades` glovally

Sporades is CLI-first. The normal loop is:

```sh
sporades create my-capsule --template todo
cd my-capsule
sporades dev
```

Then edit `server/`, `client/`, and `shared/`. Sporades bundles the Capsule on
every start and rebuild, so Dev sessions and Container sessions run the same
bundled code.

## Quick Start

## User Journey Tracker

The User journey tracker is opt-in, transient current state for answering “what
are consenting users doing now?” It is not analytics, an audit log, an App
message stream, a Capsule app table, or durable current-user preferences.

First declare the expandable Capsule-wide feature and its safe automatic
capture ceiling:

```ts
export default capsule({
  name: "support",
  journey: {
    enabled: true,
    ttlSeconds: 30,
    capture: { navigation: true, focus: true, interactions: true },
  },
});
```

All three capture sources default on when omitted. A page may narrow them in
`journey.enable({ capture: ... })`, including turning all three off for
manual-only use, but may not broaden the Capsule policy. Declaration permits
the feature; it does not publish anything. Reading or subscribing never enables
the caller.

```ts
import { journey } from "sporades/client";

const enabled = await journey.enable({ capture: { interactions: false } });
const saved = await journey.set({
  status: "reviewing-order",
  metadata: { section: "delivery" },
  ttlSeconds: 60,
});
const current = await journey.list();
const subscription = journey.subscribe((event) => {
  if (event.type === "snapshot") console.log(event.states);
  else console.log(event.type, event.state);
});
subscription.unsubscribe();
await journey.disable();
```

`journey.enable()` establishes page-runtime consent and returns the enabled
user and effective capture policy; it does not return a `sessionId` or create a
server session. With navigation capture active it immediately samples and
publishes the current page. `journey.set(...)` publishes a bounded semantic
status and optional JSON metadata, replacing rather than merging the current
record. `journey.disable()` clears consent and immediately removes the current
connection's live state. `journey.list()` returns all live records. A
subscription receives a snapshot first, then `added`, `updated`, and `removed`
events; removal includes the complete last state. Unsubscribe stops delivery.

Consent belongs to the page runtime, not a Journey session. An ordinary
transport reconnect automatically re-enables with the retained narrowed policy,
but a new transport connection always gets a new server-owned Journey session
on its first accepted publication. Explicit disablement, an authentication
transition, or page reload/replacement clears consent. Apps that want a durable
user choice may store that choice separately in current-user preferences and
call `journey.enable()` in each new page runtime.

Sessions are created lazily and only accepted manual or automatic publications
count as activity. A publication after the configured inactivity boundary also
starts a new session. Configure segmentation in `sporades.json`:

```json
{ "journey": { "sessionInactivityMinutes": 30 } }
```

The default is 30 minutes. Numeric values are rounded and clamped to 1–1,440
minutes; missing or malformed values fall back to 30. This session boundary is
independent of Journey state TTL. The public `sessionId` groups records; it is
not a bearer credential. Journey has no private resume credential, durable
capability registry, or retirement tombstone.

Automatic capture publishes `viewing` for navigation, `focused` or `away` for
focus/visibility changes, and the semantic status on the nearest annotated
interaction:

```html
<meta name="sporades-journey" content="checkout">
<button data-sporades-journey="confirming-order">Confirm</button>
```

Navigation captures only a normalized pathname—never origin, query, or raw
hash. Use the single semantic page-name meta override for sensitive or
identifier-rich routes. React, Preact, Vue, Svelte, SolidJS, Lit, and Inferno
consume the same framework-neutral Journey stream; route detection does not
belong to a framework adapter. Sporades uses a browser-level History/meta
observer, samples after a render frame, and installs idempotently across HMR or
client-runtime setup. Publish manually for locationless view changes.

`data-sporades-journey` contains one semantic status, not JSON. Delegated
capture handles annotated click and submit, including keyboard-triggered native
events, without preventing defaults. It uses `composedPath()` to find the
nearest annotated match once through nesting and open Shadow DOM. For closed
Shadow DOM, capture works when the host is annotated; internal nodes are
not inspectable. Other event types require manual publication. Use typed manual
updates for richer metadata. Raw clicks,
DOM content, form values, query strings, session replay, and arbitrary browser
telemetry are deliberately excluded.

Statuses and annotation values are at most 256 characters. Metadata is JSON-safe
and bounded to 8 KiB, depth 8, 64 object keys, and 64 array items; unsupported,
cyclic, non-finite, prototype-sensitive, or otherwise invalid values receive a
structured validation error. Keep even accepted metadata privacy-safe.

Journey state defaults to a Capsule-wide 30-second TTL. The declaration accepts
1–300 seconds, and manual updates may choose an override in the same range;
automatic signals use the Capsule default. The caller renews state by publishing.
Disconnect leaves the last state buffered only until its existing expiry, so a
late subscriber can still receive it. Expiry means derived `inactive`; it is not
a publishable status. Disablement and authentication transitions remove current
state immediately. Server replacement clears every buffered record and session;
a still-consenting page reconnects and publishes only fresh state under a new ID.
There is no permanent Journey state.

Records have the flat shape
`{ sessionId, userId, status, metadata, updatedAt, expiresAt }`. Lists and
snapshots are deterministically ordered by `(userId, sessionId)`; group them on
the client when presenting users. One user may have multiple live sessions,
just like multiple tabs, browsers, or devices.

Immediate `set` results and `list()` reflect accepted state. Realtime delivery
coalesces each session to its latest state over 100 milliseconds while
preserving coherent change order; intermediate states are not guaranteed.
Capacity is 32 live states per user and 1,000 live states per Capsule. Expired
records are pruned before admission, replacement remains allowed at capacity,
and a new over-capacity record receives a structured rejection without evicting
live state.

Every connected Capsule client receives Journey snapshots and changes in V1.
Publisher-selected record permissions do not exist; future shared-Team
receiver-side filtering is deferred. Publication, reads, and subscriptions are
client-only. Capsule server handlers and the Privileged server role cannot
impersonate user activity, and transient client claims must not become
authoritative server business-logic inputs.

### 1. Create a Capsule

```sh
# Create a sporades capsule called 'notes' from the 'todo' template
sporades create notes --template todo
cd notes
```

`sporades create` writes a complete scaffold and, by default, runs `npm install`
and `git init`. The scaffold includes:

```text
sporades.json
index.html
.env.sporades.server
server/index.ts
client/index.tsx
shared/types.ts
AGENTS.md
README.md
package.json
```

Useful create options:

```sh
sporades create notes --template blank
sporades create guestbook --template guestbook
sporades create gallery --template photo-library
sporades create campfire --template campfire
sporades create tiny --framework preact
sporades create no-install-yet --no-install --no-git
```

Available templates are `blank`, `todo`, `guestbook`, `photo-library`, and
`campfire`. Campfire demonstrates realtime messaging, durable reactions, email
fixture identities, and explicitly consented ephemeral Journey activity.
Available client frameworks are `react` and `preact`.

### 2. Start a Dev Session

```sh
sporades dev
```

The command prints a local URL, usually `http://localhost:4000`. Open that URL
in a browser.

During a Dev session, Sporades watches `server/`, `client/`, `shared/`,
`index.html`, and `sporades.json`. Client-only changes rebuild the client
Bundle. Server or shared changes restart the server runtime and reconnect the
browser transport. If a rebuild fails, Sporades keeps serving the last
successful Bundle while showing the error.

To choose a port:

```sh
sporades dev --port 3000
```

For automation, use JSONL streaming:

```sh
sporades dev --json
```

### 3. Make Your First Server Change

Open `server/index.ts`. A typical Capsule defines a schema, queries, and
mutations:

```ts
import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "notes",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String(),
    }),
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all(),
    ),
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    }),
  },
});
```

Use queries for data the UI reads. Use mutations for changes. Keep ownership and
validation on the server; the client should not be trusted to send fields such
as `ownerId`.

### Current-user Jobs

Declare durable server-only work with `job()` and enqueue it from a trusted
mutation, Custom endpoint, or App message handler through `ctx.jobs`. Enqueue
captures the current Sporades user; browser credentials are not stored with the
Job.

```ts
import { capsule, job, mutation } from "sporades/server";

export default capsule({
  name: "notes",
  jobs: {
    indexNote: job(async (ctx, input: { id: string }) => {
      // Runs later as the captured current user.
      return { indexed: input.id };
    }),
  },
  mutations: {
    index: mutation((ctx, id: string) =>
      ctx.jobs.enqueue("indexNote", { id }, { idempotencyKey: id }),
    ),
  },
});
```

Enqueue is a durable runtime side effect, not part of the Capsule mutation
Transaction boundary: it is not atomic with `ctx.db` writes. Supply an
idempotency key when callers can retry a cross-boundary workflow; repeating the
same key for the same handler and captured user returns the retained Job.

Jobs may use a one-time future `availableAt` and become `delayed` until then;
this is not recurring scheduling. A bounded `retry` policy records attempts and
uses a deterministic delay. `ctx.jobs.cancel(id)` cancels queued or delayed
work, or cooperatively requests cancellation of running work through its signal.

The lifecycle states are `delayed`, `queued`, `running`, `succeeded`, `failed`,
and `cancelled`. Only `queued` Jobs are ready to run; `delayed` Jobs wait until
their `availableAt` time. The initial runtime uses a single worker. A running
attempt holds a lease, and lease recovery after interruption may execute that
attempt again.

Job delivery is **at least once**, not exactly once: an interrupted leased
attempt can be recovered and run again under the same Job ID. Make handlers
duplicate-safe and use idempotency keys for cross-boundary caller retries.

`ctx.jobs.get(id)` reads one known Job. `ctx.jobs.list(...)` supports bounded,
cursor-based listing by actor. Current-user inspection sees only Jobs for its
captured execution actor. Privileged inspection through an explicit
`ctx.privileged.run(...)` may see all Jobs. In either view, `enqueuedBy` is
provenance—the user who caused the Job to be created—and is distinct from the
captured current-user or Privileged server role actor under which the handler
executes.

One-time delayed availability is Job Queue behavior. For recurring work,
Capsule server code declares a named Schedule alongside its named Jobs:

```ts
import { capsule, job, schedule } from "sporades/server";

export default capsule({
  name: "reports",
  jobs: {
    sendDigest: job(async (_ctx, input: { audience: string }) => {
      return { audience: input.audience, sent: true };
    }),
  },
  schedules: {
    weekdayDigest: schedule({
      expression: "0 9 * * 1-5",
      timezone: "Europe/London",
      job: "sendDigest",
      payload: { audience: "subscribers" },
      retry: { maxAttempts: 3, delayMs: 60_000 },
      missedRun: "latest",
    }),
  },
});
```

Schedules use numeric five-field cron expressions. An explicit `timezone` must
be an IANA timezone available through the Node runtime. When it is omitted,
Sporades resolves the server timezone at each runtime startup. Dev, Container,
and Hosted environments can have different server timezone defaults, so pin a
timezone when recurrence must be portable. A changed server default affects
future occurrence calculation only; Sporades does not backfill under the old
timezone.

Cron fields are matched against local wall-clock time in the effective
timezone. When day-of-month and day-of-week are both restricted, either field
may match (conventional cron OR behavior). A local time skipped by a daylight-
saving spring transition produces no occurrence. During a repeated fall hour,
both matching UTC instants are eligible and have distinct occurrence identities.
Use `UTC` when recurrence must not skip or repeat because of daylight-saving
transitions.

The five fields are minute, hour, day-of-month, month, and day-of-week. Numeric
lists, ranges, and positive steps are supported; seconds, years, nicknames such
as `@daily`, and implementation-specific extensions are rejected. Schedule
declarations are server-only: browser code cannot create or invoke recurring
Privileged work. `payload` is either a JSON-safe value (defaulting to `null`) or
an async-capable payload factory evaluated for each occurrence. Payload
factories may run more than once during crash recovery, so any explicitly
privileged side effects must tolerate repetition. `retry` is the ordinary Job
Queue retry policy applied after enqueue; a failed payload factory is skipped
and is not retried as a Job.

The default missed-run policy is `skip`, which resumes at the next future
occurrence after downtime. `latest` enqueues at most the most recent missed
occurrence, then resumes normal recurrence; it never replays an unbounded
backlog. Schedule state and pending occurrences survive runtime restarts through
the configured Database adapter. A deterministic identity based on Capsule,
Schedule name, and scheduled UTC instant prevents overlapping starts or crash
recovery from creating duplicate Jobs for one occurrence.

Changing an expression, timezone, payload, retry policy, or enabled state affects
future occurrences only and does not rewrite historical Jobs. Removing a
Schedule forgets its runtime state while retaining its Jobs; adding the same name
again or renaming a Schedule creates a fresh identity. Disabling or cancelling a
created Job does not disable its Schedule.

Every successfully created Scheduled occurrence becomes an ordinary Job that
executes as the Privileged server role. It retains Job Queue **at least once**
attempt semantics: retries and lease recovery can repeat the same Job attempt,
so handlers must remain duplicate-safe. Schedule duplicate protection prevents
two Job records for one occurrence; it does not promise exactly-once execution.

### Inspect Schedules from the CLI

Administrators inspect bounded, read-only Schedule state with the JSON-only
command for the target runtime:

```sh
sporades schedules
sporades deploy schedules
sporades host schedules --host <alias> --subname <name>
```

These commands target an active Dev session, running local Container session,
or running Hosted Capsule. They return schedules ordered by name, including the
effective timezone, policy, next occurrence, and latest safe outcome and Job
correlation. They omit payloads and secrets, do not evaluate or advance a
Schedule, and return `schedules: []` when no schedules exist. V1 has no human
renderer, filters, pagination, or offline inspection.

### Inspect Jobs from the CLI

Administrators can inspect all Jobs for an active Capsule with one explicit
JSON-only command for each runtime location:

```sh
sporades jobs
sporades deploy jobs
sporades host jobs --host <alias> --subname <name>
```

The commands target an active Dev session, running local Container session, or
running Hosted Capsule respectively. Each returns the same structured JSON
envelope with the Capsule name and all Jobs ordered newest first. The bounded
operational state includes handler, status, actor, provenance, attempts, retry
policy, lifecycle timestamps, and safe result or failure metadata. Input
payloads and idempotency-key values are omitted.

This first operator surface intentionally has no filters, cursor, pagination,
human renderer, or offline inspection. Pipe the JSON through tools such as
`jq` when you need to filter or reshape it.

### 4. Make Your First Client Change

Open `client/index.tsx`. The scaffold wires the framework primitives into
Sporades hooks:

```tsx
import { useEffect, useState } from "react";
import { createHooks } from "sporades/client";

const { useAuth, useQuery, useMutation } = createHooks({ useState, useEffect });
```

Read data with `useQuery("queryName")`:

```tsx
const todos = useQuery("todos");
```

Run changes with `useMutation("mutationName")`:

```tsx
const addTodo = useMutation("addTodo");
await addTodo.run("Buy coffee");
```

Queries stay subscribed over the Sporades client transport, so successful
mutations refresh connected clients without you writing manual fetch code.

### 5. Inspect Logs and Data

In **another** terminal, from the Capsule directory:

```sh
sporades logs
sporades db list
sporades db dump --json
sporades db query "select * from todos" --json
```

`sporades db query` is read-only. Use it to inspect state, not to patch around
application logic.

### 6. Try a Container Session

When the Capsule works locally, test it in Docker:

```sh
sporades deploy
```

This starts a local Container session by bundling the Capsule, mounting the
Bundle files and Server env into a Node container, and persisting SQLite data in
the Runtime directory. Re-running `sporades deploy` replaces the previous local
container for this project.

Use a different port when needed, e.g. if 'dev' is running at same time:

```sh
sporades deploy --port 5000
```

Inspect a running local Container session by passing its port to the same log
and database commands:

```sh
sporades logs --port 4000
sporades logs tail --port 4000 --json
sporades db list --port 4000
sporades db dump --port 4000 --json
sporades db query "select * from todos" --port 4000 --json
```

Use the port from `sporades deploy --json` if you do not know which port the
Container session is using.

## How Sporades Projects Fit Together

### Project Files

`server/index.ts` defines the Capsule: schema, queries, mutations, endpoints,
messages, middleware, and server-side behavior.

`client/index.tsx` is the browser entry. It imports the configured framework and
`sporades/client`.

`shared/` is for types and pure shared helpers. Keep it free of DOM APIs, Node
APIs, Server env, and Sporades runtime imports.

`index.html` is user-owned and served at `/`. It normally loads `/client.js`.

`sporades.json` configures the Capsule name, template, client framework, auth,
and default ports.

Sealed Server env stores server-only values in `.sporades/sealed-server-env/`
and exposes them as `ctx.env` inside server handlers. `.env.sporades.server`
remains supported as a legacy/import-friendly source.

`.sporades/` is the Runtime directory. Sporades owns it. It contains Bundles,
SQLite data, uploaded files, and local binding metadata. Do not edit it by hand.
For exact paths and mount layouts, see
[runtime-layout.md](./runtime-layout.md#project-runtime-directory).

### Configuration

A typical `sporades.json` looks like this:

```json
{
  "name": "notes",
  "template": "todo",
  "client": {
    "framework": "react"
  },
  "auth": {
    "mode": "anonymous"
  },
  "security": {
    "cors": {
      "allowedOrigins": []
    },
    "csp": {
      "mode": "report-only"
    }
  },
  "deploy": {
    "port": 4000
  },
  "dev": {
    "port": null
  },
  "services": {
    "database": {
      "kind": "database",
      "engine": "libsql"
    },
    "storage": {
      "kind": "storage",
      "engine": "minio"
    }
  }
}
```

Ports follow this cascade: CLI flag, then `sporades.json`, then default.

Use `dev.port` when you always want a different Dev session port. Use
`deploy.port` for local Container sessions.

`services.database` declares database Capsule service intent. Supported engines
are `libsql` and `postgres`. `services.storage` declares storage Capsule
service intent; the first supported engine is `minio`. Sporades turns that
intent into a deterministic Docker Compose file under
`.sporades/compose/capsule-services.compose.yml`; the generated file, service
names, network, volume, and labels are Sporades-owned runtime state. Do not
hand-edit the Compose YAML for the supported path; edit `sporades.json` and let
Sporades regenerate it.

For Dev sessions and local Container sessions, declaring that libSQL database
service also selects Sporades' internal libSQL service-backed Database adapter.
The adapter connects with the server-only URL generated by the local service
startup path: Dev sessions use the published loopback service port, and local
Container sessions use the generated Compose service DNS name on the services
network. Capsule code still uses the normal `ctx.db` API; app code does not
need to read the service URL or choose a database client.

Declaring `services.storage` with `engine: "minio"` starts a local MinIO
service for Dev sessions and local Container sessions, selects the internal
S3-compatible Storage adapter, and injects server-only connection env. Capsule
code still uses the normal `files` SDK; app code does not read MinIO endpoints,
access keys, Object bucket names, object keys, or storage-client libraries.
Those details are runtime plumbing and must not appear in client bundles or app
authoring APIs. Local filesystem storage remains the default when
`services.storage` is omitted.

`files.storagePath` configures only the default local filesystem storage
adapter's byte directory. It is not a File path prefix, not a generic storage
setting, and not used by MinIO-backed storage. File paths are logical,
Capsule-scoped Sporades paths regardless of which Storage adapter stores the
bytes.

The first Docker Compose Capsule service implementation is local-only. Dev
sessions and local Container sessions can start, inspect, stop, and reset
declared local service state. Hosted Capsule service orchestration is deferred:
future Host servers should interpret the same `sporades.json` service intent
through `sporades host ...` commands rather than requiring app code, hand-edited
Compose files, or a separate top-level service namespace.

Hosted Capsules do not yet provision or attach declared database or storage
services. Until Host service orchestration exists, do not rely on `services` for
Hosted Capsules; keep using the default embedded SQLite and local file-storage
paths for hosted releases that need to run today.

### Security Policy

`security` controls the Capsule HTTP security posture for Sporades-owned
surfaces and Custom endpoints. The default CORS posture is same-origin. Dev
sessions additionally allow browser origins on `localhost` and `127.0.0.1` so
local tools can talk to the Capsule without extra configuration.

For temporary demos, device testing, or tunnels, start an explicit Public Dev
session:

```sh
sporades dev --public --json
```

The JSON started event includes the effective security policy, including
`security.cors.publicDev: true` and the relaxed allowed origin. Public Dev mode
does not apply to local Container sessions or Hosted Capsules.

Local Container sessions and Hosted Capsules require explicit CORS origins for
cross-origin Custom endpoint access:

```json
{
  "security": {
    "cors": {
      "allowedOrigins": ["https://dashboard.example.com"]
    },
    "csp": {
      "mode": "report-only"
    }
  }
}
```

CSP defaults to report-only mode with React/Preact-friendly scaffold defaults.
Switch to active enforcement when the Capsule is ready:

```json
{
  "security": {
    "csp": {
      "mode": "enforce"
    }
  }
}
```

Override individual CSP directives with `security.csp.directives`. Sporades
merges these values over its defaults, so the JSON only needs to contain the
directives that differ for the Capsule:

```json
{
  "security": {
    "csp": {
      "mode": "report-only",
      "directives": {
        "connect-src": ["'self'", "https://api.example.com", "ws:", "wss:"],
        "img-src": ["'self'", "data:", "blob:", "https://images.example.com"]
      }
    }
  }
}
```

Inspect the effective policy without starting the server Bundle:

```sh
sporades security --session dev --json
sporades security --session public-dev --json
sporades security --session container --json
sporades security --session hosted --json
```

Host commands may report the effective Hosted policy, for example through
`sporades host current --json`, but Host profiles do not override
`sporades.json`.

Migration note: existing Capsules without a `security` object continue to use
the same defaults as new scaffolds. Add `security.cors.allowedOrigins` only for
known cross-origin callers, and prefer testing active CSP with `report-only`
before switching to `enforce`.

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

### Gate Handlers With requireAuth

`requireAuth` is the canonical way to gate a handler on authentication. Call it
at the top of any query, mutation, endpoint, or app message handler instead of
hand-writing `ctx.auth` checks:

```ts
import { capsule, endpoint, mutation, query, requireAuth } from "sporades/server";

export default capsule({
  queries: {
    myProjects: query((ctx) => {
      const auth = requireAuth(ctx);
      return ctx.db.projects.where("ownerId", auth.userId).all();
    }),
  },
  mutations: {
    deleteAccountData: mutation((ctx) => {
      // Reject guest sessions too: require a linked (non-guest) user.
      const auth = requireAuth(ctx, { linked: true });
      ctx.db.projects.where("ownerId", auth.userId).all().forEach((project) => {
        ctx.db.projects.delete(project.id);
      });
    }),
  },
  endpoints: {
    profile: endpoint({ method: "GET", path: "/profile" }, (ctx) => ({
      status: 200,
      body: requireAuth(ctx),
    })),
  },
});
```

On success `requireAuth(ctx)` returns the session's `AuthContext`, so `userId`
and profile fields are available without re-reading `ctx.auth`. On failure it
throws a structured auth error that reaches the client through the normal
handler error pipeline with the stable `UNAUTHENTICATED` code:

```json
{ "ok": false, "error": { "code": "UNAUTHENTICATED", "message": "Unauthenticated.", "hint": "Sign in and retry the request." } }
```

Custom endpoints reply with HTTP `401` and the same structured error body.
Clients can route users to sign-in on the `UNAUTHENTICATED` code alone.

`requireAuth(ctx, { linked: true })` additionally requires a linked, non-guest
user, so Anonymous-session guests cannot perform account-level actions.

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

Restart a running Dev session after changing Sealed Server env.

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

The Job Queue uses a captured user identity for background work that should stay
accountable to the user who authorized it after the original request ends. That
is different from system-owned work.

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

The status command reports which providers are enabled and whether configured
providers have the required Server env values.

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


#### Using OAuth sign-in in the client

Client sign-in uses the provider name:

```tsx
import { auth } from "sporades/client";

await auth.signIn("google");
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

### Simulate Local Identities

For local browser testing, start a Dev session, then run:

```sh
sporades auth as email --email mira@example.com --display-name "Mira Vale" --json
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
with email, signs in to an existing email account, or completes Google OAuth.
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

## Container SSH Access

Container SSH access is an explicit, opt-in compatibility and emergency access
path for local Container sessions and Hosted Capsules. It is not the primary
Sporades management interface. Keep using the structured CLI surfaces for
deployment, logs, stats, restarts, Host registration, and recovery; use
Portainer or similar container tooling when you want a broader container
management UI.

Configure Container SSH access in `sporades.json` with a top-level `ssh` object
and `authorizedKeys` entries. Each entry is an object with exactly one source:
`key` for one inline public authorized-key line, or `file` for public
authorized-key material read by the CLI.

```json
{
  "name": "notes",
  "ssh": {
    "authorizedKeys": [
      { "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample developer@workstation" },
      { "file": "~/.ssh/id_ed25519.pub" },
      { "file": "ops/authorized_keys.pub" }
    ]
  }
}
```

`file` entries resolve on the CLI machine before a local Container session
starts or a Hosted Capsule release is packaged. Supported file references
include absolute paths, `~`, and project-relative paths. Absolute paths are
used as-is, `~` expands to the CLI user's home directory, and project-relative
paths resolve from the directory containing `sporades.json`. Hosted Capsule
releases include only generated public authorized-key material. Original file
paths are not retained: original source paths are not copied into Hosted Capsule releases.
Those source paths are also omitted from Host registries and container metadata.

Sporades preserves OpenSSH `authorized_keys` semantics. A `key` entry provides
one authorized-key line. A `file` entry may contain normal authorized-key file
content, including multiple public-key lines, comments, blank lines, key
options, and OpenSSH-supported public-key algorithms. Private-key-looking or
malformed material is rejected before container startup or release packaging
where possible. Empty effective key sets leave SSH disabled.

When SSH is enabled, sessions log in as the `sporades` user with key-based
authentication only. Sporades does not provide root login, sudoers access,
passwords, custom SSH ports, or public SSH port exposure. Release files remain
read-only; Capsule data remains the writable runtime area. Hosted Capsule SSH
ports are Docker-assigned and loopback-only on the Host server, separate from
Caddy HTTP routing.

Use explicit inspection commands for effective SSH state. `sporades deploy ssh`
inspects the local Container session, and `sporades host ssh` inspects a Hosted
Capsule through the configured Host server:

```sh
sporades deploy ssh
sporades deploy ssh --json
sporades host ssh team-notes --host personal
sporades host ssh team-notes --host personal --json
```

These commands report connection facts such as enabled state, user, host, port,
target port, key count, fingerprints, running state, and reason codes. Normal
`sporades deploy`, `sporades host push`, list, stats, and lifecycle output do
not include SSH state unless validation fails.

Indicative examples: Client SSH commands vary by OS, key agent, local SSH config, and tunneling
setup. Treat the examples as shape, not a contract.

```sh
# Local Container session: first inspect the Docker-assigned loopback port.
sporades deploy ssh --json
ssh -p <local-port> sporades@127.0.0.1

# Hosted Capsule: create an SSH tunnel to the loopback-only port on the Host server.
sporades host ssh team-notes --host personal --json
ssh -N -L <local-port>:127.0.0.1:<host-loopback-port> <host-profile-ssh-target>
ssh -p <local-port> sporades@127.0.0.1
```

## File Uploads

Use the `files` API from `sporades/client` for browser `File` or `Blob` values:

```tsx
import { files } from "sporades/client";

const explicitPathFile = await files.upload(selectedFile, {
  path: "/photos/profile.jpg",
  onProgress(event) {
    console.log(event.loaded, event.total);
  },
});

const defaultBucketFile = await files.upload(selectedFile);
```

Sporades negotiates and transfers the upload bytes internally.
The returned file metadata includes fields such as `id`, `name`, `type`, `size`,
`path`, and `version`. `path` is the absolute Capsule-scoped File path, not a
runtime URL, filesystem path, object key, or Object bucket location. Passing
`path: "/photos/profile.jpg"` chooses that absolute File path. Omitting `path`
uses the uploaded file name in the Default File bucket, falling back to the
logical `/default/upload` File path when no file name exists.
Uploaded bytes are private by default. Ownership and privacy come from runtime
File metadata and ACL behavior, not from the Default File bucket itself.

If you want to store the file information in a database table,
you must explicitly do so using a normal mutation:

```tsx
// Using existing 'recordPhoto' table
await recordPhoto.run({
  title,
  file,
});
```

Private reads use:

```tsx
const url = await files.url(file.id);
const blob = await files.download(file.path);
```

File operations that identify an existing file accept a File reference: either
the stable File ID or the absolute File path. The reference must resolve to one
live file owned by the current user.

Create public URLs explicitly:

```tsx
const publicUrl = await files.publicUrl(file.id, { ttlSeconds: 3600 });
const foreverUrl = await files.publicUrl(file.id, { noExpiry: true });
```

Revoke public URLs when they should no longer work:

```tsx
await files.revokePublicUrl(publicUrl.id);
```

Delete uploaded files when the current user owns them:

```tsx
await files.delete(file.id);
```

Deleting a file marks it deleted, removes the current stored bytes on a
best-effort basis, and revokes any active public URLs for that file. If you
stored the returned file metadata in one of your own tables, delete or update
that row separately with a normal mutation.

Replace file bytes while preserving the file ID:

```tsx
await files.upload(replacementFile, { replace: true, fileId: file.id });
```

Uploading new bytes to an existing live File path also replaces that file,
preserves its File ID, and creates a new File version. Deleting the file frees
the path; a later upload to the same path creates a new File ID.

Private and public file URLs are always Sporades HTTP routes such as
`/__sporades/files/private/<id>?v=<version>` and
`/__sporades/files/public/<id>?v=<version>`. They are not presigned MinIO, S3, or
filesystem URLs. The `v` parameter carries the File version for cache busting
after replacement. File metadata exposes the logical File path and File ID so
app tables and ACLs can store stable references; it must not expose filesystem
locations, object keys, Object buckets, MinIO connection details, or generated
runtime read URLs as storage locations.

## Custom HTTP Endpoints

Most app behavior should use queries and mutations. Use endpoints for HTTP
integrations such as webhooks:

```ts
import { capsule, endpoint } from "sporades/server";

export default capsule({
  endpoints: {
    webhook: endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => {
      ctx.log.info("Webhook received", {
        path: ctx.request.path,
        body: ctx.request.body,
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
query parameters, and parsed body data.

## App Messages

Use app messages for ephemeral real-time events, such as typing indicators or
presence pings. Messages are sent to the client (or clients) over WebSocket.
Use queries and mutations for durable state.

There is no need to predefine or register message categories.

Declare a handler on the server:

```ts
import { capsule, message } from "sporades/server";

export default capsule({
  messages: {
    // hook the 'typing' category of messages from clients
    typing: message((ctx, data) => {
      const numClientsSentTo = ctx.messages.send({ type: "typing", data });
      return { ok: true, numClientsSentTo };
    }),
  },
});
```

`ctx.messages.send(...)` returns the number of connected clients the message was
sent to. Multiple browser tabs or devices for the same user are counted
separately.

Send and subscribe on the client:

```tsx
import { onMessage, sendMessage } from "sporades/client";

// send a message with 'typing' category to server
await sendMessage("typing", { roomId: "general", active: true });

// hook all incoming messgaes from server
const subscription = onMessage()
  .filter((message) => message.type === "typing") // filter on 'typing' category
  .subscribe((message) => {
    console.log(message.data);  // {ok: true, numClientSentTo: <numeric count>}
  });

subscription.unsubscribe();
```

Client-origin messages always run through declared server handlers.

## Inspecting and Debugging

### Logs

Use `ctx.log` in server handlers:

```ts
ctx.log.info("Project created", { id: project.id });
ctx.log.warn("Near quota", { userId: ctx.auth.userId });
ctx.log.error("Webhook failed", { reason });
```

Read logs from a running Dev session:

```sh
sporades logs
sporades logs --json
sporades logs tail --json
```

Pass `--port` to inspect a local Container session instead:

```sh
sporades logs --port 4000 --json
sporades logs tail --port 4000 --json
```

`ctx.log` entries and Sporades platform runtime events share the
`sporades.log.v1` envelope: `timestamp`, `category`, `event`, `level`,
`message`, `capsule`, optional `release`, optional `request`, optional
`correlation`, and structured `data`. App logs use `category: "app"` and
`event: "ctx.log"`; runtime events use `category: "platform"`. This JSONL log
stream is separate from `sporades dev --json`, which only streams Dev-session
lifecycle events such as start and rebuild status.

Structured log data is redacted before it is written. Keys such as passwords,
tokens, secrets, authorization headers, cookies, API tokens, and client secrets
are replaced with `[REDACTED]`; exact Server env values are also redacted if
they appear in structured log data. Request method and path may be recorded, but
raw request bodies are not logged by default. Each log event is capped to a
bounded payload size, with oversized structured data marked as truncated.

The JSONL log stream lives under the Runtime directory by default and is the
primary durable stream for CLI tailing, Host collection, Docker stdout, and
crash-adjacent debugging. SQLite stores only a bounded recent log index for
inspection queries; `sporades logs --json` reads that index, while
`sporades logs tail --json` prints JSONL events from the durable stream. Local
Container sessions and Hosted Capsules also emit JSON log events to Docker
stdout.

### Fatal Runtime Restart Policy

Fatal runtime paths are handled by mode, and the policy is reported in JSON
status output:

- **Dev** sessions restart automatically after unhandled rejections, uncaught
  exceptions, and failed `init()` or `shutdown()` lifecycle boundaries. The
  terminal, `sporades dev --json`, and the structured log stream report the
  fatal event, restart attempt, and exhaustion state. `SIGTERM` and `SIGINT`
  still exit the Dev session.
- **Local Container** sessions run with Docker `--restart on-failure:3`. Fatal
  runtime exits such as unhandled rejections, uncaught exceptions, and failed
  startup hooks get bounded restarts instead of infinite loops. `sporades
  deploy --json` includes the restart policy.
- **Hosted Capsules** also run with Docker `--restart on-failure:3`. Start,
  restart, stats, health, release verification, and release history surfaces
  expose lifecycle and restart-policy details. When a Hosted Capsule cannot be
  kept running, its route returns the Hosted Capsule unavailable response.

During `sporades host push --verify`, fallback to the previous release is only
available when explicitly requested with
`--fallback-to-previous-release`. This opt-in fallback applies to release
verification only. Later runtime crashes after a release has already been
verified or accepted do not automatically fall back; they use restart/backoff,
structured failure output, Docker logs, and the unavailable response when
retries are exhausted.

### Database

List tables:

```sh
sporades db list
sporades db list --port 4000
```

Dump everything:

```sh
sporades db dump --json
sporades db dump --port 4000 --json
```

Run a read-only SQL query:

```sh
sporades db query "select id, createdAt from todos order by createdAt desc" --json
sporades db query "select id, createdAt from todos order by createdAt desc" --port 4000 --json
```

If a query cannot connect, confirm `sporades dev` is running or pass the right
`--port`.

### JSON Output

Commands that support `--json` return:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Errors use the same envelope and exit with code `1`:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "message": "Missing SQL query.",
    "hint": "Use `sporades db query <sql>`."
  }
}
```

Use `--json` for scripts and agents. Use plain output when you are working by
hand.

## Local Container Sessions

`sporades deploy` is for production-like local testing:

```sh
sporades deploy
sporades deploy --port 5000
sporades deploy --force
sporades deploy --json
sporades deploy stop --json
sporades deploy restart --json
sporades deploy remove --json
```

The command:

1. Bundles the server and client.
2. Stops and removes the previously bound local container, if one exists.
3. Prepares the Sporades Base image automatically.
4. Runs the Capsule in Docker using the Sporades Base image as the invoking
   host UID/GID when available.
5. Mounts Sealed Server env or legacy Server env read-only.
6. Persists SQLite data through the Runtime directory.
7. Writes the container binding to `.sporades/binding.json`.

Use `--force` if the previous Docker container was deleted manually and the
local binding is stale.

Lifecycle commands operate on the local Container session recorded in
`.sporades/binding.json`:

| Command | Effect |
| --- | --- |
| `sporades deploy stop` | Stops the bound Docker container and any generated local Capsule services. The binding and persistent data remain in place. |
| `sporades deploy restart` | Starts the stopped bound Docker container again, starting declared Capsule services first when needed. It does not rebuild bundles. |
| `sporades deploy remove` | Force-removes the bound Docker container, removes `.sporades/binding.json`, and stops generated local Capsule services. Persistent data remains in the Runtime directory. |
| `sporades deploy reset` | Removes the bound Docker container when present, stops generated services, and deletes generated Capsule service state such as Compose volumes, networks, and Sporades-owned service data. |

When running through the scaffolded npm script, pass flags after `--`:

```sh
npm run deploy -- --force
```

## Hosted Capsules

Hosted Capsules run on a configured Host server. The server installation guide
covers machine setup. Once a Host server exists, the user workflow is:

```sh
sporades host add personal \
  --server root@example.com \
  --domain example.com \
  --remote-root /srv/sporades \
  --json

sporades host use personal
sporades host bootstrap --host personal --json
```

From a Capsule project directory:

```sh
sporades host register team-notes --host personal --json
sporades host push --host personal --subname team-notes --json
sporades host start team-notes --host personal --json
```

If the Capsule uses Sealed Server env, `host push` re-encrypts local sealed
values to the Hosted Capsule's current Host public key. The push packages only
the Host-encrypted sealed envelope with the release. Host private keys stay in
Host-owned persistent state and plaintext values do not cross the local-to-Host
boundary.

For normal release updates:

```sh
sporades host push --host personal --subname team-notes --restart --json
sporades host push --host personal --subname team-notes --verify --fallback-to-previous-release --json
```

Useful Hosted Capsule operations:

```sh
sporades host list --host personal --json
sporades host stats --host personal --json
sporades host stats team-notes --host personal --json
sporades host logs http --host personal --subname team-notes -n 200 --json
sporades host logs stdout --host personal --subname team-notes -n 200 --json
sporades host restart team-notes --host personal --json
sporades host stop team-notes --host personal --json
```

If a Capsule declares `services` today, those services are only managed for
local Dev sessions and local Container sessions. A later Hosted Capsule service
implementation should extend the existing `sporades host` surface so operators
can register, push, start, stop, restart, inspect, reset, back up, and recover a
Hosted Capsule and its required services from the same Host profile. It should
not introduce a separate `sporades services` namespace for Hosted operation.

**Push validation**

Sporades will review the uploaded bundle for unexpected files. On macOS, if tar includes AppleDouble metadata during push, it can cause rejection. Use:

```sh
COPYFILE_DISABLE=1 sporades host push --host personal --subname team-notes --restart --json
```

> Sporades will attempt to auto-ignore additional MacOS metadata, but it still may cause a false-postivie and reject the bundle - setting `COPYFILE_DISABLE` is guaranteed.

## Common Workflows

### Add a New Feature

1. Add fields or tables in `server/index.ts`.
2. Add a query for the screen's read model.
3. Add mutations for user actions.
4. Render the query with `useQuery()`.
5. Call mutations with `useMutation()`.
6. Watch the Dev session rebuild.
7. Inspect logs and data if anything looks wrong.

Schema changes may alter local data. Treat `.sporades/data.db` as runtime state,
not source code.

### Add Per-User Data

Store `ctx.auth.userId` in rows that belong to a user:

```ts
ctx.db.notes.insert({
  body,
  ownerId: ctx.auth.userId,
});
```

Filter reads with the same user ID:

```ts
ctx.db.notes.where("ownerId", ctx.auth.userId).all();
```

Do not accept `ownerId` from the client.

### Add a Server Secret

1. Add the value to `.env.sporades.server` and run `sporades env import`.
2. Read it with `ctx.env`.
3. Restart `sporades dev`.
4. For Hosted Capsules, run `sporades env reencrypt --host <alias>`, then push
   and restart the Capsule.

Do not put secrets in `client/`, `shared/`, `index.html`, or `sporades.json`.

### Reset Local Runtime State

Stop local runtime processes without deleting persisted data:

```sh
sporades dev stop --json
sporades deploy stop --json
```

Restart or remove a stopped local Container session:

```sh
sporades deploy restart --json
sporades deploy remove --json
```

Inspect generated Capsule service state with structured JSON:

```sh
sporades dev status --json
sporades deploy status --json
```

Reset generated Capsule service state, including Compose networks, volumes,
orphans, and Sporades-owned Capsule service data for the current project:

```sh
sporades dev reset --json
sporades deploy reset --json
```

Reset only removes Sporades-managed Capsule service state. It does not remove
shared third-party service images such as database images.

## Sporades Doctor

`sporades doctor` is the read-only diagnostic coordinator for a Capsule project.
It gathers project configuration, security posture, Capsule authoring, local
runtime, Capsule service, and Hosted Capsule signals into one report. It does
not repair state, does not mutate Runtime files, does not start or stop
containers, and does not replace the focused inspection and lifecycle commands
that already own those jobs.

In short: doctor is read-only, does not repair state, and does not mutate
project or runtime state.

Run doctor without flags for project-level checks:

```sh
sporades doctor
```

Target a local Dev session, local Container session, or Hosted Capsule when you
want runtime-specific checks:

```sh
sporades doctor --session dev
sporades doctor --session container --json
sporades doctor --session hosted --host personal --subname team-notes --json
```

For CI and AFK agents, use strict JSON output:

```sh
sporades doctor --strict --json
```

Normal mode exits non-zero for failed checks. `--strict` also exits non-zero for
warnings, which makes it useful before handoff, release, or automated repair
loops. JSON output includes the check `id`, `scope`, `status`, `severity`,
message, optional hint, follow-up commands, and non-secret details.

Check statuses mean:

- `pass`: doctor inspected the surface and found the expected state.
- `warn`: doctor found drift, missing optional state, or risky configuration.
- `fail`: doctor found a blocking problem or could not inspect a required
  surface.
- `skip`: doctor did not have enough local state to run that check, such as a
  missing Dev or Container binding.

Doctor coordinates existing inspection surfaces instead of replacing them. Use
the `next` commands in doctor output to continue with the focused command that
owns the surface, including `sporades security`, `sporades env`, `sporades
deploy ssh`, `sporades host health`, `sporades host stats`, `sporades host
logs`, and `sporades host ssh`.

Doctor output avoids secrets. It may include fingerprints, counts, paths, and
structured state, but it must not print private keys, full Server env values, or
full SSH public-key material.

## Troubleshooting

- `Unknown command`: run `sporades --help`.
- Dev session cannot start on a port: pass `--port <number>` or update
  `sporades.json`.
- Browser does not update after auth config changes: restart `sporades dev`.
- `sporades logs` or `sporades db` cannot connect: start a Dev session or pass
  `--port`.
- Google sign-in is unavailable: run `sporades auth status` and confirm Google
  is enabled and configured.
- Container session fails immediately: run `sporades deploy --json` and inspect
  the structured error hint.
- Hosted Capsule route returns `503`: the Capsule is registered, but has no
  running container or the current release failed to start. Check
  `sporades host stats <subname>` and `sporades host logs stdout`.
- Hosted Capsule keeps crashing: inspect `sporades host logs stdout --subname
  <subname> --json`, then restart or push a fixed release. Automatic fallback
  only applies to `host push --verify --fallback-to-previous-release`, not to
  later runtime crashes.
