# Sporades

A CLI-first tool for building and running full-stack web apps. Agents and developers scaffold, develop, and deploy apps through a single CLI. v0 runs entirely locally — no remote hosting.

## Language

**Capsule**:
The deployable unit of a Sporades app — server bundle, client bundle, config, and data volume combined into a running container.
_Avoid_: app (too generic), project (the scaffold), deployment (the act)

**Dev session**:
A local Node process running the bundled app with file watching, hot rebuild, and SQLite persistence. For iteration speed.
_Avoid_: dev server (it's more than a server — it's a whole feedback loop)

**Container session**:
A local Docker container running the bundled app with the locked base image, mounted bundle files, and a persistent SQLite volume. For production-like testing.
_Avoid_: deploy (that's the command), deployment (remote connotation)

**Bundle**:
The esbuild output — a self-contained JavaScript file with all dependencies inlined. Server bundle (`server.mjs`) and client bundle (`client.js`).
_Avoid_: build (that's the act), artifact (too abstract)

**Base image**:
The Docker image (Node 22 alpine) that all container sessions use. v0 uses the stock image with no hardening. v1 will introduce a locked, hardened image (non-root, read-only FS, seccomp).
_Avoid_: runtime image, host image

## Server runtime

**sporades/server**:
A runtime context, not just a set of exports. Internally manages the SQLite connection, Better Auth instance, env vars, and row-level cache. When imported, it initialises the runtime. `capsule()` registers the app definition (schema, queries, mutations, endpoints) against this runtime. The user never touches the runtime directly.
_Avoid_: server module, server library (it's a living context, not a static library)

**capsule()**:
The initialisation function. Called with the app definition. Registers the schema with SQLite (creating tables, updating the system table), configures Better Auth, and wires the table API. This is where app bootstrap happens — not an identity function. Future extensibility (middleware, hooks, custom field types) hooks into this function.
_Avoid_: app definition (that's the argument, not the function), config function

## Field types

Sporades field builders use capitalised names to avoid collisions with TypeScript's `string` and `boolean` primitive type keywords.

**String()**:
A text field. Maps to SQLite `TEXT`. JavaScript `string` ↔ SQLite `TEXT`.
_Avoid_: string() (lowercase — collides with TS keyword)

**Boolean()**:
A boolean field. Maps to SQLite `INTEGER`. JavaScript `true`/`false` ↔ SQLite `1`/`0`. Sporades owns the serialisation/deserialisation — the user never sees `0` or `1`.
_Avoid_: boolean() (lowercase — collides with TS keyword)

## Auto fields

Every table has three managed fields added automatically by Sporades. App code cannot set or update them.

**id**: UUID string (`crypto.randomUUID()`). SQLite `TEXT`.
**createdAt**: ISO 8601 timestamp string. SQLite `TEXT`.
**updatedAt**: ISO 8601 timestamp string. SQLite `TEXT`. Auto-updated on every `update` operation.
_Avoid_: primary key, timestamp fields (these are Sporades-managed, not user-defined)

## Auth

Sporades owns auth entirely on the server side. The client never sees the auth library.

**Anonymous session**:
A real session created automatically for every visitor via Better Auth's Anonymous plugin. Not a fake guest ID — a persistent account with a session token. Data created anonymously is preserved when the user links an authentication method (e.g. Google OAuth).
_Avoid_: guest mode (implies fake/transient — these are real sessions), guest user

**Session token**:
A string stored in `localStorage` on the client and sent on the WebSocket connection. The server verifies it via Better Auth on every request. No auth SDK in the client bundle.
_Avoid_: auth token, JWT (implementation detail of Better Auth)

**Linked account**:
An anonymous session upgraded with a real authentication method (Google OAuth, etc.). The user's data follows them because the auth method is linked to the existing account, not a new one.
_Avoid_: upgrade, migration (those are schema concerns, not auth)

## Client transport

Sporades is client-framework-agnostic. `sporades/client` exports a transport layer (WebSocket connect, query subscribe, mutation send, auth state) and a `createHooks` factory that takes a framework's primitives (`useState`, `useEffect`) and returns ready-to-use hooks (`useQuery`, `useMutation`, `useAuth`). The user wires one line; the scaffold template handles it by default.

**createHooks**:
A factory function exported by `sporades/client`. Accepts `{ useState, useEffect }` from any JSX framework (React, Preact, Solid) and returns Sporades hooks bound to that framework's reactivity model.
_Avoid_: useQuery (that's what it produces, not what it is), hooks provider

## Routing

Sporades does not provide a router. The scaffold template includes a framework-appropriate router (e.g. React Router for React apps) as a template choice. Routing is not a Sporades concern.

## Data

**System table**:
A `sporades` table auto-created in every app's SQLite database. Stores schema version, migration state, and app metadata. Sporades owns it; app code cannot write to it.
_Avoid_: migration table, metadata table

**Schema version**:
A hash of the capsule's schema definition, stored in the system table. On startup, if the hash differs from the stored version, all app tables are dropped and recreated. Data is lost on schema change. This is a v0 simplification — v1 will support incremental migrations.
_Avoid_: migration version, database version

**Row cache**:
A `Map<rowId, row>` in-memory cache. Rows are cached on read (lazy, per-row) and invalidated on write. SQLite is the source of truth. Single writer in v0 (one dev session or one container), so no cache coherence problem.
_Avoid_: table cache (it's row-level, not table-level), data cache