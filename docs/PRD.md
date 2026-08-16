# Sporades Product Requirements

> Sporades: an archipelago in the Aegean. Each Capsule is an island; the
> platform is the sea.

## Overview

Sporades is a CLI-first platform for building, running, inspecting, and hosting
small full-stack web Capsules. Developers and agents use deterministic commands
instead of dashboards: `sporades create`, `sporades dev`, `sporades deploy`,
and `sporades host ...`.

Apps run as real Node.js code with SQLite-backed persistence. The CLI keeps the
Server Bundle on esbuild and builds clients through a framework/toolchain
adapter: esbuild remains the React/Preact/Inferno default, while all three can
explicitly select Vite and Vue uses Vite for native Single-File Components.
The normalized release runs unchanged in a local Dev session, a local Docker
Container session, or a Hosted Capsule on a Host server.

Target users are developers who want zero-config full-stack apps and agentic
LLM systems that need a scriptable build, deploy, inspect, and repair loop.

## Scope Status

### Implemented scope

The repository currently includes:

- `sporades create` scaffolding with template selection, React, Preact, Inferno, Lit, SolidJS, and
  Vanilla TypeScript framework support, explicit React/Vite and Preact/Vite
  admission, and Vue/Vite admission across every supported template,
  Svelte/Vite and SolidJS/Vite admission across every supported template, plus
  Lit/Vite admission across every supported template with native Web Components,
  Inferno admission across every supported template through esbuild or explicit Vite,
  with native class-component lifecycle and no React compatibility dependency,
  framework support, `AGENTS.md`, `CLAUDE.md`, `index.html`, `sporades.json`,
  Server env, and optional `npm install` / git initialization.
- `sporades dev` for local Node execution with bundling, file watching,
  debounced rebuilds, runtime restart, WebSocket reconnects, JSONL events,
  SQLite persistence, uploaded file storage, debug logs, and database
  inspection endpoints.
- `sporades deploy` for local Docker Container sessions with read-only runtime
  file mounts, read-write persistent data, and single-container replacement on
  redeploy.
- Local-only Docker Compose Capsule services for declared database and storage
  service intent, including libSQL/Postgres database services and MinIO-backed
  S3-compatible file byte storage, shared by Dev sessions and local Container
  sessions through Sporades-owned generated Compose runtime state.
- Host server commands for Host profiles, remote bindings, Hosted Capsule
  registration, release push, start, stop, restart, unregister, storage delete,
  list, stats, logs, SSH inspection, bootstrap, and low-level helper
  invocation.
- Hosted Capsules routed through Caddy with domain-scoped registry, storage,
  route files, deterministic Docker containers, loopback-only published ports,
  Docker ownership labels, and a Host-server-owned unavailable response for
  registered Capsules without a running release.
- Opt-in Container SSH access for local Container sessions and Hosted Capsules
  through top-level `ssh.authorizedKeys` entries in `sporades.json`. SSH uses
  the Base image `sporades` user, key-based authentication, Docker-assigned
  loopback-only ports, generated public authorized-key material, and explicit
  inspection through `sporades deploy ssh` and `sporades host ssh`. It is an
  opt-in compatibility and emergency access path, not the primary management
  interface.
- Privileged audit event contract for runtime-owned and platform-owned
  security events. Privileged audit events are a narrow structured JSONL audit
  surface, not a new audit database or centralized logging system. The initial
  implemented coverage records Sporades-controlled SSH configuration,
  lifecycle, and inspection events while leaving real SSH daemon login/session
  capture as future scanner work.
- Privileged server role as an explicit `ctx.privileged.run(...)` server-code
  API for trusted userless work inside a Capsule. It is a server-only authority
  for system-owned execution, not a Capsule role, app admin, Teams membership,
  user, session, service account, or browser credential. It emits Privileged
  audit lifecycle events, exposes narrow DB and File access through existing
  runtime boundaries, and provides the actor boundary used by Privileged Jobs
  and future Job scheduling work.
- A runtime-owned Job Queue for durable server-only work declared with `job()`.
  Capsule server code enqueues Jobs to run as either the captured current
  Sporades user or the Privileged server role. The runtime persists lifecycle
  state, applies bounded retry and cancellation behavior, and performs lease
  expiry and restart recovery with at-least-once delivery. Administrators can
  inspect all bounded Job state through deterministic JSON-only commands for
  active Dev sessions, local Container sessions, and Hosted Capsules.
- Runtime-owned Job scheduling through named server-only `schedule()`
  declarations. Schedules use numeric five-field cron expressions and IANA
  timezones, persist occurrence state, apply bounded missed-run recovery, create
  duplicate-protected ordinary Privileged Jobs, and expose deterministic
  JSON-only inspection across Dev, Container, and Hosted Capsules.
- Practical Docker hardening defaults for local and hosted Container sessions:
  the thin Sporades-owned Base image runs Node 22, local Container sessions use
  the invoking host UID/GID when available, Hosted Capsules use the Base image
  non-root user `10001:10001`, release files and Server env mount read-only,
  mutable SQLite/file state lives under read-write data mounts, hosted traffic
  reaches containers through Caddy loopback routes rather than public container
  ports, Hosted Capsule logs use bounded Docker `json-file` settings, and Host
  inspection reports Base image version/update policy.
- Per-Capsule HTTP security policy defaults in `sporades.json`, including
  same-origin CORS by default, Dev-session localhost/127.0.0.1 ergonomics,
  explicit Public Dev mode, conservative security headers, technology-header
  suppression, report-only CSP defaults, active CSP enforcement, and CLI/Host
  policy inspection.
- Caddy automatic HTTPS as the default Host TLS mode, with
  `cloudflare-origin` TLS available for Hosted domains that use preinstalled
  Cloudflare origin certificates.
- Server API support for schema tables, queries, mutations, Custom endpoints,
  context middleware, pre/post mutation hooks, and App messages.
- Field builders for `String()`, `Boolean()`, `Number()`, `Date()`, `Json()`,
  and `Reference()`.
- Additive migrations for new tables, fields, and unique constraints, plus
  exact-constraint `insertOrIgnore` writes. Unsupported destructive or
  shape-changing schema changes fail with a structured error instead of
  silently dropping app data.
- Runtime-owned auth with anonymous sessions, email sign-up/sign-in, Google
  OAuth provider linking, local identity simulation helpers, connected-client
  auth targeting, and provider configuration through `sporades.json` plus
  Server env.
- Server-only SMTP mail through `ctx.mail.send(...)`, with one portable
  `sporades.json` contract for Dev sessions, local Container sessions, and
  Hosted Capsules; validated Postmark, Mailgun, Mailjet, SMTP2GO, and generic SMTP
  extensions; bounded transport timeouts; clean shutdown; and secret-safe
  structured delivery diagnostics.
- Runtime-owned email-provider callback routes configured under `mail.webhooks`,
  with provider-specific verification and normalization feeding one optional
  provider-neutral Capsule Email-event subscription. Verified events include
  exact raw per-event provider JSON, run under the Privileged server role, and
  are not persisted by Sporades. Current adapters support Mailjet, SMTP2GO, and
  Postmark, and Mailgun; external callback registration and reconciliation
  remain separate future operator work.
- Runtime-owned current-user preferences through the `sporades/client`
  `preferences` SDK, backed by Sporades user identity rather than Capsule app
  schema.
- File storage through the `sporades/client` `files` SDK, including uploads,
  private URLs, downloads, delete, replacement with file versions, public URL
  creation, and revocation.
- App messages over the existing client transport through SDK-level send and
  subscribe/filter APIs.
- Built-in Team management through browser `teams` and trusted `ctx.teams`:
  explicit Team creation, rename, admin-scoped membership listing, email-bound
  Join links and joining, plus transactional admin promotion/demotion, member
  removal, ordinary-member leave, and sole-member deletion. Capsules may
  declare up to 32 membership application roles under `teams.appRoles`. Each
  role must match `^[a-z][a-z0-9-]{0,31}$` (maximum 32 characters); `admin`,
  `member`, and the `sporades-*` prefix are reserved. Exact-Team admins
  atomically add/revoke declared roles through the
  browser or trusted API. Management `admin`/`member` stays separate, stored
  assignments for undeclared roles fail closed but survive a declaration
  rollback, and audits are redacted. Table ACL rules may make explicit-Team
  membership, Team-admin, and declared application-role decisions through the
  constrained read-only `ctx.acl.teams` helpers; Teams never select a current
  Team or automatically partition Capsule data.
  Admin membership enumeration supports opaque cursor pagination with an exact
  uncapped total, while the Team-summary count remains display-only. Capsules
  may declare a trusted `teams.admitJoin` policy that reads app-owned state
  through transaction-bound `ctx.db`; the runtime serializes the policy and
  membership insert under the Team lifecycle lock for atomic seat admission.

### Future scope

The following work is intentionally deferred:

- Automatic OpenTelemetry and centralized JSON logging:
  `.scratch/post-v2-platform-hardening-and-ops/issues/04-add-automatic-opentelemetry.md` and
  `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md`.
- Runtime restart policy for fatal paths:
  `.scratch/post-v2-platform-hardening-and-ops/issues/06-handle-fatal-runtime-paths-with-restart-policy.md`.
- Real SSH login and session capture:
  a future scanner may read host SSH daemon logs, normalize accepted/failed
  login and session events, and emit them through the Privileged audit event
  contract without coupling `sshd` directly to Sporades runtime code. The spike
  remains in `.scratch/privileged-audit-event-contract/ssh-daemon-session-log-scanner-spike.md`.
- Capsule roles:
  a non-Team role model requires a distinct demonstrated use case and separate
  PRD. It must not compete with membership-scoped Team application roles,
  which belong to the built-in Teams work in Tickets 09–10. Any such role model
  remains separate from the Privileged server role and cannot become a global
  role on runtime-owned Sporades auth users.
- Vector storage:
  `.scratch/post-v2-platform-hardening-and-ops/issues/07-evaluate-vector-storage-extension.md`.
- Broader production platform work, multi-node hosting, DNS automation,
  dashboards, rollback commands, external database support, and managed
  external storage backends such as AWS S3. Future AWS S3 support should reuse
  the internal S3-compatible adapter/config wiring without changing file
  runtime call sites or app/client APIs. Planning lives under
  `.scratch/post-v2-platform-hardening-and-ops/` until promoted into a concrete
  release PRD.
- Hosted Capsule service orchestration. The first Docker Compose Capsule
  service implementation is local-only; Host-server orchestration for Capsule
  services is deferred until the local lifecycle model has proven the required
  service contract.

## Product Principles

1. CLI is the primary interface. Commands are deterministic, scriptable, and
   return structured JSON where automation needs it.
2. Bundled runtime files are the unit of execution. Dev sessions, local
   Container sessions, and Hosted Capsules all run the same server and client
   Bundles.
3. Sporades owns platform plumbing. App authors define schema, queries,
   mutations, endpoints, messages, UI, and app-specific logic; Sporades owns
   transport, auth, routing, upload negotiation, database setup, and release
   packaging.
4. Runtime state is separated from release files. Bundles and `index.html` are
   replaceable; SQLite data and uploaded file bytes live in persistent data
   locations.
5. Agents are first-class users. Scaffolds include agent instructions, errors
   include actionable hints, and inspection commands avoid scraping.

## Server API

`sporades/server` exports the authoring API:

```typescript
import {
  Boolean,
  Date,
  Json,
  Number,
  Reference,
  String,
  capsule,
  endpoint,
  message,
  mutation,
  query,
  table
} from "sporades/server";

export default capsule({
  name: "Team Notes",

  schema: {
    notes: table({
      body: String(),
      pinned: Boolean().default(false),
      score: Number().default(0),
      publishedAt: Date(),
      metadata: Json().default({}),
      parentId: Reference("notes").default(null),
      ownerId: String()
    }).acl({
      read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
      write: async ({ previous, next, ctx }) => {
        const ownerId = next?.ownerId ?? previous?.ownerId;
        return ownerId === ctx.auth.userId;
      }
    })
  },

  queries: {
    notes: query((ctx) =>
      ctx.db.notes.where("ownerId", ctx.auth.userId).orderBy("createdAt", "desc").all()
    )
  },

  mutations: {
    addNote: mutation((ctx, body: string) =>
      ctx.db.notes.insert({ body, ownerId: ctx.auth.userId })
    )
  },

  endpoints: {
    webhook: endpoint({ method: "POST", path: "/integrations/webhook" }, (ctx) => ({
      status: 202,
      body: { ok: true, userId: ctx.auth.userId }
    }))
  },

  messages: {
    typing: message((ctx, data) => {
      const sentToClients = ctx.messages.send({ type: "typing", data, scope: "currentUser" });
      return { ok: true, sentToClients };
    })
  }
});
```

Every handler receives a runtime-owned context:

| Field | Description |
| --- | --- |
| `ctx.db` | Typed table API for app tables. |
| `ctx.auth` | Current Sporades auth state. |
| `ctx.env` | Server-only values from Server env. |
| `ctx.log` | Runtime logger captured by Sporades inspection surfaces. |
| `ctx.messages` | App-message fan-out API. |
| `ctx.mail` | Server-only provider-independent SMTP delivery. |
| `ctx.request` | Custom endpoint request details, only for endpoint handlers. |

Query, mutation, Custom endpoint, App message, context middleware, and mutation
hook handlers may be synchronous or asynchronous. The runtime awaits async
handlers before sending client results, writing HTTP responses, committing
mutation transactions, or refreshing query subscriptions.

Custom endpoints are HTTP escape hatches for integrations such as webhooks.
They are not the primary app data API; queries and mutations over the client
transport remain the default application path.

## Client API

`sporades/client` exports framework-neutral query, mutation, auth, current-user
preferences and file APIs, app-message helpers, a `createHooks` factory,
Vue-native composables, Svelte stores, SolidJS signals, Lit reactive
controllers, and Inferno lifecycle adapters over the same connection.
Vanilla TypeScript clients can use the transport primitives directly:

```ts
import { auth, mutations, queries } from "sporades/client";

const notes = queries.subscribe("notes", (state) => render(state));
await mutations.run("addNote", "Ship it");
const current = await auth.get();
const authState = auth.subscribe((state) => renderAuth(state));

notes.unsubscribe();
authState.unsubscribe();
```

Subscriptions immediately deliver their latest complete state, resubscribe
after reconnect, and may be unsubscribed more than once safely. React and
Preact clients can adapt those same primitives with `createHooks`:

Declared Custom queries may take JSON-compatible positional arguments after
the listener (or after the query name for framework adapters). The arguments
are immutable snapshots, become part of the subscription identity, and are
resubmitted after reconnect and mutation refreshes:

```ts
const notes = queries.subscribe(
  "notesForTeam",
  (state) => render(state),
  teamId,
  { archived: false },
);
```

Object-key order does not create a new channel; array order does. The complete
canonical JSON argument array is limited to 65,536 UTF-8 bytes. Dates,
functions, custom instances, cycles, sparse arrays, non-finite numbers, and
other non-JSON values fail before transport. Runtime-owned and implicit table
queries remain argument-free.

```tsx
import { useEffect, useState } from "react";
import { auth, createHooks, files, onMessage, preferences, sendMessage } from "sporades/client";

const { useAuth, useMutation, useQuery } = createHooks({ useState, useEffect });

const current = await preferences.get();
const next = await preferences.update({ theme: "dark" });
```

Vue clients bind the same complete state and disposal semantics to the active
Vue scope:

```ts
import { onScopeDispose, reactive } from "vue";
import { createVueComposables } from "sporades/client";

const { useAuth, useMutation, useQuery } = createVueComposables({ reactive, onScopeDispose });
```

Vue mutation state keeps `loading` true while any invocation is pending. Its
reactive `data` and `error` belong to the latest invocation; an older call that
settles later cannot overwrite them, while every returned promise still
resolves or rejects for its own invocation.

SolidJS clients bind complete query, mutation, and auth state to an owning
reactive root. `onCleanup` releases query and auth observations, while mutation
state remains pending-counted and latest-invocation deterministic:

```tsx
import { createSignal, onCleanup } from "solid-js";
import { createSolidPrimitives } from "sporades/client";

const { createAuth, createMutation, createQuery } = createSolidPrimitives({ createSignal, onCleanup });
const todos = createQuery("todos");
const addTodo = createMutation("addTodo");
const session = createAuth();
```

Lit clients use reactive controllers tied to the Web Component host lifecycle.
Query and auth controllers request updates on shared transport state, disconnect
exactly once, and reconnect safely; mutation controllers keep concurrent state
pending-counted and latest-invocation deterministic:

```ts
import { LitElement } from "lit";
import { createLitControllers } from "sporades/client";

const { authController, mutationController, queryController } = createLitControllers();
class TodoApp extends LitElement {
  session = authController(this);
  todos = queryController(this, "todos");
  addTodo = mutationController(this, "addTodo");
}
```

Inferno clients bind that complete state to native class-component lifecycle.
Observed adapters mount and dispose idempotently, while mutation state remains
pending-counted and latest-invocation deterministic:

```tsx
import { Component } from "inferno";
import { createInfernoAdapters } from "sporades/client";

const { authAdapter, mutationAdapter, queryAdapter } = createInfernoAdapters();
class TodoApp extends Component {
  session = authAdapter(this);
  todos = queryAdapter(this, "todos");
  addTodo = mutationAdapter(this, "addTodo");
  componentDidMount() { this.session.componentDidMount(); this.todos.componentDidMount(); }
  componentWillUnmount() { this.todos.componentWillUnmount(); this.session.componentWillUnmount(); }
}
```

The browser connects to `/__sporades/ws` on the same origin. The transport
carries:

- query subscriptions and mutation calls,
- auth state reads, email sign-up/sign-in, provider sign-in, and sign-out,
- current-user preference reads and partial JSON-object updates,
- upload URL negotiation and file lifecycle operations,
- public file URL creation and revocation,
- App messages,
- development refresh signals.

The SDK hides raw WebSocket frames from app code. Client-origin App messages
must be mediated by declared server message handlers; Sporades does not relay
arbitrary client packets directly to other clients.

## Data and Migrations

Sporades uses SQLite through Node 22+ `node:sqlite`. Dev sessions store the
database at `.sporades/data.db`. Local Container sessions and Hosted Capsules
mount persistent data at `/app/data`, where the runtime stores SQLite data and
uploaded file bytes.

The `sporades` system table stores schema metadata and runtime-owned state.
App code cannot write it directly.

Current-user preferences are runtime-owned state keyed by the current Sporades
user identity. Capsule authors should use the `preferences` SDK for durable
per-user UI and behavior preferences instead of creating app tables for common
settings. `preferences.update(...)` merges a partial JSON object into the
stored preference object and returns the next value.

Preferences follow the resolved auth identity. Values written during an
Anonymous session remain available when that session links email or Google auth;
sign-out resolves to a fresh Anonymous preference object, and signing back in
restores the linked account's stored preferences. Connected clients for the same
user observe preference updates through `preferences.updated`, while different
users remain isolated.

`preferences.updated` is delivered over the existing client transport as a
same-user convergence signal. The updating client should use the result returned
from `preferences.update(...)`; other connected clients for the same user can
consume `message.data.changes` for the accepted shallow update object,
`message.data.preferences` for the full post-merge preference object, or call
`preferences.get()` to refresh their local UI state.

Additive migrations support:

- creating new app tables,
- adding new fields to existing tables,
- default values for newly added fields,
- adding a unique constraint to an existing table,
- reference-target validation for `Reference()` fields.

Adding a unique constraint rebuilds the table inside one Database adapter
transaction. If the newly added constraint's row copy finds duplicate
existing data, Sporades returns one opaque unique-migration error and rolls back
the attempt. The original table, rows, schema metadata, and hash remain intact,
with no temporary table or rebuild debris. Foreign-key failures and unrelated
unique failures retain their original error instead of being translated as
duplicate migration data.

Removing tables or fields, changing existing field definitions, or removing,
replacing, weakening, or reordering an existing unique constraint is an
unsupported schema change today. The runtime reports a structured error with a
hint to revert the change or move data safely through a separately named table.

## Auth

Auth is runtime-owned and server-side. The client stores an opaque Sporades
session token in `localStorage` and sends it over the WebSocket connection.
Custom endpoint requests may also send the token in the
`x-sporades-session-token` header.

Every browser receives an Anonymous Session by default. Provider auth links to
the existing anonymous account so data created before sign-in follows the user.

Supported provider behavior:

| Provider | Config | Behavior |
| --- | --- | --- |
| Anonymous | `auth.providers.anonymous`, legacy `auth.mode`, or unset | Creates a persistent anonymous Sporades session. |
| Email | `auth.providers.email` | `auth.signUp("email", ...)` links the current session; `auth.signIn("email", ...)` resolves the account later. Browser password changes call `auth.setPassword(email, currentPassword, newPassword)` and require the signed-in owner to verify the current password. Trusted server code can use `ctx.serverAuth.setEmailPassword(email, newPassword)` for reset and administrative flows. Both update an existing email credential with server-side scrypt hashing. |
| Google | `auth.providers.google` with env var names, or legacy Google mode | `auth.signIn("google")` starts a server-owned OAuth redirect and links the verified provider identity. |
| Apple | `auth.providers.apple` with Services ID, Team ID, Key ID, and private-key env name | HTTPS-domain-only server-owned `form_post` flow; runtime ES256 client credential and strictly verified Apple subject link the current Anonymous account. |
| Facebook | `auth.providers.facebook` with app env names and Graph `v23.0` | `auth.signIn("facebook")` starts a server-owned authorization-code redirect, requires the stable Graph profile ID, and accepts profiles without email. |
| Microsoft | `auth.providers.microsoft` with client env names and `common`, `organizations`, `consumers`, tenant-GUID, or tenant-domain selection | `auth.signIn("microsoft")` uses discovered OpenID Connect endpoints and links a verified tenant-qualified subject. |

Provider secrets live in Server env. `sporades.json` stores provider shape,
non-secret options, and env var names, not secret values. Configuring or
disabling one provider merges that provider without replacing siblings or
implicitly disabling Anonymous sessions.

Apple private keys support multiline PEM input and must round-trip exactly
through Server env serialization. Apple callback guidance exposes the stable
callback path but never suggests localhost or plain HTTP; operators register
the path against a Hosted HTTPS origin or an HTTPS development tunnel. Apple
availability is origin-aware: HTTP, localhost, and IP-address origins cannot
start the flow. The first-authorization name is sanitized and persisted while
later callbacks may omit it; private-relay email is profile data rather than
the identity key. Forwarding headers are authoritative only when they agree
with the configured public origin; otherwise OAuth derives its origin from the
actual TLS connection and validated Host. Apple client signing accepts only an
unencrypted P-256 private key, and callback/JWT/JWKS inputs are bounded and
unambiguous before identity work.
Provider configuration updates stage all file replacements before mutation and
recover the exact prior config and Server env state when a commit fails.
Duplicate lexical target aliases are rejected before filesystem inspection;
transaction callers provide canonical non-symlink targets rather than relying
on symlink or hard-link identity discovery.

Session records store `createdAt` and `expiresAt` lifecycle metadata. By
default a session expires 30 days after creation or refresh. Missing, invalid,
or expired session tokens resolve to a fresh anonymous session. Email sign-up
and sign-in rotate the current session token when the linked identity changes.
Google, Microsoft, Apple, and Facebook sign-in refresh the current Session during the server-owned OAuth
callback, preserving the redirect flow without exposing a token handoff in the
browser.
Facebook sign-in follows the same Session-linking contract. Its App Secret and
access token remain server-only; the runtime persists only the stable Facebook
ID and optional selected email, name, and picture profile fields.
An absent Facebook Graph version defaults to `v23.0`; a supplied null,
non-string, malformed, or unsupported version is not treated as absent and
leaves the provider configured/runtime unavailable.

Provider identity authority is the stored `(provider, subject)` identity and
authentication provenance belongs to each Session. The legacy provider column
on a user row is migration data only: linking another provider may update the
shared profile but cannot rewrite the provider reported by another Session.
Legacy Google configuration and status fields normalize immediately into the
provider-neutral runtime contract. Production provider endpoints are fixed;
process-only endpoint overrides are admitted solely by explicit loopback test
seams and cannot be configured through `sporades.json` or Server env.
Provider token exchanges refuse redirects, use bounded deadlines and streamed
response limits, and never expose authorization codes, client credentials, or
provider response bodies. Current-user Jobs persist the enqueueing Session's
provider provenance and replay it across retries and runtime restarts; later
provider switches cannot rewrite an already-enqueued Job actor.
Google, Apple, and Microsoft signing-key and OpenID metadata loads apply the
same redirect, deadline, streamed-size, cancellation, and safe-error boundary.
Process-only provider endpoint overrides accept exact IPv4 and IPv6 loopback
hosts without credentials and reject near-loopback or non-loopback targets.

`sporades auth as <provider> ... --json` is a dev-session helper for tests and
agents. It creates or resolves simulated local identities and can push the
resulting session to connected browser clients.

## File Storage

File storage is platform-managed. App code calls the `files` SDK and stores the
returned File metadata in app tables through normal mutations when it needs a
domain reference.

Implemented file behavior includes:

- `files.upload(file)` and sequential array uploads,
- upload progress and completion callbacks,
- absolute File path metadata and File references by ID or path,
- private file URLs and downloads,
- owner-scoped delete,
- replacement with stable file IDs and new file versions,
- explicit public URL records with `ttlSeconds`, `expiresAt`, or `noExpiry`,
- revocation of public file URLs,
- `404` for missing, deleted, expired, revoked, or unauthorized direct reads.

File metadata exposes logical File IDs and absolute File paths. A File path is
a Capsule-scoped Sporades address, not a filesystem path, object key, Object
bucket, generated runtime read URL, or backend storage location. File
operations that identify an existing file accept a File reference: either a
File ID or an absolute File path that resolves to exactly one live file.

Uploads can pass an explicit absolute File path. Uploads that omit `path` use
the uploaded file name in the Default File bucket, falling back to an
`upload`-style name when no file name exists. Writing new bytes to an existing
live File path overwrites that file, preserves its File ID, and creates a new
File version so private and public read routes cache-bust correctly. Deleting a
file frees its File path; a later write to that path creates a new File ID.

File bytes live under the runtime data area or a declared storage Capsule
service, not in release archives. Local filesystem storage remains the default.
When `services.storage` declares MinIO, the runtime stores bytes through the
internal S3-compatible Storage adapter while keeping file metadata in the
Database adapter and keeping app-facing file APIs unchanged.

## Runtime Modes

### Dev session

`sporades dev` runs a local Node process with the bundled runtime. It watches
`server/`, `client/`, `shared/`, `index.html`, and `sporades.json`. Server and
shared changes restart the runtime; client and HTML changes refresh served
assets. Failed rebuilds keep the last successful Bundle running. Sporades
invokes admitted Vite clients as one-shot production builds under its own
watcher and server. Project Vite plugins may extend the build, while Sporades
retains final precedence over runtime plugins, framework compilation, entry and
output capture, environment isolation, public assets, and source maps. It does
not start a Vite dev server, HMR transport, or second watcher.

Debug surfaces include logs, database listing/dump/query, auth client listing,
and local identity simulation.

### Local Container session

`sporades deploy` bundles the Capsule and runs it in Docker with:

- automatic preparation of the Sporades Base image,
- runtime files mounted read-only,
- Server env mounted read-only when present,
- persistent data mounted read-write,
- the invoking host UID/GID when available, so local Runtime data stays owned by
- the local user; SSH-enabled Container sessions run as the Base image
  `sporades` user `10001:10001`,
- optional SSH access only when `ssh.authorizedKeys` resolves to public
  authorized-key material, with effective state inspected through
  `sporades deploy ssh`,
- one local container per project, replaced on redeploy.

The canonical mount layout lives in
[runtime-layout.md](./runtime-layout.md#local-container-mounts).

### Hosted Capsule

A Hosted Capsule runs on a Host server reached over SSH. The Host helper owns
server-side registry, release installation, Caddy routes, Docker lifecycle,
logs, stats, explicit SSH inspection, and persistent storage.

Registration reserves a Capsule subname on a Hosted domain and creates
authoritative server-side state before a release is pushed. Push installs an
immutable release. Start and restart run the current release. Stop leaves data
intact and routes the registered Capsule to the Hosted Capsule unavailable
response.

Host profiles store the SSH target, Hosted domain, scheme, remote root, and TLS
mode. The Host server registry is authoritative; project-local
`.sporades/remote-binding.json` is only a convenience pointer.

Hosted Capsule SSH access is opt-in through the same top-level
`ssh.authorizedKeys` config. The Host helper publishes container port 22 only
to a Docker-assigned loopback-only port on the Host server, and
`sporades host ssh` is the explicit inspection surface for the effective user,
host, port, key count, and fingerprints.

## CLI Commands

All commands that produce machine-consumed output use the standard envelope:

```json
{ "ok": true, "data": {}, "error": null }
```

Errors use exit code `1` and include an actionable `hint`.

Implemented command families:

- `sporades create [name]`
- `sporades dev`
- `sporades deploy`
- `sporades deploy ssh`
- `sporades logs`
- `sporades db list|dump|query`
- `sporades auth status|set|clients|as`
- `sporades host add|use|current|bind|register|push|start|stop|restart|unregister|delete|list|stats|logs|ssh|bootstrap|invoke`

`sporades dev --json` streams JSON Lines for start and rebuild lifecycle events.
The JSONL log stream used by app `ctx.log` and platform runtime events is a
separate durable stream exposed through `sporades logs tail --json` and indexed
recently for `sporades logs --json`. Host commands support `--json` for
agent-friendly remote operation.

## Privileged Audit Events

Privileged audit events are implemented as a narrow structured JSONL audit
surface for platform-owned security activity. They are not a new audit
database, a centralized logging replacement, or a general-purpose app logging
API.

Every privileged audit event uses the existing JSONL envelope with
`category: "audit"` and includes a timestamp, `level`, `event`, `message`, the
Capsule identity when available, `actorKind`, `operation`, `source`, `surface`,
correlation identity where available, `targetResourceKind`, `outcome`,
`safeErrorCode`, bounded `metadata`, and release identity where the event is
about a Hosted Capsule release. Current actor kinds include `platform`; the
contract also reserves `privileged-server-role`, `captured-user`, and `unknown`
for the future Privileged server role and daemon-log capture. Outcomes describe
audit-event lifecycle state rather than authorization or business result:
`started`, `completed`, `errored`, and `finished`. `finished` is emitted from
the privileged-run `finally` path so log readers can pair a `started` event with
a definitive end event. There is no audit-outcome concept of allowed, denied, or
skipped.
Existing SSH and platform audit emitters must use this same `outcome` vocabulary
in the `outcome` field. Event names may remain domain-specific, such as
`ssh.config.validated` or future SSH auth/session event names, but the outcome
field does not use SSH-specific or legacy success/failure terms.
Required audit metadata is validated and redacted before `started` is emitted so
the first audit event uses the final safe fields. If metadata validation,
redaction, or generation fails, the runtime throws before entering the
privileged path: no privileged audit event is emitted, no privileged context is
handed out, and the callback does not run.
Metadata generation for `ctx.privileged.run(...)` is synchronous and structural:
it uses already-known values supplied in the call options. It must not perform
async DB, file, storage, network, or service work before `started`; authors who
need those facts should gather them before calling the privileged run.
Privileged audit emission is not best-effort. If the runtime cannot emit a
required privileged audit event, the privileged operation throws rather than
continuing without durable audit evidence. When audit emission fails after the
callback has thrown, the audit-emission error is thrown and includes the original
callback error as structured context. When audit emission fails after the
callback has returned, the audit-emission error is thrown and includes the
callback result as structured context so Capsule code can decide how to recover.
That structured callback context is server-side only and must not be exposed in
default client-visible error responses. Browser and external caller responses
remain opaque and stable unless Capsule code explicitly catches the error and
chooses a safe response shape.
When privileged audit emission succeeds and the callback returns, the privileged
run returns the callback result as-is. The runtime does not inspect, sanitize, or
classify successful callback return values; server code that returns privileged
data to a browser or external caller remains responsible for shaping that
response safely.
Privileged runs do not introduce new runtime timeout, retry, or cancellation
policy. They should accept a caller-supplied `AbortSignal` so surrounding server
code, lifecycle code, and Job execution can propagate cancellation
deliberately while preserving the existing handler or lifecycle semantics. The
derived privileged context exposes the same signal as `privilegedCtx.signal` so
privileged helper code can pass cancellation deeper without capturing outer
variables. When no signal is supplied, the runtime provides a fresh per-run
non-aborted default signal on `privilegedCtx.signal`; it must not use a shared
long-lived signal that can accumulate listeners across privileged runs. Any
runtime-owned abort listeners or signal bridges are cleaned up when the run
reaches `finished`.
The derived privileged context is created and exposed to the callback only after
`started` audit emission succeeds. If `started` cannot be emitted, no privileged
context is handed out and the callback does not run.
If a privileged run is called with an already-aborted signal, the runtime still
emits privileged audit events: `started`, then `errored` with a stable abort safe
error code, then `finished`. The callback does not run.
If the signal aborts while the callback is already running, business logic
decides how to respond. The runtime does not interrupt arbitrary callback work;
it propagates the signal and records audit outcomes from the callback's actual
settlement: `completed` then `finished` if it returns, or `errored` then
`finished` if it throws.

The contract is deliberately redacted. Audit metadata must not contain full
public keys, private keys, source key file paths, generated authorized-key
contents, Server env values, session tokens, cookies, authorization headers,
client secrets, raw request bodies, raw stack traces, or raw daemon logs.
Payload size is capped by the same bounded logging envelope used by platform
events.

Audit events are visible through the existing inspection surfaces: local JSONL
log reads, `sporades logs --json`, `sporades logs tail --json`, local Container
log output that merges CLI audit JSONL events, Host helper JSON for direct
helper invocation, and Hosted Capsule log paths where those paths already read
the JSONL or Docker log stream.

Capsule app code cannot forge privileged audit events. App `ctx.log` writes
normal app log events only, browser/client credentials do not carry privileged
authority, and platform-owned helpers are the only current emitters of
privileged audit events.

Current SSH coverage includes Sporades-controlled configuration validation,
local Container lifecycle, Hosted Capsule lifecycle, and explicit inspection
events such as `ssh.config.validated`, `ssh.access.enabled`,
`ssh.access.disabled`, and `ssh.state.inspected`; those events must use
`started`, `completed`, `errored`, and `finished` in their `outcome` field. Real
SSH login/session capture from `sshd` remains future scanner work; the first implementation
should periodically read daemon logs, normalize accepted/failed login and
session activity, and emit redacted privileged audit events without running a
second long-lived Sporades logging daemon.

Security officers should be able to reconstruct incident timelines by Capsule,
time range, operation, actor kind, target resource, and outcome; review started,
completed, errored, and finished privileged activity; verify that browser or app
credentials could not forge a privileged event; and collect redacted evidence
without exposing key material, Server env values, tokens, or raw daemon logs.

## Privileged Server Role

Privileged server role is implemented as a server-only authority for trusted
system-owned execution inside a Capsule. Capsule server code invokes it
explicitly with `ctx.privileged.run(...)` from query, mutation, Custom endpoint,
App message, context middleware, and supported mutation hook contexts. The
callback receives a derived `privilegedCtx` with the familiar server DB API, a
narrow approved File API, `privilegedCtx.signal`, and
`privilegedCtx.auth.userId === "__privileged__"`.

Use the current user identity when work should be authorized as the live
Sporades user represented by `ctx.auth`. The Job Queue uses a captured user
identity when background work should remain accountable to the user who
authorized it after the original request has ended. Privileged Jobs use the
Privileged server role for system-owned work that intentionally has no Sporades
user identity. This authority remains distinct from Capsule roles and cannot be
carried by browser credentials. Future scheduled maintenance or recurring Jobs
use the same explicit actor distinction rather than borrowing a live session.

Privileged server role is not a Capsule role, app admin, Teams membership, user,
session, service account, browser credential, Host profile, or platform operator
login. Capsule admin authorization remains a separate future Capsule roles
track checked through normal ACL rules. Browser/client credentials cannot carry
Privileged server role authority, and table ACL rule contexts cannot call
`ctx.privileged.run(...)`.

Inside an active Privileged callback, `privilegedCtx.teams` is a narrow
read-only exact-Team inspection surface. It can count accepted members, list
the existing safe member projection, list safe active Join-link metadata without
the target email, and
safely inspect a Join link. It performs no current-user membership or admin
check and does not create or capture a Sporades user identity. Current-user
Team listing and email-bound Join-link validation remain unavailable, as do all
Team mutations. An unknown or deleted exact Team fails with `TEAM_NOT_FOUND`;
Join-link inspection keeps its invalid-capability result. These results never
include raw rows, Join capabilities, target emails, credentials, sessions, or provider
subjects. Every inspection rechecks the active callback and AbortSignal after
runtime reads, so detached or aborted in-flight work fails closed rather than
returning a result after its Privileged callback ends.

Every privileged run emits Privileged audit events with actor kind
`privileged-server-role` and the lifecycle outcomes `started`, then
`completed` or `errored`, then `finished`. If a privileged run receives an
already-aborted signal, the callback does not run and the runtime emits an
errored audit event with the stable public message `Privileged run aborted`.
Privileged run metadata is synchronous and structural, privileged audit emission
is not best-effort, and default client-visible errors stay opaque unless
Capsule server code catches and shapes a safe response.

generated runtime artifacts expose the same Privileged server role behavior as
the source runtime code. `npm run build` regenerates the bundled `bin/` and
`dist/` outputs, so Dev sessions, Container sessions, and Hosted Capsules do not
drift from source behavior. A deployed Capsule's server Bundle is built from the
runtime module graph, so a name that fails to reach it is a build error rather
than a runtime one.

## Job Queue

The Job Queue is implemented as a runtime-owned, server-only surface. Capsule
authors declare handlers with `job()` and enqueue them through `ctx.jobs` from
trusted server contexts. `ctx.jobs.enqueue` persists the Job atomically inside
the same mutation, App message, or Custom endpoint transaction as the handler's
app writes, so a handler rollback removes the Job. Worker dispatch starts only
after the transaction commits. A post-commit dispatch registration failure does
not reverse or misreport committed handler work; the durable Job recovers on a
later worker wake or runtime restart. Callers that may retry a workflow should
still supply an idempotency key.

Jobs run as either the captured current Sporades user or, when explicitly
enqueued inside `ctx.privileged.run(...)`, the Privileged server role.
`enqueuedBy` records provenance and does not replace that execution actor.
Current-user `get` and `list` inspection is actor-scoped; Privileged inspection
can enumerate Jobs across actors.

The lifecycle states are `delayed`, `queued`, `running`, `succeeded`, `failed`,
and `cancelled`; only `queued` means ready to run. V1 uses a single worker,
bounded retry, cooperative cancellation, leases, and restart recovery. Delivery
is at least once rather than exactly once, so handlers must be idempotent and
safe to repeat after lease recovery.

Orderly shutdown and Dev restart stop scheduling new Job work, clear immediate,
delayed, and retry worker timers, abort active Job handlers, and await scheduled
worker settlement before the Database adapter and other runtime resources
close. Durable queued and delayed Job state remains stored and recovers on
runtime restart. Unclean interruption retains the ordinary lease-recovery and
at-least-once behavior.

Administrators inspect all bounded Job state using the JSON-only `sporades
jobs`, `sporades deploy jobs`, and `sporades host jobs` commands. This operator
action is separate from actor-scoped Capsule APIs and omits payloads and
idempotency-key values.

A one-time future `availableAt` belongs to the Job Queue. Recurring Schedule
declarations now provide numeric five-field cron evaluation and enqueue ordinary
Privileged Jobs. A Schedule may pin an available IANA timezone or omit it to use
the server timezone resolved by Node at each runtime startup. Because Dev,
Container, and Hosted environments may use different defaults, portable
recurrence should pin its timezone; a changed startup default affects future
occurrences without backfilling the old definition.

Cron fields match local wall-clock values in the effective timezone. Restricted
day-of-month and day-of-week fields use conventional OR behavior. A nonexistent
spring-forward local time creates no occurrence, while both UTC instants in a
repeated fall-back hour are eligible with distinct identities. Authors who need
invariant recurrence without daylight-saving skips or repeats should use `UTC`.

## Job Scheduling

Job scheduling is implemented as a runtime-owned, server-only layer above the
Job Queue. Capsule authors declare named Schedules with `schedule()` alongside
named `job()` handlers. A declaration contains a numeric five-field cron
expression (minute, hour, day-of-month, month, day-of-week), an optional IANA
timezone, JSON-safe payload or bounded async payload factory, ordinary enqueue
retry options, an enabled state, and a `skip` or `latest` missed-run policy.
Seconds, years, cron nicknames, browser declarations, Sessions, captured users,
and dynamically created Schedules are unsupported.

Cron uses numeric lists, ranges, and positive steps; restricted day-of-month and
day-of-week fields use conventional OR behavior. Matching uses local wall-clock
fields in the effective timezone. A nonexistent daylight-saving time creates no
occurrence, while both real UTC instants in a repeated hour are eligible. Omitted
timezones use the server timezone at startup, so portable definitions should pin
an IANA timezone.

`skip` is the default and ignores missed occurrences before resuming with the
next future one. `latest` creates at most the most recent missed occurrence and
then resumes. Runtime state survives restarts through the configured Database
adapter. Declaration changes affect only future occurrences; removal forgets
Schedule state without deleting historical Jobs, and later reuse of the name is
a fresh identity. Deterministic occurrence identity and durable reconciliation
prevent duplicate Job creation across overlapping starts and crashes.

A successful occurrence enqueues one ordinary Job under Schedule provenance and
the Privileged server role execution actor. The scheduler passes only the
declared payload and retry policy. Payload factories may run more than once
during recovery and must tolerate repeated side effects. After enqueue, the Job
Queue exclusively owns execution, retries, cancellation, leases, and results.
Delivery remains **at least once**, so duplicate-safe occurrence creation is not
an exactly-once execution promise. One-time `availableAt` remains Job Queue
behavior and is not recurring scheduling.

Administrators inspect bounded read-only state using JSON-only `sporades
schedules`, `sporades deploy schedules`, and `sporades host schedules` commands
for Dev, local Container, and Hosted targets. Inspection omits payloads and
secrets, does not evaluate Schedules, and returns `schedules: []` for Capsules
without scheduling state. Source planning remains in
`.scratch/job-scheduling/PRD.md` and its issue files for traceability.

## Configuration

`sporades.json` is read by the CLI and passed into the runtime. The runtime
does not discover project configuration by walking the filesystem.

```json
{
  "name": "My App",
  "client": {
    "framework": "react"
  },
  "auth": {
    "providers": {
      "anonymous": true
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

`services.database` declares database Capsule service intent, and
`services.storage` declares storage Capsule service intent. Sporades validates
supported service declarations and generates Docker Compose runtime state under
`.sporades/`; users edit `sporades.json` rather than hand-editing generated
Compose YAML. The current Capsule service implementation is local-only for Dev
sessions and local Container sessions. Hosted Capsule service orchestration
remains future Host-server work.

When a local Dev session or local Container session starts a declared
`services.database` service with `engine: "libsql"`, Sporades injects a
server-only service URL and selects the internal libSQL service-backed Database
adapter for runtime persistence. Embedded SQLite remains the default when no
service-backed database URL is provided. Service connection details are runtime
plumbing and must not be exposed through client bundles, inspection JSON, or app
code. When a local session starts `services.storage` with `engine: "minio"`,
Sporades injects server-only S3-compatible connection env and selects the
internal Storage adapter. MinIO endpoints, credentials, Object bucket names,
object keys, and generated connection details are runtime plumbing; they must
not appear in client bundles or app authoring APIs. Public and private file
URLs remain Sporades HTTP routes, not presigned MinIO or S3 URLs. Local
filesystem file storage remains the default when no storage service is
declared, and `files.storagePath` configures only that local filesystem
adapter's byte directory rather than File path semantics or generic storage
behavior.

Future AWS S3 support should be adapter and configuration wiring over the same
internal Storage adapter contract. It must not require changes to file runtime
call sites, the `files` client SDK, File metadata shape, or app/client APIs.

Sealed Server env lives in ignored Runtime or Host state, is decrypted for Dev
sessions, local Container sessions, and Hosted Capsules, is exposed to server
code as `ctx.env`, and is never bundled into `client.js`. Legacy
`.env.sporades.server` files remain supported for import and fallback when no
sealed envelope exists. The CLI accepts a single value over stdin with
`sporades env set <name> --stdin`, preserving and re-sealing sibling values,
and exposes value-safe presence checks through `sporades env has <name>`.

## Non-Goals

- Being an interpreted IR sandbox.
- Requiring dashboards or browser-based setup for core workflows.
- Supporting Angular.
- Providing file-based routing.
- Supporting external databases as the primary app store.
- Making endpoints the main data API.
- Adding multi-node orchestration, managed backups, DNS automation, or a public
  hosted management API in the current scope.
