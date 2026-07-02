# Sporades — Product Requirements Document

> Sporades: an archipelago in the Aegean. Each app is an island; the platform is the sea.

## Overview

Sporades is a CLI-first tool for building and running full-stack web apps. It provides the developer experience of Lakebed — `create`, `dev`, `deploy` in three commands — without the artificial constraints of an interpreted IR sandbox. Apps run as real Node.js with a real SQLite database, bundled by esbuild into self-contained files.

**Target users:** developers who want zero-config full-stack apps, and agentic LLM systems that need a deterministic, scriptable deployment pipeline.

**v0 scope:** runs entirely locally. `dev` runs the bundled app in Node with file watching. `deploy` runs the bundled app in a local Docker container. No remote hosting, no PaaS API, no TLS. Hosting is a future concern.

## Core Principles

1. **CLI is the primary interface.** Every command is scriptable, deterministic, and supports `--json` output. No interactive prompts unless strictly necessary. Agents don't use browsers or dashboards.
2. **Bundle, don't install.** esbuild bundles server and client into self-contained files at build time. No `node_modules` at runtime. The host runs `node server.mjs` — nothing else.
3. **Always bundle, even in dev.** Both `dev` and `deploy` run esbuild-bundled code. This eliminates the parity gap between dev and container environments. Dev rebuilds are debounced (100ms); failed rebuilds keep serving the last successful bundle.
4. **No platform lock-in at the code level.** The server API is a thin layer over standard Node.js. If you outgrow Sporades, your bundled `server.mjs` runs anywhere Node runs.
5. **Agent-first scaffolds.** Every project includes `AGENTS.md` so any LLM dropped into a Sporades project immediately knows the structure, rules, and commands.

## Server API (v0)

Mirrors Lakebed's API for familiarity and simplicity. `capsule()` is the initialisation function — it registers the schema with SQLite, configures Better Auth, and wires the table API. Future extensibility (middleware, hooks, custom field types) hooks into this function.

```typescript
import { Boolean, capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "My App",

  schema: {
    todos: table({
      text: String(),
      done: Boolean().default(false),
      ownerId: String()
    })
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    )
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      ctx.db.todos.insert({ text, ownerId: ctx.auth.userId });
    })
  }
});
```

### No endpoints in v0

v0 does not include `endpoint()`. The server exposes queries, mutations, and auth over WebSocket only. Webhooks and HTTP-based integrations are a v1 concern. (Lakebed needed endpoints for Google OAuth callbacks; Sporades handles auth server-side via Better Auth, so that use case doesn't exist.)

### Context (`ctx`)

Every query and mutation handler receives a context:

| Field | Type | Description |
|---|---|---|
| `ctx.db` | `Database` | Typed table API (insert, update, delete, where, orderBy, limit, get, all) |
| `ctx.auth` | `Auth` | `{ userId, displayName, email, picture, isAuthenticated, isGuest, provider }` |
| `ctx.env` | `Record<string, string>` | Server-only environment variables from `.env.sporades.server` |
| `ctx.log` | `Logger` | `{ info, warn, error }` — entries captured and viewable via `sporades logs` |

### Field types

Capitalised to avoid TypeScript keyword collisions:

| Builder | SQLite type | JS type |
|---|---|---|
| `String()` | `TEXT` | `string` |
| `Boolean()` | `INTEGER` (0/1) | `boolean` — Sporades owns serialisation |
| `Date()` | `TEXT` | ISO 8601 `string`; runtime table APIs also accept JavaScript `Date` values and normalise them to ISO strings |

### Auto fields

Every table has three managed fields. App code cannot set or update them:

| Field | Type | Description |
|---|---|---|
| `id` | `TEXT` (UUID) | `crypto.randomUUID()` |
| `createdAt` | `TEXT` (ISO 8601) | Set on insert |
| `updatedAt` | `TEXT` (ISO 8601) | Set on insert, auto-updated on every `update` |

### Extensibility path (v1+)

- **Field types:** `Number()`, `Json()`, `Reference()` — same builder pattern.
- **Middleware:** hook into `capsule()` to wrap context creation.
- **Custom query operators:** extend `TableApi` with new chainable methods.
- **Hooks:** pre/post mutation hooks for validation, audit logging.
- **Endpoints:** `endpoint({ method, path }, handler)` for HTTP escape hatches.

## Client Framework

### Framework-agnostic via factory pattern

`sporades/client` exports a transport layer and a `createHooks` factory. The user provides their framework's primitives; Sporades provides the hook logic.

```tsx
import { useState, useEffect } from "react";
import { createHooks, isAuthenticated } from "sporades/client";

const { useQuery, useMutation, useAuth } = createHooks({ useState, useEffect });
```

The scaffold template handles this wiring — the agent or developer never writes it by hand.

### Supported frameworks (v0)

| Framework | JSX import source | Notes |
|---|---|---|
| **React** (default) | `react` | Largest LLM training data presence |
| **Preact** | `preact` | Smallest bundle |

`sporades.json` declares the framework; esbuild configures `--jsx-import-source` accordingly.

### Client transport

WebSocket connection to `/__sporades/ws` on the same origin (same port as HTTP):

- `query.subscribe` → server pushes `query.result` whenever state changes
- `mutation.run` → request/response with ID correlation
- `auth.get` → returns current auth state
- `auth.signUp("email", { email, password, name? })` → creates an email-linked Sporades session and returns structured success/error JSON
- `auth.signIn("email", { email, password })` → resolves an email-linked Sporades session and returns structured success/error JSON
- `auth.signIn(provider)` → starts a server-owned provider sign-in flow
- `auth.signOut()` → ends the current session, clears the client session token, and refreshes auth state to a fresh anonymous session
- `isAuthenticated()` → resolves whether the current session has a linked authentication method
- `refresh` → client reloads (dev mode, on rebuild)

Auto-reconnect with 500ms backoff. Session token stored in `localStorage`, sent on WebSocket connection.

### No router

Sporades does not provide a router. The scaffold template includes a framework-appropriate router (React Router for React, preact-router for Preact) as a template choice.

## Database

**SQLite via Node 22+ built-in `node:sqlite`** (`DatabaseSync`). No native addons, no npm dependency.

| Property | Detail |
|---|---|
| Local dev | SQLite file at `.sporades/data.db` |
| Container | SQLite file in mounted volume (`/app/data/data.db`) |
| Persistence | Survives dev restarts and container restarts |
| Concurrency | WAL mode. Single writer (one process in v0). |
| Migrations | Schema-version-locked: hash changes → drop and recreate. Data lost on schema change. |

### System table

A `sporades` table auto-created in every database. Stores schema version hash, migration state, and app metadata. Sporades owns it; app code cannot write to it.

### Row cache

`Map<rowId, row>` in-memory cache. Rows cached on read (lazy, per-row), invalidated on write. SQLite is the source of truth. Single writer in v0 means no cache coherence problem.

### Query builder

Chainable API accumulates filters, sort, and limit. Compilation to SQL happens at `.all()` (queries) or at mutation execution. Same pattern as Lakebed's `QueryBuilder`, with SQL execution instead of in-memory filtering.

## Auth

**Better Auth with Anonymous plugin**, owned entirely by the server. The client never sees the auth library.

### v0 auth providers

| Provider | Config | Behaviour |
|---|---|---|
| **Anonymous** (default) | `auth: { providers: { anonymous: true } }`, `auth: { mode: "anonymous" }`, or unset | Every visitor gets a real session via Better Auth's Anonymous plugin. Persistent account, session token in `localStorage`. Data preserved when linking an auth method. |
| **Google OAuth** | `auth: { providers: { google: { clientIdEnv, clientSecretEnv } } }` or legacy `auth: { mode: "google", google: { clientIdEnv, clientSecretEnv } }` | Anonymous by default, `auth.signIn("google")` available for linked sign-in. Links Google identity to existing anonymous account — no data loss. |
| **Email** | `auth: { providers: { email: true } }` | Anonymous by default, `auth.signUp("email", { email, password, name? })` links the current session to an email account, and `auth.signIn("email", { email, password })` resolves that account from a later anonymous session. |

`auth.providers` is the preferred configuration shape for enabling multiple
providers at once. Existing apps using `auth.mode` remain supported for
backwards compatibility.

```json
{
  "auth": {
    "providers": {
      "anonymous": true,
      "google": {
        "clientIdEnv": "GOOGLE_CLIENT_ID",
        "clientSecretEnv": "GOOGLE_CLIENT_SECRET"
      },
      "email": true
    }
  }
}
```

Runtime validation accepts `anonymous`, `google`, and `email`, and rejects
unsupported provider names with structured errors and actionable hints.

### Local identity simulation

`sporades auth as <provider> ... --json` is a dev-session-only helper for agents
and browser tests. Against a running `sporades dev` session, it creates or
resolves a simulated linked identity in Sporades-owned auth tables and returns:

```json
{
  "localStorage": { "key": "sporades.sessionToken", "value": "..." },
  "auth": { "...": "normal ctx.auth fields" }
}
```

The returned `localStorage.value` is the normal opaque Sporades session token
the SDK persists and sends over WebSocket. This helper supports `email` and a
provider-shaped `google` simulation for local tests, but it is not OAuth and
does not accept arbitrary JWTs or provider tokens.

### Auth context

`ctx.auth` is always populated from the Better Auth session:

```typescript
{
  userId: string,          // anonymous account ID or real user ID
  displayName: string,     // "Anonymous" or real name
  email: string | null,
  picture: string | null,
  isAuthenticated: boolean, // false for anonymous-only
  isGuest: boolean,        // true for anonymous-only sessions
  provider: string         // "anonymous" | "google" | ...
}
```

### Implementation

- **Server:** `sporades/server` initialises Better Auth with a `node:sqlite` adapter. Manages sessions, OAuth callbacks, and `ctx.auth` population. The user never touches Better Auth directly.
- **Client:** `sporades/client` calls Sporades auth endpoints, stores session token in `localStorage`, sends it on the WebSocket, and exposes provider-neutral `auth.signUp(provider, credentials)`, `auth.signIn(provider, credentials?)`, and `auth.signOut()` methods. No Better Auth client SDK in the bundle.

## Build Pipeline

### How it works

```
DEVELOPER MACHINE                         CONTAINER (deploy only)
─────────────────                         ──────────────────
npm install react                 │
                                  │  BUILD TIME
sporades dev / sporades deploy    │
  ↓                               │
  esbuild --bundle                │
    server/index.ts → server.mjs  │  (all deps inlined)
    client/index.tsx → client.js  │  (all deps inlined)
  ↓                               │
  [dev] run server.mjs with Node  │
  [deploy] docker run             │
    mount server.mjs (ro) ────────┼──→ node server.mjs
    mount client.js (ro) ─────────┼──→ serve statically
    mount index.html (ro) ────────┼──→ serve at /
    mount .env.sporades.server(ro)┼──→ env vars
    volume /app/data (rw) ────────┼──→ SQLite database
```

### esbuild configuration

Server bundle:
- `bundle: true`, `platform: "node"`, `format: "esm"`
- Source maps: inline (dev), none (deploy)
- External: nothing (all deps inlined, `node:` builtins auto-resolved)

Client bundle:
- `bundle: true`, `platform: "browser"`, `format: "esm"`
- `--jsx-import-source` from `sporades.json` `client.framework`
- Source maps: inline (dev), none (deploy)

### Runtime directory

All build output and runtime artefacts live in `.sporades/` (gitignored). The
canonical project Runtime directory layout is maintained in
[runtime-layout.md](./runtime-layout.md#project-runtime-directory).

## Container Architecture (v0)

### Base image

```
FROM node:22-alpine
```

Stock image, no hardening in v0. v1 will introduce: non-root user, read-only FS, seccomp, cgroups, no-shell.

### Per-Capsule runtime

Container sessions mount release files read-only and persistent data read-write.
The canonical mount layout is maintained in
[runtime-layout.md](./runtime-layout.md#local-container-mounts).

### Container lifecycle

- `sporades deploy` checks `.sporades/binding.json` for an existing container
- If found: stops and removes the old container
- Starts a new container with the same name (`sporades-<project-name>`)
- Writes the new container ID to `binding.json`
- Returns the URL (`http://localhost:<port>`)
- One container per project in v0

## CLI Commands

### `sporades create [name]`

Scaffolds a new project, runs `npm install`, initialises git.

```
my-app/
├── sporades.json
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── .gitignore
├── .env.sporades.server
├── index.html
├── package.json
├── server/
│   └── index.ts
├── client/
│   └── index.tsx
└── shared/
    └── types.ts
```

Flags:
- `--template <name>` — template selection (v0: only "todo")
- `--framework <react|preact>` — client framework (default: react)
- `--no-git` — skip git init
- `--no-install` — skip npm install
- `--json` — output `{ ok, data: { path }, error: null }`

### `sporades dev`

Starts local dev server with live rebuild.

- esbuild bundles server + client on start
- File watcher → debounced rebuild (100ms) → process restart → WebSocket reconnect
- Failed rebuilds: keep serving last successful bundle, report error
- SQLite at `.sporades/data.db` (persists across restarts)
- Debug endpoints: `GET /__sporades/logs`, `GET /__sporades/db`, `GET /__sporades/db/tables`
- Auth: anonymous sessions with configurable providers

Flags:
- `--port <number>` — override dev port (default: from `sporades.json` or `deploy.port`)
- `--json` — JSONL streaming output (one JSON object per event)

JSONL events:
```jsonl
{"ok":true,"data":{"event":"started","url":"http://localhost:3000","port":3000},"error":null}
{"ok":true,"data":{"event":"rebuild","status":"success","durationMs":120},"error":null}
{"ok":true,"data":{"event":"rebuild","status":"failed","error":"Syntax error in server/index.ts:12"},"error":null}
```

### `sporades deploy`

Bundles and runs in a local Docker container.

1. esbuild bundles server + client
2. Check `.sporades/binding.json` for existing container → stop and remove if found
3. `docker run` with mounted bundles, index.html, env file, and data volume
4. Write container ID to `binding.json`
5. Return URL

Flags:
- `--port <number>` — override deploy port (default: from `sporades.json`)
- `--force` — ignore a stale container binding when the recorded container was deleted manually
- `--json` — output `{ ok, data: { url, port, containerId }, error: null }`

### `sporades logs`

Fetches server logs.

Flags:
- `--port <number>` — local dev server port (default: from `sporades.json` or 3000)
- `--follow` — stream new log entries
- `--json` — structured JSON output

### `sporades db`

Database inspection commands.

Subcommands:
- `sporades db list` — list tables
- `sporades db dump` — dump all tables as JSON
- `sporades db query <sql>` — run a read-only SQL query

Flags:
- `--port <number>` — local dev server port
- `--json` — structured JSON output

### `sporades auth`

Auth configuration.

Subcommands:
- `sporades auth status` — show current auth configuration
- `sporades auth set google --client-id <id> --client-secret <secret>` — configure Google OAuth
- `sporades auth set google --client-json <path>` — configure Google OAuth from a downloaded provider credentials JSON file
- `sporades auth clients --json` — list connected browser clients for the running dev session with stable IDs and safe auth metadata for exact targeting
- `sporades auth as email --email <address> --display-name <name> --client current|all|<id> --json` — create a local simulated linked identity against a running dev session, optionally pushing it to connected browser clients while still returning the `localStorage` fallback payload
- After `sporades auth set <provider>`, restart any running `sporades dev` session so the server runtime reloads the updated Server env and auth configuration.

## Output conventions

Every command supports `--json`:

```json
{ "ok": true, "data": { ... }, "error": null }
```

Error output (exit code 1):
```json
{
  "ok": false,
  "data": null,
  "error": {
    "message": "Missing capsule entry: server/index.ts",
    "hint": "Run `sporades create` to scaffold a new project."
  }
}
```

Error messages always include a `hint` field with an actionable suggestion.

## Configuration (`sporades.json`)

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
  }
}
```

| Field | Default | Description |
|---|---|---|
| `name` | (from scaffold) | App name, shown in HTML title and logs |
| `client.framework` | `react` | JSX import source for esbuild |
| `auth.providers` | `{ anonymous: true }` | Enabled auth providers: `anonymous`, `google`, and future `email` |
| `auth.mode` | `anonymous` | Backwards-compatible auth mode: `anonymous` or `google` |
| `deploy.port` | 4000 | Container port |
| `dev.port` | `null` | Dev port override; `null` = same as `deploy.port` |

Config cascade: `sporades.json` → CLI flag → default.

### Server env (`.env.sporades.server`)

```
STRIPE_API_KEY=sk_test_...
OPENAI_API_KEY=sk-...
```

- Max 64 keys, 64KB total
- No `SPORADES_` prefix (reserved)
- Accessible via `ctx.env`
- Mounted read-only at `/app/.env.sporades.server` in container
- v0 stopgap — env files are terrible and will be replaced (see ADR-0001)

## `AGENTS.md` template

Every scaffold includes `AGENTS.md` (and `CLAUDE.md` mirror):

```markdown
# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first tool for
building and running full-stack web apps.

## Rules

- Server code goes in `server/`, client code in `client/`, shared code in `shared/`.
- Use `sporades/server` only from `server/*.ts`.
- Use `sporades/client` only from `client/*.tsx`.
- Data is accessed through queries. Changes go through mutations.
- No endpoints in v0 — WebSocket only.
- No file-based routing. Use the router included in the scaffold template.
- All imports must be from Sporades, the configured framework, or relative paths.
- Do not use Node built-ins in client code.
- Auth is available via `ctx.auth` on the server, `useAuth()` on the client.
- Server env vars: define in `.env.sporades.server`, access via `ctx.env`.
- Keep `shared/` free of DOM, Node, env, and Sporades runtime imports.

## Commands

sporades dev      # local dev server with live rebuild
sporades deploy   # bundle and run in Docker container
sporades logs     # view server logs
sporades db list  # list database tables
sporades db dump  # dump database as JSON

## Structure

- `server/index.ts` — schema, queries, mutations
- `client/index.tsx` — UI entrypoint
- `shared/` — pure TypeScript shared by client and server
- `index.html` — HTML shell (user-owned)
- `sporades.json` — project configuration
```

## Technical dependencies

### CLI package (`sporades`)

| Dependency | Purpose |
|---|---|
| esbuild | Build pipeline |
| ws | WebSocket server |
| chokidar | File watching |
| better-auth | Auth library (server-side) |
| Docker CLI | Container management (system dependency, not npm) |

### Runtime (bundled into `server.mjs`)

| Dependency | Source |
|---|---|
| better-auth | Inlined from `sporades/server` |
| ws | Inlined from `sporades/server` |
| node:sqlite | Node 22+ built-in |
| node:http | Node built-in |
| node:crypto | Node built-in |

### Client (bundled into `client.js`)

| Dependency | Source |
|---|---|
| react / preact | User's `node_modules` (installed by scaffold) |
| sporades/client | Inlined by esbuild |

## v0 Scope

### In scope

- `sporades create` — scaffold with todo template, npm install, git init
- `sporades dev` — local dev server, live rebuild, SQLite, WebSocket real-time, JSONL streaming
- `sporades deploy` — bundle and run in local Docker container
- `sporades logs` — view server logs
- `sporades db` — inspect database (list, dump, query)
- `sporades auth` — inspect auth providers and configure Google OAuth
- Server API: `capsule({ schema, queries, mutations })` — no endpoints
- Client API: `createHooks` factory, transport layer
- Field types: `String()`, `Boolean()`, `Date()`
- Auth: Better Auth anonymous sessions + Google OAuth, with multi-provider config
- Database: SQLite via `node:sqlite` (Node 22+), row-level cache
- Client frameworks: React (default), Preact
- `--json` output on all commands, JSONL streaming for `dev`
- `AGENTS.md` + `CLAUDE.md` in scaffolds
- Container: stock `node:22-alpine`, no hardening
- Process restart on dev rebuild with lifecycle hooks for future hot reload

### Out of scope (v1+)

- Endpoints (`endpoint()`)
- Additional field types (`Number()`, `Json()`, `Reference()`)
- Additional client frameworks (Solid, Svelte, Vue)
- Additional runtime auth providers (GitHub, Microsoft, email sign-in)
- Custom domains
- Remote hosting / PaaS
- Database migrations (incremental)
- Middleware / hooks
- File storage
- Container hardening (seccomp, read-only FS, non-root)
- Hot reload (lifecycle hooks exist but v0 uses process restart)
- Multiple containers / environments per project
- Metrics / dashboards
- Angular (explicitly never)

## Non-goals

- Being Lakebed. Sporades runs real code in real containers. No IR, no symbolic execution, no source-code scanning.
- Competing with Vercel/Netlify for enterprise workloads. This is for prototype-to-small-production apps.
- Supporting Postgres or any external database. Use a different platform if you need that.
- Supporting Angular. Its build system is incompatible with the esbuild-only pipeline.
- File-based routing. The client router is a template choice, not a Sporades concern.
- Being fully framework-agnostic on day one. JSX frameworks first; template-based frameworks are a v1 concern.
