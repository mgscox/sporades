# Sporades — Product Requirements Document

> Sporades: an archipelago in the Aegean. Each app is an island; the platform is the sea.

## Overview

Sporades is a CLI-first PaaS for spinning up and hosting full-stack web applications. It provides the developer experience of Lakebed — `create`, `dev`, `deploy` in three commands — without the artificial constraints of an interpreted IR sandbox. Apps run as real Node.js in isolated containers with a locked base image, mounted bundle files, and a persistent SQLite volume.

**Target users:** developers who want zero-config full-stack apps, and agentic LLM systems that need a deterministic, scriptable deployment pipeline.

## Core Principles

1. **CLI is the primary interface.** Every command is scriptable, deterministic, and supports `--json` output. No interactive prompts unless strictly necessary. Agents don't use browsers or dashboards.
2. **Bundle, don't install.** esbuild bundles server and client into self-contained files at build time. No `node_modules` at runtime. The host runs `node server.mjs` — nothing else.
3. **Real isolation, not regex.** Container security (seccomp, non-root, read-only FS, cgroups) instead of source-code scanning for forbidden patterns.
4. **No platform lock-in at the code level.** The server API is a thin layer over standard Node.js. If you outgrow Sporades, your bundled `server.mjs` runs anywhere Node runs.
5. **Agent-first scaffolds.** Every project includes `AGENTS.md` so any LLM dropped into a Sporades project immediately knows the structure, rules, and commands.

## Server API (v0)

Mirrors Lakebed's API for familiarity and simplicity. Extensible by design — `capsule()` is an identity function today, interceptable for enrichment in v1.

```typescript
import { Boolean, capsule, endpoint, mutation, query, String, table, text } from "sporades/server";

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
  },

  endpoints: {
    status: endpoint({ method: "GET", path: "/api/status" }, () => text("ok"))
  }
});
```

### Context (`ctx`)

Every query, mutation, and endpoint handler receives a context:

| Field | Type | Description |
|---|---|---|
| `ctx.db` | `Database` | Typed table API (insert, update, delete, where, orderBy, limit, get, all) |
| `ctx.auth` | `Auth` | `{ userId, displayName, email, picture, isAuthenticated, isGuest, provider }` |
| `ctx.env` | `Record<string, string>` | Server-only environment variables from `.env.sporades.server` |
| `ctx.log` | `Logger` | `{ info, warn, error }` — entries captured and viewable via `sporades logs` |

### Extensibility path (v1+)

- **Field types:** `number()`, `date()`, `json()`, `reference()` — same builder pattern, extend the field registry.
- **Middleware:** wrap context creation to inject custom services.
- **Custom query operators:** extend `TableApi` with new chainable methods.
- **Hooks:** pre/post mutation hooks for validation, audit logging, etc.

## Client Framework

### v0: JSX-based frameworks

esbuild's JSX transform is configured via a single flag per framework. `sporades.json` declares the framework; the build pipeline configures esbuild accordingly.

```json
{
  "client": {
    "framework": "react"
  }
}
```

| Framework | v0 support | Config |
|---|---|---|
| **React** | ✅ | `--jsx-import-source=react` |
| **Preact** | ✅ | `--jsx-import-source=preact` |
| **Solid** | ✅ | `--jsx-import-source=solid-js` |

React is the default — it has the largest presence in LLM training data, making agent-authored code more reliable.

### v1+: Template-based frameworks

Svelte and Vue require esbuild plugins (Svelte compiler, `@vue/compiler-sfc`) in the build pipeline. Angular requires its own build system and is explicitly out of scope.

### Client API

The client receives real-time data via WebSocket. The transport is framework-agnostic — hooks are thin wrappers over a shared WebSocket layer.

```typescript
import { useQuery, useMutation, useAuth } from "sporades/client";
// React hooks: useQuery, useMutation, useAuth
// Preact hooks: same API, preact/hooks adapter
```

### Client transport

WebSocket connection to `/__sporades/ws` on the same origin:

- `query.subscribe` → server pushes `query.result` whenever state changes
- `mutation.run` → request/response with ID correlation
- `auth.get` → returns current auth state
- `refresh` → client reloads (dev mode, on rebuild)

Auto-reconnect with 500ms backoff. Query cache + listener pattern for reactive updates.

## Database

**SQLite via Node 22+ built-in `node:sqlite`** (`DatabaseSync`). No native addons, no npm dependency, no `better-sqlite3`.

| Property | Detail |
|---|---|
| Local dev | SQLite file in `.sporades/data.db` |
| Production | SQLite file in mounted volume (`/app/data/data.db`) |
| Persistence | Survives container restarts. Local dev state persists across `sporades dev` restarts (unlike Lakebed). |
| Concurrency | WAL mode enabled. Single-writer, multiple-reader. Sufficient for prototype-class apps. |
| Migrations | v0: schema derived from `capsule()` definition. Table creation is automatic. v1: explicit migration support. |

### Why not Postgres

If you need Postgres, you've outgrown Sporades. The product is intentionally scoped to prototype-to-small-production apps. SQLite in a volume handles tens of thousands of rows and low concurrency — more than enough for the target use case.

## Auth

**Strategy:** wrapped auth layer providing guest mode by default, with opt-in provider configuration. The user shouldn't need to understand auth internals — `sporades.json` configures it, the CLI manages it.

### v0 auth modes

| Mode | Config | Behaviour |
|---|---|---|
| **Guest** (default) | `auth: { mode: "guest" }` or unset | Every visitor gets a random `userId` (`guest:<random>`). `isGuest: true`. No sign-in UI. |
| **Google OAuth** | `auth: { mode: "google", clientId, clientSecret }` | Guest by default, `<SignInWithGoogle />` component available for upgrade. |

### Auth context

`ctx.auth` is always populated, even in guest mode:

```typescript
{
  userId: string,          // "guest:abc123" or real user ID
  displayName: string,     // "Guest" or real name
  email: string | null,
  picture: string | null,
  isAuthenticated: boolean, // false for guests
  isGuest: boolean,        // true for unauthenticated visitors
  provider: string         // "guest" | "google" | ...
}
```

### v1+ auth

- Additional OAuth providers (GitHub, Microsoft, etc.)
- Email/password (if demand exists)
- Magic link
- Session management API

## Build Pipeline

### How it works

```
DEVELOPER MACHINE                         HOST
─────────────────                         ──────────────────
npm install <framework>           │
                                  │  BUILD TIME
sporades dev / sporades deploy    │
  ↓                               │
  esbuild --bundle                │
    server/index.ts → server.mjs  │  (all deps inlined)
    client/index.tsx → client.js  │  (all deps inlined)
  ↓                               │
  [dev] run locally with Node     │
  [deploy] sync bundles to host ──┼──→ node server.mjs  (in container)
                                  │    serve client.js   (static)
                                  │    SQLite volume     (persistent)
```

### esbuild configuration

Server bundle:
- `bundle: true` — inline all dependencies
- `platform: "node"` — Node.js target
- `format: "esm"` — ES module output
- `external: []` — nothing is external (except `node:` builtins, which esbuild handles automatically)
- Source maps: inline (dev), none (production)

Client bundle:
- `bundle: true` — inline all dependencies
- `platform: "browser"` — browser target
- `format: "esm"` — ES module output
- `--jsx-import-source` — from `sporades.json` client.framework
- Source maps: inline (dev), none (production)

### What can't be bundled

| Case | Handling |
|---|---|
| Native addons (`.node` files) | Mark as external, pre-install in base image. v0: not needed — `node:sqlite` is built-in. |
| Dynamic `require(variable)` | esbuild warns. Rewrite to static imports. |
| Runtime config file reads | Rare. Workaround: inline config at build time. |

For v0, the target is zero externals. The server and client bundles are fully self-contained.

## Container Architecture

### Base image (locked, shared across all apps)

```dockerfile
FROM node:22-alpine-slim
USER node
# No shell, no package manager cache, no build tools
# Just Node.js
```

- ~50MB, never changes per-app
- Non-root user enforced
- No `node_modules` in the image

### Per-app runtime

```
Container
├── Base image (read-only, shared)
├── /app/server.mjs     ← mounted read-only (esbuild output)
├── /app/client.js      ← mounted read-only (esbuild output)
├── /app/sporades.json  ← mounted read-only (config)
├── /app/data/          ← mounted read-write (SQLite volume)
└── /tmp                ← tmpfs (ephemeral)
```

### Security hardening

| Layer | Mechanism |
|---|---|
| Kernel isolation | Docker namespaces + cgroups |
| Syscall filtering | seccomp profile (block `clone()`, `mount()`, `ptrace()`, etc.) |
| Filesystem | `--read-only` root, only `/app/data` writable |
| Privilege | Non-root user, `--no-new-privileges` |
| Network | v0: unrestricted egress. v1: configurable allowlist. |
| Resources | CPU + memory limits per container |
| Capabilities | Drop all, add none |

### Why this is better than Lakebed's regex scanner

Lakebed scans source code with regex for forbidden patterns (`/fetch/`, `/eval/`, `/process/`). This is bypassable through obfuscation, string concatenation, and encoding. Container security is enforced by the kernel — a seccomp profile blocking `mount()` can't be bypassed by clever JavaScript.

## CLI Commands

### `sporades create [name]`

Scaffolds a new project from the default template.

```
my-app/
├── sporades.json          # config (framework, auth mode, app name)
├── AGENTS.md              # instructions for AI agents
├── CLAUDE.md              # mirror of AGENTS.md (Claude convention)
├── README.md
├── .gitignore
├── server/
│   └── index.ts           # capsule definition (schema, queries, mutations, endpoints)
├── client/
│   └── index.tsx          # UI entrypoint
└── shared/
    └── types.ts            # shared types between client and server
```

Flags:
- `--template <name>` — template selection (v0: only "default")
- `--framework <react|preact>` — client framework (default: react)
- `--no-git` — skip git init
- `--json` — output scaffold path as JSON

Initialises git with a first commit (unless `--no-git`).

### `sporades dev`

Starts local dev server with live rebuild.

- HTTP server on port 3000 (configurable via `--port`)
- esbuild bundles server + client on start
- File watcher → debounced rebuild (100ms) → WebSocket push `refresh` to client
- SQLite at `.sporades/data.db` (persists across restarts)
- Debug endpoints:
  - `GET /__sporades/logs` — server log entries
  - `GET /__sporades/db` — full database dump
  - `GET /__sporades/db/tables` — table list
- Auth: guest mode (configurable)

Flags:
- `--port <number>` — port (default: 3000)
- `--json` — output `{ url, port }` as JSON

### `sporades deploy`

Bundles and deploys to the managed PaaS target.

1. esbuild bundles server + client (~2s)
2. POST bundles to Sporades PaaS API (~1s)
3. PaaS restarts container with new mounted files (~1s)
4. Returns live URL

Flags:
- `--json` — output `{ url, deployId, updatedAt, expiresAt }` as JSON
- `--target <name>` — deploy target (v0: only the default PaaS)

### `sporades logs [deployId]`

Fetches server logs for a deploy.

Flags:
- `--port <number>` — local dev server port (for local logs)
- `--follow` — stream logs (if supported by PaaS)
- `--json` — structured JSON output

### `sporades db`

Database inspection commands.

Subcommands:
- `sporades db list` — list tables
- `sporades db dump` — dump all tables as JSON
- `sporades db query <sql>` — run a read-only SQL query

Flags:
- `--port <number>` — local dev server port (default: 3000)
- `--json` — structured JSON output

### `sporades auth`

Auth configuration.

Subcommands:
- `sporades auth status` — show current auth configuration
- `sporades auth set google --client-id <id> --client-secret <secret>` — configure Google OAuth

### `sporades inspect [deployId]`

Shows deploy metadata, status, resource usage, and limits.

Flags:
- `--json` — structured JSON output

## Output conventions

Every command supports `--json` and produces machine-readable output when used:

```json
{
  "ok": true,
  "data": { ... },
  "error": null
}
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

Error messages always include a `hint` field with an actionable suggestion — designed for agents to self-correct without human intervention.

## `AGENTS.md` template

Every scaffolded project includes `AGENTS.md` (and `CLAUDE.md` mirror) with:

```markdown
# Sporades App Instructions

This directory is for a Sporades app. Sporades is a CLI-first PaaS for
full-stack web apps.

## Rules

- Server code goes in `server/`, client code in `client/`, shared code in `shared/`.
- Use `sporades/server` only from `server/*.ts`.
- Use `sporades/client` only from `client/*.tsx`.
- Data is accessed through queries. Changes go through mutations.
- Endpoints are an escape hatch for HTTP-based flows (webhooks, etc.).
- No file-based routing. Use the client router from `sporades/client`.
- All imports must be from Sporades, the configured framework, or relative paths.
- Do not use Node built-ins in client code.
- Auth is available via `ctx.auth` on the server, `useAuth()` on the client.
- Server env vars: define in `.env.sporades.server`, access via `ctx.env`.

## Commands

```sh
sporades dev      # local dev server with live rebuild
sporades deploy   # bundle and deploy to PaaS
sporades logs     # view server logs
sporades db list  # list database tables
sporades db dump  # dump database as JSON
```

## Structure

- `server/index.ts` — schema, queries, mutations, endpoints
- `client/index.tsx` — UI entrypoint
- `shared/` — pure TypeScript shared by client and server
- `sporades.json` — project configuration
```

## Hosting (PaaS layer)

### v0: Managed PaaS

The deploy target is a managed API that accepts bundled files and runs them in a container. The user does not configure infrastructure.

**Deploy flow:**
1. CLI bundles server + client with esbuild
2. CLI authenticates with PaaS (token stored in `~/.sporades/auth.json`)
3. CLI POSTs `{ serverBundle, clientBundle, config, serverEnv }` to PaaS API
4. PaaS mounts bundles into a container with the locked base image
5. PaaS returns `{ url, deployId, expiresAt }`

**PaaS requirements:**
- Accept file upload (not Docker images)
- Manage container lifecycle (start, stop, restart)
- Provide persistent volume per deploy
- Handle TLS termination
- Provide a subdomain URL
- Rate limiting per deploy (abuse prevention)

**Candidate platforms:**
- Fly.io (API-driven, volumes, Machines — strongest fit)
- Railway (API-driven, simple)
- Custom supervisor on a VPS (fallback, more control)

### v1+: Self-hosted option

`sporades deploy --target self` deploys to a user's own VPS running the Sporades supervisor. The supervisor is a small daemon that:
- Watches for new bundle uploads
- Manages container lifecycle
- Routes traffic via Caddy/Traefik
- Manages TLS via Let's Encrypt

## Configuration (`sporades.json`)

```json
{
  "name": "My App",
  "client": {
    "framework": "react"
  },
  "auth": {
    "mode": "guest"
  },
  "deploy": {
    "target": "managed"
  }
}
```

### Environment variables

Server-only environment variables are defined in `.env.sporades.server`:

```
STRIPE_API_KEY=sk_test_...
OPENAI_API_KEY=sk-...
```

- Max 64 keys, 64KB total (same limits as Lakebed)
- No `SPORADES_` prefix (reserved)
- Accessible via `ctx.env` in server handlers
- Synced to PaaS on `sporades deploy` (encrypted in transit, stored as secrets)

## v0 Scope

### In scope

- `sporades create` — scaffold with default template, git init
- `sporades dev` — local dev server, live rebuild, SQLite, WebSocket real-time
- `sporades deploy` — bundle and deploy to managed PaaS
- `sporades logs` — view server logs
- `sporades db` — inspect database (list, dump, query)
- `sporades inspect` — deploy metadata and status
- `sporades auth` — configure auth mode (guest, Google OAuth)
- Server API: `capsule({ schema, queries, mutations, endpoints })`
- Client API: `useQuery`, `useMutation`, `useAuth`, router, `SignInWithGoogle`
- Field types: `string()`, `boolean()`
- Auth: guest mode + Google OAuth
- Database: SQLite via `node:sqlite` (Node 22+)
- Client frameworks: React (default), Preact
- `--json` output on all commands
- `AGENTS.md` + `CLAUDE.md` in scaffolds
- Container isolation: non-root, read-only FS, seccomp, cgroups

### Out of scope (v1+)

- Additional field types (`number()`, `date()`, `json()`, `reference()`)
- Additional client frameworks (Solid, Svelte, Vue)
- Additional auth providers (GitHub, Microsoft, email)
- Custom domains
- Self-hosted deploy target
- Database migrations
- Middleware / hooks
- File storage
- Scaling / multiple replicas
- Metrics / dashboards
- Angular (explicitly never)

## Technical dependencies

| Dependency | Purpose | Bundled? |
|---|---|---|
| esbuild | Build pipeline (server + client bundling) | CLI only, not in output |
| ws | WebSocket server (dev server real-time) | Bundled into server.mjs |
| preact / react | Client UI framework | Bundled into client.js |
| node:sqlite | Database (Node 22+ built-in) | Not bundled — built into Node |
| node:http | HTTP server | Not bundled — built into Node |
| node:crypto | IDs, hashing | Not bundled — built into Node |

## Non-goals

- Being Lakebed. Sporades runs real code in real containers. No IR, no symbolic execution, no source-code scanning.
- Competing with Vercel/Netlify for enterprise workloads. This is for prototype-to-small-production apps.
- Supporting Postgres or any external database. Use a different platform if you need that.
- Supporting Angular. Its build system is incompatible with the esbuild-only pipeline.
- File-based routing. The client router is programmatic.
- Being fully framework-agnostic on day one. JSX frameworks first; template-based frameworks are a v1 concern.

## Open questions for resolution during implementation

1. **PaaS partner**: Fly.io vs Railway vs custom supervisor — decide based on API quality, volume support, and pricing for small deploys.
2. **Deploy expiry**: should free deploys expire? Lakebed uses 7-day TTL. Consider same for unclaimed deploys.
3. **Rate limits**: what are reasonable defaults for v0? (Lakebed: 10K req/day, 1K mutations/day, 1MB state.)
4. **CLI auth flow**: device code flow (like Lakebed's claim) vs API key? Agents need non-interactive auth.
5. **Multi-deploy management**: does `sporades deploy` always create a new deploy, or update an existing one? Need a binding/metadata file (like Lakebed's `lakebed.json`).