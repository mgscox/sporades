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
The locked, shared Docker image (Node 22 alpine) that all container sessions use. Never changes per-app.
_Avoid_: runtime image, host image

**System table**:
A `sporades` table auto-created in every app's SQLite database. Stores schema version, migration state, and app metadata. Sporades owns it; app code cannot write to it.
_Avoid_: migration table, metadata table

**Schema version**:
A hash of the capsule's schema definition, stored in the system table. On startup, if the hash differs from the stored version, all app tables are dropped and recreated. Data is lost on schema change. This is a v0 simplification — v1 will support incremental migrations.
_Avoid_: migration version, database version

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