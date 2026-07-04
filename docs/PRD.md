# Sporades Product Requirements

> Sporades: an archipelago in the Aegean. Each Capsule is an island; the
> platform is the sea.

## Overview

Sporades is a CLI-first platform for building, running, inspecting, and hosting
small full-stack web Capsules. Developers and agents use deterministic commands
instead of dashboards: `sporades create`, `sporades dev`, `sporades deploy`,
and `sporades host ...`.

Apps run as real Node.js code with SQLite-backed persistence. The CLI bundles
server and client code with esbuild into self-contained runtime files, then runs
those files in a local Dev session, a local Docker Container session, or a
Hosted Capsule on a Host server.

Target users are developers who want zero-config full-stack apps and agentic
LLM systems that need a scriptable build, deploy, inspect, and repair loop.

## Scope Status

### Implemented scope

The repository currently includes:

- `sporades create` scaffolding with template selection, React and Preact
  framework support, `AGENTS.md`, `CLAUDE.md`, `index.html`, `sporades.json`,
  Server env, and optional `npm install` / git initialization.
- `sporades dev` for local Node execution with bundling, file watching,
  debounced rebuilds, runtime restart, WebSocket reconnects, JSONL events,
  SQLite persistence, uploaded file storage, debug logs, and database
  inspection endpoints.
- `sporades deploy` for local Docker Container sessions with read-only runtime
  file mounts, read-write persistent data, and single-container replacement on
  redeploy.
- Local-only Docker Compose Capsule services for declared database service
  intent, shared by Dev sessions and local Container sessions through
  Sporades-owned generated Compose runtime state.
- Host server commands for Host profiles, remote bindings, Hosted Capsule
  registration, release push, start, stop, restart, unregister, storage delete,
  list, stats, logs, bootstrap, and low-level helper invocation.
- Hosted Capsules routed through Caddy with domain-scoped registry, storage,
  route files, deterministic Docker containers, loopback-only published ports,
  Docker ownership labels, and a Host-server-owned unavailable response for
  registered Capsules without a running release.
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
- Additive migrations for new tables and fields. Unsupported destructive or
  shape-changing schema changes fail with a structured error instead of
  silently dropping app data.
- Runtime-owned auth with anonymous sessions, email sign-up/sign-in, Google
  OAuth provider linking, local identity simulation helpers, connected-client
  auth targeting, and provider configuration through `sporades.json` plus
  Server env.
- File storage through the `sporades/client` `files` SDK, including uploads,
  private URLs, downloads, delete, replacement with file versions, public URL
  creation, and revocation.
- App messages over the existing client transport through SDK-level send and
  subscribe/filter APIs.

### Future scope

The following work is intentionally deferred:

- Automatic OpenTelemetry and centralized JSON logging:
  `.scratch/post-v2-platform-hardening-and-ops/issues/04-add-automatic-opentelemetry.md` and
  `.scratch/post-v2-platform-hardening-and-ops/issues/05-centralize-json-server-logging.md`.
- Runtime restart policy for fatal paths:
  `.scratch/post-v2-platform-hardening-and-ops/issues/06-handle-fatal-runtime-paths-with-restart-policy.md`.
- Vector storage, background jobs, and scheduling:
  `.scratch/post-v2-platform-hardening-and-ops/issues/07-evaluate-vector-storage-extension.md`,
  `.scratch/post-v2-platform-hardening-and-ops/issues/08-add-job-queue.md`, and
  `.scratch/post-v2-platform-hardening-and-ops/issues/09-add-job-scheduling.md`.
- Broader production platform work, multi-node hosting, DNS automation,
  dashboards, rollback commands, external database support, and object-storage
  backends. Planning lives under `.scratch/post-v2-platform-hardening-and-ops/`
  until promoted into a concrete release PRD.
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
| `ctx.request` | Custom endpoint request details, only for endpoint handlers. |

Query, mutation, Custom endpoint, App message, context middleware, and mutation
hook handlers may be synchronous or asynchronous. The runtime awaits async
handlers before sending client results, writing HTTP responses, committing
mutation transactions, or refreshing query subscriptions.

Custom endpoints are HTTP escape hatches for integrations such as webhooks.
They are not the primary app data API; queries and mutations over the client
transport remain the default application path.

## Client API

`sporades/client` exports a framework-neutral transport layer, auth and file
APIs, app-message helpers, and a `createHooks` factory:

```tsx
import { useEffect, useState } from "react";
import { auth, createHooks, files, onMessage, sendMessage } from "sporades/client";

const { useAuth, useMutation, useQuery } = createHooks({ useState, useEffect });
```

The browser connects to `/__sporades/ws` on the same origin. The transport
carries:

- query subscriptions and mutation calls,
- auth state reads, email sign-up/sign-in, provider sign-in, and sign-out,
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

Additive migrations support:

- creating new app tables,
- adding new fields to existing tables,
- default values for newly added fields,
- reference-target validation for `Reference()` fields.

Removing tables, removing fields, or changing existing field definitions is an
unsupported schema change today. The runtime reports a structured error with a
hint to revert the change or move data aside and recreate the Runtime directory.

## Auth

Auth is runtime-owned and server-side. The client stores an opaque Sporades
session token in `localStorage` and sends it over the WebSocket connection.
Custom endpoint requests may also send the token in the
`x-sporades-session-token` header.

Every browser receives an anonymous session by default. Provider auth links to
the existing anonymous account so data created before sign-in follows the user.

Supported provider behavior:

| Provider | Config | Behavior |
| --- | --- | --- |
| Anonymous | `auth.providers.anonymous`, legacy `auth.mode`, or unset | Creates a persistent anonymous Sporades session. |
| Email | `auth.providers.email` | `auth.signUp("email", ...)` links the current session; `auth.signIn("email", ...)` resolves the account later. |
| Google | `auth.providers.google` with env var names, or legacy Google mode | `auth.signIn("google")` starts a server-owned OAuth redirect and links the verified provider identity. |

Provider secrets live in Server env. `sporades.json` stores provider shape and
env var names, not secret values.

Session records store `createdAt` and `expiresAt` lifecycle metadata. By
default a session expires 30 days after creation or refresh. Missing, invalid,
or expired session tokens resolve to a fresh anonymous session. Email sign-up
and sign-in rotate the current session token when the linked identity changes.
Google sign-in refreshes the current session token during the server-owned OAuth
callback, preserving the redirect flow without exposing a token handoff in the
browser.

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
- private file URLs and downloads,
- owner-scoped delete,
- replacement with stable file IDs and new file versions,
- explicit public URL records with `ttlSeconds`, `expiresAt`, or `noExpiry`,
- revocation of public file URLs,
- `404` for missing, deleted, expired, revoked, or unauthorized direct reads.

File bytes live under the runtime data area, not in release archives. The
runtime may change storage backends later without changing the app-facing SDK.

## Runtime Modes

### Dev session

`sporades dev` runs a local Node process with the bundled runtime. It watches
`server/`, `client/`, `shared/`, `index.html`, and `sporades.json`. Server and
shared changes restart the runtime; client and HTML changes refresh served
assets. Failed rebuilds keep the last successful Bundle running.

Debug surfaces include logs, database listing/dump/query, auth client listing,
and local identity simulation.

### Local Container session

`sporades deploy` bundles the Capsule and runs it in Docker with:

- automatic preparation of the Sporades Base image,
- runtime files mounted read-only,
- Server env mounted read-only when present,
- persistent data mounted read-write,
- the invoking host UID/GID when available, so local Runtime data stays owned by
  the local user,
- one local container per project, replaced on redeploy.

The canonical mount layout lives in
[runtime-layout.md](./runtime-layout.md#local-container-mounts).

### Hosted Capsule

A Hosted Capsule runs on a Host server reached over SSH. The Host helper owns
server-side registry, release installation, Caddy routes, Docker lifecycle,
logs, stats, and persistent storage.

Registration reserves a Capsule subname on a Hosted domain and creates
authoritative server-side state before a release is pushed. Push installs an
immutable release. Start and restart run the current release. Stop leaves data
intact and routes the registered Capsule to the Hosted Capsule unavailable
response.

Host profiles store the SSH target, Hosted domain, scheme, remote root, and TLS
mode. The Host server registry is authoritative; project-local
`.sporades/remote-binding.json` is only a convenience pointer.

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
- `sporades logs`
- `sporades db list|dump|query`
- `sporades auth status|set|clients|as`
- `sporades host add|use|current|bind|register|push|start|stop|restart|unregister|delete|list|stats|logs|bootstrap|invoke`

`sporades dev --json` streams JSON Lines for start and rebuild lifecycle events.
The JSONL log stream used by app `ctx.log` and platform runtime events is a
separate durable stream exposed through `sporades logs tail --json` and indexed
recently for `sporades logs --json`. Host commands support `--json` for
agent-friendly remote operation.

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
    }
  }
}
```

`services.database` declares database Capsule service intent. Sporades
validates supported service declarations and generates Docker Compose runtime
state under `.sporades/`; users edit `sporades.json` rather than hand-editing
generated Compose YAML. The current Capsule service implementation is
local-only for Dev sessions and local Container sessions. Hosted Capsule
service orchestration remains future Host-server work.

Sealed Server env lives in ignored Runtime or Host state, is decrypted for Dev
sessions, local Container sessions, and Hosted Capsules, is exposed to server
code as `ctx.env`, and is never bundled into `client.js`. Legacy
`.env.sporades.server` files remain supported for import and fallback when no
sealed envelope exists.

## Non-Goals

- Being Lakebed or an interpreted IR sandbox.
- Requiring dashboards or browser-based setup for core workflows.
- Supporting Angular.
- Providing file-based routing.
- Supporting external databases as the primary app store.
- Making endpoints the main data API.
- Adding multi-node orchestration, managed backups, DNS automation, or a public
  hosted management API in the current scope.
