# Sporades

A CLI-first tool for building, running, inspecting, and hosting full-stack web Capsules. Agents and developers use one CLI for local Dev sessions, local Container sessions, and Hosted Capsules on Host servers.

## Language

**Capsule**:
The deployable unit of a Sporades app — server bundle, client bundle, config, and data volume combined into a running container.
_Avoid_: app (too generic), project (the scaffold), deployment (the act)

**Dev session**:
A local Node process running the bundled app with file watching, hot rebuild, and SQLite persistence. For iteration speed.
_Avoid_: dev server (it's more than a server — it's a whole feedback loop)

**Public Dev session**:
A Dev session mode that deliberately relaxes local access defaults for temporary demos, device testing, or public tunneling. It is never the default and does not apply to Container sessions or Hosted Capsules.
_Avoid_: open dev, unsafe mode, fully accessible dev

**Container session**:
A local Docker container running the bundled app with the base image, mounted bundle files, and a persistent SQLite volume. For production-like testing.
_Avoid_: deploy (that's the command), deployment (remote connotation)

**Container SSH access**:
Opt-in SSH access into a local Container session or Hosted Capsule using configured authorized public keys. It is a compatibility and emergency access path, not the primary Sporades management interface.
_Avoid_: SSH to Docker, interactive management, default shell access

**Capsule service**:
A runtime companion service provisioned for a Capsule, such as Postgres, Redis, or object storage. Capsule services are owned by the Capsule's execution environment rather than by app code.
_Avoid_: sidecar, dependency, add-on

**Bundle**:
The esbuild output — a self-contained JavaScript file with all dependencies inlined. Server bundle (`server.mjs`) and client bundle (`client.js`).
_Avoid_: build (that's the act), artifact (too abstract)

**Bundle pipeline**:
The build-time path that turns a Capsule's server entry, client entry, `sporades.json`, `index.html`, and Server env into the server Bundle and client Bundle in the Runtime directory. Used by both Dev session and Container session so they run the same bundled code.
_Avoid_: build system (too broad), compiler (only part of the work), bundler (esbuild is just one adapter inside it)

**Base image**:
The thin Sporades-owned Docker image used by local Container sessions and Hosted Capsules: `ghcr.io/sporades/sporades-base:0.1.0-node22-alpine`. It provides Node 22, the non-root `sporades` runtime user (`10001:10001`) for Hosted Capsules and fallback local execution, known read-only release paths, and the `/app/data` writable data contract. Local Container sessions run as the invoking host UID/GID when available so `.sporades/data` remains normal local user-owned state. Runtime hardening lives in the container lifecycle: read-only root filesystem, hardened `/tmp`, dropped capabilities, Docker's default seccomp profile, `no-new-privileges`, loopback-only Hosted Capsule ports behind Caddy, and Docker labels for Base image version/update policy.
_Avoid_: runtime image, host image

**Runtime directory**:
The `.sporades/` directory in a project. Contains build output (`build/server.mjs`, `build/client.js`), Dev-session SQLite data (`data.db`), uploaded file bytes, local container binding (`binding.json`), remote binding (`remote-binding.json`), and host-push artifacts as needed. Gitignored. Owned by Sporades - the user does not touch it.
_Avoid_: build directory, cache directory

**Container binding**:
A `.sporades/binding.json` file tracking the running local Container session's ID and name. Used by `sporades deploy` to find and replace the existing local container. The current local model supports one container per project - redeploy replaces, does not multiply.
_Avoid_: deploy metadata, container record

**Host server**:
An SSH-reachable machine that runs the remote Sporades hosting stack: Docker, reverse proxying, the remote registry, and Hosted Capsule containers.
_Avoid_: host, server, box

**Host server registry**:
The Host-server-owned state for Hosted Capsule registration, release pointers, route state, and lifecycle metadata. It is remote hosting state rather than Database adapter state; registry writes use Host server safety mechanisms such as locking and atomic replacement instead of DB Transaction boundaries.
_Avoid_: database registry, app table, deployment database

**Host profile**:
A local CLI configuration entry that names a Host server plus a Hosted domain, scheme, remote root, and TLS mode. Used so commands can target a configured hosting destination without repeating connection details.
_Avoid_: host, remote config, environment

**Hosted domain**:
A DNS domain where Capsule subnames resolve to a Host server, such as `mattgscox.co.uk`.
_Avoid_: host, hostname, server domain

**Hosted Capsule**:
A Capsule registered on a Hosted domain and managed by a Host server. Registration reserves the Capsule subname and server-side state before any release is pushed.
_Avoid_: deployment, app, remote app

**Agent-operable Hosted Capsule**:
A Hosted Capsule that an agent can safely deploy, observe, diagnose, and recover using structured Sporades commands without scraping logs, manually inspecting SSH state, or guessing across platform failure modes.
_Avoid_: production-ready app, observable deployment

**Capsule subname**:
The DNS-safe name reserved for a Hosted Capsule within a Hosted domain, forming URLs such as `subname.example.com`.
_Avoid_: app name, project name, hostname

**Hosted Capsule unavailable response**:
A Host-server-owned HTTP `503 Service Unavailable` response for a registered Hosted Capsule that has no running container, including no-release, stopped, and failed-start states.
_Avoid_: 404, proxy error, default error page

**Capsule route**:
A generated reverse-proxy route for one Hosted Capsule's full subdomain, pointing either to its running container or to the Hosted Capsule unavailable response.
_Avoid_: wildcard route, dynamic route, proxy rule

**Edge TLS**:
TLS handled by Cloudflare for a Hosted domain before traffic reaches the Host server.
_Avoid_: app TLS, Caddy TLS

**Automatic TLS**:
Caddy-managed certificate issuance and renewal for a Hosted domain route. This is the default Host profile TLS mode.
_Avoid_: no TLS, self-signed TLS

**Origin certificate**:
The Cloudflare-issued server certificate presented by the Host server to Cloudflare for a Hosted domain when the Host profile uses `cloudflare-origin` TLS mode.
_Avoid_: LetsEncrypt certificate, public certificate

**Hosted domain TLS directory**:
The domain-scoped Host server directory that contains optional preinstalled Cloudflare origin certificate material for a Hosted domain.
_Avoid_: cert folder, SSL directory

## Server runtime

**sporades/server**:
A runtime context, not just a set of exports. Internally manages the SQLite connection, runtime-owned auth storage, env vars, row-level cache, endpoint routing, file metadata, and app-message fan-out. When imported, it initialises the runtime. `capsule()` registers the app definition (schema, queries, mutations, endpoints, messages) against this runtime. The user never touches the runtime directly.
_Avoid_: server module, server library (it's a living context, not a static library)

**capsule()**:
The initialisation function. Called with the app definition. Registers the schema with SQLite, applies supported schema migrations, configures runtime-owned auth, wires the table API, and registers custom endpoints and message handlers. This is where app bootstrap happens - not an identity function.
_Avoid_: app definition (that's the argument, not the function), config function

**Custom endpoint**:
A Capsule-defined HTTP handler declared with `endpoint({ method, path }, handler)`. Used for integration paths such as webhooks that cannot use the WebSocket client transport. Endpoints receive normal Sporades context plus `ctx.request`.
_Avoid_: REST API (too broad), route handler (confuses it with client routing)

**Message handler**:
A Capsule-defined app-message handler declared with `message((ctx, data) => ...)`. Client-origin App messages enter server code through these handlers before any response or fan-out.
_Avoid_: socket listener, raw WebSocket handler

**Lifecycle hooks**:
`init()` and `shutdown()` boundaries on the server runtime. Dev rebuilds currently use a full runtime restart around these boundaries; finer-grained hot reload remains future work.
_Avoid_: start/stop (too generic), lifecycle methods (they're hooks, not methods)

## Field types

Sporades field builders use capitalised names to avoid collisions with TypeScript's `string` and `boolean` primitive type keywords.

**String()**:
A text field. Maps to SQLite `TEXT`. JavaScript `string` ↔ SQLite `TEXT`.
_Avoid_: string() (lowercase — collides with TS keyword)

**Boolean()**:
A boolean field. Maps to SQLite `INTEGER`. JavaScript `true`/`false` ↔ SQLite `1`/`0`. Sporades owns the serialisation/deserialisation — the user never sees `0` or `1`.
_Avoid_: boolean() (lowercase — collides with TS keyword)

**Date()**:
A date/timestamp field. Maps to SQLite `TEXT`. JavaScript/API values are ISO 8601 strings, with JavaScript `Date` values accepted by runtime table APIs and normalised to ISO strings before storage.
_Avoid_: date() (lowercase — collides with the field-builder convention)

**Number()**:
A numeric field. Maps to SQLite numeric storage and JavaScript `number` values.
_Avoid_: number() (lowercase - collides with the field-builder convention)

**Json()**:
A JSON-compatible field for structured values. Sporades owns serialisation and deserialisation between JavaScript values and SQLite storage.
_Avoid_: blob, object field

**Reference()**:
A field that stores a reference to a row in another Capsule table. Reference targets must name an existing table.
_Avoid_: foreign key (too SQL-specific for the authoring API)

## Auto fields

Every table has three managed fields added automatically by Sporades. App code cannot set or update them.

**id**: UUID string (`crypto.randomUUID()`). SQLite `TEXT`.
**createdAt**: ISO 8601 timestamp string. SQLite `TEXT`.
**updatedAt**: ISO 8601 timestamp string. SQLite `TEXT`. Auto-updated on every `update` operation.
_Avoid_: primary key, timestamp fields (these are Sporades-managed, not user-defined)

## Auth

Sporades owns auth entirely on the server side. The client never sees provider SDKs or runtime auth internals.

**Anonymous session**:
A real session created automatically for every visitor. Not a fake guest ID - a persistent account with a session token. Data created anonymously is preserved when the user links an authentication method such as email or Google OAuth.
_Avoid_: guest mode (implies fake/transient — these are real sessions), guest user

**Session token**:
A string stored in `localStorage` on the client and sent on the WebSocket connection. Custom endpoints may also receive it through the `x-sporades-session-token` HTTP header. No auth SDK is bundled into the client.
Session records include lifecycle metadata and expire after 30 days by default. Missing, invalid, or expired tokens resolve to a fresh Anonymous session. Email sign-up and sign-in rotate the current token; Google sign-in refreshes the current token during the OAuth callback.
_Avoid_: auth token, JWT

Missing or invalid endpoint tokens resolve to a fresh Anonymous session rather than crashing or rejecting the request.

**Linked account**:
A real authentication method, such as email or Google OAuth, linked to an existing Anonymous session. The user's data follows them because the auth method is linked to the existing account, not a new one.
_Avoid_: upgrade, migration (those are schema concerns, not auth)

**Auth transaction**:
The Transaction boundary for one user-visible auth action that touches multiple runtime-owned auth records. Sign-up, sign-in, provider linking, OAuth callback handling, and session rotation should leave auth storage in a known outcome; for example, a failed sign-up must not leave a created user behind, failed session rotation keeps the old Session token valid, and a failed OAuth callback spends its OAuth state so the user restarts the local OAuth flow.
_Avoid_: partial sign-up, orphaned auth row, best-effort auth update

**Current-user preferences**:
A runtime-owned JSON object keyed by the current Sporades user identity. Client code reads it with `preferences.get()` and shallow-merges partial JSON objects with `preferences.update(...)` from `sporades/client`. It is for durable per-user UI and behavior settings and does not appear in Capsule app schema or `ctx.db`.
_Avoid_: preferences table, app settings table, localStorage settings

**Preference transaction**:
The Transaction boundary for one current-user preference update. The runtime reads the existing preferences, applies and validates the accepted patch, saves the next value, and only reports or broadcasts committed preference state.
_Avoid_: optimistic preference broadcast, partial preference update, localStorage preference write

## Client transport

Sporades is client-framework-agnostic. `sporades/client` exports a transport layer (WebSocket connect, query subscribe, mutation send, auth state, current-user preferences) and a `createHooks` factory that takes a framework's primitives (`useState`, `useEffect`) and returns ready-to-use hooks (`useQuery`, `useMutation`, `useAuth`). The user wires one line; the scaffold template handles it by default.

**createHooks**:
A factory function exported by `sporades/client`. Accepts `{ useState, useEffect }` from any JSX framework (React, Preact, Solid) and returns Sporades hooks bound to that framework's reactivity model.
_Avoid_: useQuery (that's what it produces, not what it is), hooks provider

**App message**:
An application-defined message sent over the Sporades client transport. App and server code provide an unprefixed type name; Sporades owns adding and reserving the internal `app.` prefix. Client-origin app messages are always mediated by server code. App messages default to the current user's connected clients; app-wide broadcast is a server-code-only capability. App code uses SDK send/subscribe APIs such as `onMessage().filter(...)`, not raw WebSocket objects.
_Avoid_: raw WebSocket message, custom socket packet, transport frame

**Upload call**:
A high-level `sporades/client` operation that accepts a browser file/blob and returns Sporades-owned file metadata. It hides upload URL negotiation and byte transfer details from app code. Uploads are addressed by absolute File path; when no File path is provided, Sporades uses the uploaded file name in the Default File bucket. Passing an array is a convenience that runs single-file uploads sequentially.
_Avoid_: upload URL API, presigned URL flow, storage client

**Upload event**:
An app-facing SDK callback or event for upload progress, completion, or failure. The server may deliver underlying messages over WebSocket, but app code does not subscribe to raw upload WebSocket plumbing.
_Avoid_: upload WebSocket message, raw upload notification, transport event

**File metadata**:
The app-scoped record returned by an Upload call, including the file's absolute File path, stable File ID, and descriptive properties such as size, MIME type, original name, and version. App code stores references to this metadata in its own tables through normal mutations.
_Avoid_: file field, attachment row, upload result

**File metadata transaction**:
The Transaction boundary for file metadata changes during Upload calls, replacement, deletion, and public file URL changes. Uploaded file bytes live in Capsule storage, so byte side effects that cannot share the database transaction must use explicit compensating cleanup when metadata changes fail.
_Avoid_: file-byte transaction, storage transaction, best-effort upload metadata

**File version**:
The cache-busting identity of a file's current bytes. Replacing a file preserves the file ID but creates a new version so previously generated URLs cannot keep serving stale content.
_Avoid_: revision, cache token, object generation

**File ID**:
The stable identifier of a file metadata record. File content can change without changing the File ID; content changes create a new File version.
_Avoid_: content ID, object ID, storage key

**File reference**:
Any app/API value that resolves to one live file metadata record, such as a File ID or absolute File path. File operations may accept File references when they only need to identify an existing file.
_Avoid_: storage locator, URL, object key

**File bucket**:
A backend-agnostic storage namespace for uploaded files inside one Capsule. File buckets are conceptual prefixes on absolute File paths and are also the unit that object-storage backends such as MinIO or S3 may map onto concrete storage namespaces. Two Capsules using the same File bucket name do not share files.
_Avoid_: folder, directory, container

**Default File bucket**:
The fallback File bucket name used when a File path does not resolve to an existing or explicitly created File bucket. It is only a storage namespace name, not a special ownership, visibility, or policy boundary.
_Avoid_: user bucket, system bucket, default folder

**File path**:
A unique, absolute, Capsule-scoped logical path for file metadata, with arbitrary depth such as `/users/images/avatars/file-1`. It behaves like a file-system path at the Sporades API and ACL boundary, but it is not a filesystem path or object-storage key; the storage backend decides how File paths map to stored bytes. Writes may opt into creating any missing namespace pieces needed for the path; otherwise unresolved bucket prefixes fall back to the Default File bucket.
_Avoid_: filesystem path, storage path, object key, file location

**Capsule storage**:
The isolated storage boundary for one Capsule's uploaded file bytes and file metadata. Two Capsules do not share files even when they use the same File bucket names; the storage backend decides how that isolation is implemented.
_Avoid_: shared storage, global bucket, app storage

**Object bucket**:
The concrete object-storage bucket/container used by MinIO, S3-compatible storage, or AWS S3 to hold uploaded file bytes. It is backend infrastructure, not the app-facing File bucket shown in File metadata.
_Avoid_: File bucket, folder, directory

**Public file URL**:
A server-managed read URL record for a private uploaded file. It is explicit, has either a TTL or an explicit no-expiry setting, can be revoked before expiry, and does not change the file's private ownership.
_Avoid_: public upload, permanent link, static file path

## Routing

Sporades does not provide a router. The scaffold template includes a framework-appropriate router (e.g. React Router for React apps) as a template choice. Routing is not a Sporades concern.

## Data

**System table**:
A `sporades` table auto-created in every app's SQLite database. Stores schema version, migration state, and app metadata. Sporades owns it; app code cannot write to it.
_Avoid_: migration table, metadata table

**Schema migration**:
The runtime-owned startup path that compares stored schema metadata with the next Capsule schema. Adding tables and fields is supported as an additive migration; schema changes that rewrite or backfill user data require a Transaction boundary, while removing tables, removing fields, or changing existing field definitions is rejected with a structured error and hint.
_Avoid_: migration version, database version

**Row cache**:
A `Map<rowId, row>` in-memory cache. Rows are cached on read (lazy, per-row) and invalidated on write. SQLite is the source of truth for the running Capsule process.
_Avoid_: table cache (it's row-level, not table-level), data cache

**Database adapter**:
A runtime-owned boundary that maps the Sporades table API, schema migration model, auth storage, file metadata storage, log index, system metadata, and inspection queries onto one database engine's connection behavior and SQL dialect. Code above the Database adapter must remain agnostic to the selected engine.
_Avoid_: driver (too low-level), ORM, database plugin

**Sporades DB API**:
The engine-agnostic database operation model used by Sporades runtime code. Capsule handlers interact with a runtime instance of this API through `ctx.db`; design discussions may refer to the underlying API as `sporades.db`.
_Avoid_: raw SQL API, database client, ORM

**Transaction boundary**:
The explicit runtime-owned atomicity boundary for related database writes in a Sporades workflow. Multi-write workflows use the Database adapter transaction primitive; single-statement writes may be intentionally outside an explicit boundary when their database-layer atomicity is sufficient.
_Avoid_: wrapping every write, implicit transaction, best-effort write grouping

**Mutation transaction**:
The Transaction boundary owned by mutation execution for one Capsule mutation call. App-table writes from the mutation handler, generated mutation path, mutation hooks, ACL checks, and pending ACL writes share this boundary so the mutation commits or rolls back as one retryable unit.
_Avoid_: nested app transaction, hook transaction, partial mutation commit

**ACL rule**:
An authorization policy declared in Capsule definition code and applied invisibly around the Sporades DB API to accept or reject app-table and file-storage operations. Capsule code continues to use normal `ctx.db` and file APIs rather than calling permission checks directly. ACLs answer whether the current actor may see or change a row or file metadata record; file-specific validation and client-facing upload choices are not ACL concerns. ACLs are allow-by-default when no matching rule is specified; a `write` ACL rule may apply to insert, update, and delete operations unless an operation-specific rule overrides it. Write ACL rules evaluate against previous and next row state where relevant.
_Avoid_: permission helper, manual auth check, database filter

**ACL context**:
A constrained read-only policy context exposed to ACL rules as `ctx.acl`. It provides scoped helpers such as `ctx.acl.db.get()`, `ctx.acl.db.exists()`, `ctx.acl.storage.get()`, and `ctx.acl.storage.exists()` so database and storage ACL rules can check each other's stable resources without exposing normal runtime APIs or allowing writes.
_Avoid_: ctx.db in ACL, admin client, bypass API

**Root server role**:
A privileged server-side role that can perform API actions without normal user authentication and may inspect runtime-owned non-app resources that normal app ACL helpers cannot see. It is a server/runtime capability, not a browser credential.
_Avoid_: admin user, superuser account, service account

## Configuration

**sporades.json**:
The project configuration file at the project root. Read by the CLI at startup; relevant pieces passed to the server runtime as a startup argument. The server runtime does not read files. Contains: app name, client framework, enabled auth providers (or legacy auth mode), security policy, deploy port, optional dev port override.
_Avoid_: config file (too generic — it's the specific project config)

**Security policy**:
The `sporades.json` configuration that defines Capsule HTTP security posture, including CORS and Content Security Policy defaults and overrides. It is runtime policy, not app business logic.
_Avoid_: security middleware, helmet config

**Config cascade**:
`sporades.json` → CLI flag → default. CLI flags override config values; config values override defaults. Applied to: ports, framework, auth providers, and legacy auth mode.

**Server env**:
A legacy/import-friendly `.env.sporades.server` file at the project root containing server-only environment variables. Sporades still reads it when no Sealed Server env exists and `sporades env import` can migrate it into encrypted Runtime state. Max 64 keys, 64KB total. No `SPORADES_` prefix (reserved).
_Avoid_: environment file, dot-env (implementation detail)

**Sealed Server env**:
Encrypted server-only configuration values managed by Sporades, decryptable by configured local or Host keys, delivered to Dev sessions, Container sessions, and Hosted Capsules at runtime, and exposed to Capsule code through `ctx.env`. It is the hardened successor to plaintext Server env files.
_Avoid_: secrets API, vault, encrypted dot-env

## CLI output

**JSON output**:
All CLI commands support `--json`. Output is `{ ok, data, error }` where `error` includes a `hint` field with an actionable suggestion. Errors exit with code 1.
_Avoid_: structured output (too generic)

**JSONL streaming**:
`sporades dev --json` streams JSON Lines to stdout — one JSON object per event (started, rebuild success, rebuild failed). Enables agents to watch for build errors and react in real time.
_Avoid_: streaming output, log lines

**JSONL log stream**:
An append-friendly sequence of JSON log events emitted by the runtime for app and platform behavior. It is distinct from `sporades dev --json`, which streams command lifecycle events.
_Avoid_: text logs, dev JSONL events

**Log index**:
A bounded SQLite-backed index of recent JSON log events used for structured inspection queries. The JSONL log stream remains the durable append stream, so Log index write failures should degrade inspection rather than roll back app, auth, or file workflows.
_Avoid_: log database, audit log

## Scaffold

**Scaffold**:
The output of `sporades create`. A project directory with server entry, client entry, shared types, index.html, config, and agent instructions. Includes a todo app template that demonstrates the full stack.
_Avoid_: boilerplate, starter (it's a complete project, not a placeholder)

**Scaffold install**:
`sporades create` runs `npm install` for the chosen framework after scaffolding. The user (or agent) does not run `npm install` separately. The project's `package.json` includes the framework dependency and the Sporades CLI as dev dependencies.
_Avoid_: dependency install, setup step
