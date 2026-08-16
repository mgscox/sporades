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

**Email provider route**:
A runtime-owned HTTP callback route enabled under `mail.webhooks` for one outbound email provider. It verifies and normalizes provider payloads before the Capsule can observe them, and remains distinct from a Capsule-defined Custom endpoint.
_Avoid_: app webhook, Mailjet handler, email endpoint

**Verified email event**:
A provider-neutral email lifecycle value produced only after an Email provider route verifies a callback and validates one provider event. It includes normalized lifecycle fields plus the exact raw per-event provider JSON; Sporades does not persist either representation by default.
_Avoid_: Mailjet event, delivery row, SMTP response

**Email-event subscription**:
The optional single Capsule handler declared with `emailEvents: emailEvent(handler)`. The consolidated runtime dispatcher invokes it under the Privileged server role for each Verified email event, independent of the provider-specific callback shape.
_Avoid_: provider handler, EventEmitter listener, webhook endpoint

**Message handler**:
A Capsule-defined app-message handler declared with `message((ctx, data) => ...)`. Client-origin App messages enter server code through these handlers before any response or fan-out.
_Avoid_: socket listener, raw WebSocket handler

**Job**:
A durable unit of background work owned by a Capsule or by Sporades platform code. Jobs run under an explicit server-side actor, such as a captured Sporades user identity or the Privileged server role, and Capsule server code may inspect known Job state through runtime-owned APIs rather than modelling Jobs as app tables.
_Avoid_: task, worker request, background mutation

**Job queue**:
The runtime-owned background-work surface that stores, runs, retries, and exposes Jobs for a Capsule. It is app-facing where Capsule server code needs to enqueue or inspect Jobs, and platform-facing where Sporades uses the same concept for internal work.
_Avoid_: worker pool, message bus, queue table

**Job state**:
The runtime-owned status view for one known Job, including lifecycle status, attempt counts, timestamps, and safe failure or result metadata. It is the inspection surface app code sees instead of raw queue internals.
_Avoid_: queue internals, worker details, job row

Job state progresses through `delayed`, `queued`, `running`, `succeeded`, `failed`, or `cancelled`; only `queued` means ready to run.

**Job provenance**:
The runtime-owned identity of the user or Schedule that requested a Job. Provenance explains why the Job exists but grants neither visibility nor execution authority.
_Avoid_: Job owner, Job actor, enqueuing Session

**Job requeue**:
A deliberate non-terminal Job-handler outcome that keeps the same Job identity and makes another attempt eligible later for an application-determined reason. It is distinct from a failure retry and from enqueueing a new Job.
_Avoid_: retry, replacement Job, recursive enqueue

**Schedule**:
A named Capsule declaration that determines when Sporades should enqueue an ordinary Privileged Job. It owns recurrence and occurrence creation, not Job execution or queue management.
_Avoid_: cron job, recurring Job, timer

**Scheduled occurrence**:
One UTC instant produced by a Schedule. Its claim-owned durable transition atomically associates a deterministic Job identity, terminal occurrence outcome, and latest Schedule summary when enqueue succeeds; payload calculation itself may be repeated during recovery.
_Avoid_: run, tick, retry

**Job inspection action**:
A runtime-owned operator action that returns bounded safe state for all Jobs in one Capsule to an administrator of its Dev session, Container session, or Host server. It is an internal CLI/runtime operation rather than a Capsule API route or actor-scoped app API.
_Avoid_: Job API route, user Job query, queue-table access

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
A real session created automatically for every visitor. Not a fake guest ID - a persistent account with a session token. Data created anonymously is preserved when the user links an authentication method such as email, Google, Microsoft, Apple, or Facebook.
_Avoid_: guest mode (implies fake/transient — these are real sessions), guest user

**Session token**:
A string stored in `localStorage` on the client and sent on the WebSocket connection. Custom endpoints may also receive it through the `x-sporades-session-token` HTTP header. No auth SDK is bundled into the client.
Session records include lifecycle metadata and expire after 30 days by default. Missing, invalid, or expired tokens resolve to a fresh Anonymous session. Email sign-up and sign-in rotate the current token; provider sign-in refreshes the current token during the OAuth callback.
_Avoid_: auth token, JWT

Missing or invalid endpoint tokens resolve to a fresh Anonymous session rather than crashing or rejecting the request.

**Linked account**:
A real authentication method, such as email or a supported OAuth provider, linked to an existing Anonymous session. The user's data follows them because the auth method is linked to the existing account, not a new one.
_Avoid_: upgrade, migration (those are schema concerns, not auth)

**Provider identity**:
A runtime-owned association between one Sporades user and one external authentication provider's stable subject. The `(provider, subject)` pair is the identity key; email, display name, and picture are mutable, nullable profile attributes. One Sporades user may own multiple Provider identities.
_Avoid_: provider email, social user, OAuth profile

**Provider subject**:
The stable, provider-issued identifier for one external identity, such as Google's verified `sub` claim. It is meaningful only together with its provider and does not change when profile email or display details change.
_Avoid_: email key, username, profile ID

**OAuth attempt**:
A short-lived, single-use runtime record binding one provider authorization request to its Session, exact callback URI, same-origin return URL, nonce, and PKCE verifier. The callback spends the attempt before any provider or account work, including cancellation and failure.
_Avoid_: reusable state, client OAuth session

**Reset code**:
A short-lived, single-use runtime record binding one email credential to one password reset attempt. The code is a selector/verifier pair; the runtime stores the selector and only a hash of the verifier. Verification is repeatable and does not spend the code; confirming a new password spends it, deletes the user's other outstanding Reset codes, and revokes that user's Sessions.
_Avoid_: reset token, oobCode, magic link (it authorizes a password change, not a sign-in)

**Session provenance**:
The authentication provider recorded on one Session. It reports how that Session authenticated independently of other Sessions or Provider identities linked to the same Sporades user.
_Avoid_: user provider, account type, current linked provider

**Auth transaction**:
The Transaction boundary for one user-visible auth action that touches multiple runtime-owned auth records. Sign-up, sign-in, provider linking, OAuth callback handling, and session rotation should leave auth storage in a known outcome; for example, a failed sign-up must not leave a created user behind, failed session rotation keeps the old Session token valid, and a failed OAuth callback spends its OAuth state so the user restarts the local OAuth flow.
_Avoid_: partial sign-up, orphaned auth row, best-effort auth update

**Current-user preferences**:
A runtime-owned JSON object keyed by the current Sporades user identity. Client code reads it with `preferences.get()` and shallow-merges partial JSON objects with `preferences.update(...)` from `sporades/client`. It is for durable per-user UI and behavior settings and does not appear in Capsule app schema or `ctx.db`.
_Avoid_: preferences table, app settings table, localStorage settings

**Preference transaction**:
The Transaction boundary for one current-user preference update. The runtime reads the existing preferences, applies and validates the accepted patch, saves the next value, and only reports or broadcasts committed preference state.
_Avoid_: optimistic preference broadcast, partial preference update, localStorage preference write

**Capsule role**:
A non-Team Capsule-scoped authorization label is reserved for a distinct demonstrated use case and separate PRD. It must not compete with membership-scoped Team application roles, which belong to the built-in Teams work in Tickets 09–10. It is not the Privileged server role and does not grant platform/runtime authority outside the Capsule.
_Avoid_: global admin, platform admin, root role, Privileged server role, duplicate Team application role

**Team application role**:
A Capsule-declared, membership-scoped domain label. Each identifier must match
`^[a-z][a-z0-9-]{0,31}$` (maximum 32 characters); `admin`, `member`, and the
`sporades-*` prefix are runtime-reserved. It is neither a Team management role
nor Privileged server authority.
_Avoid_: global user role, Team admin, Privileged server role

## Client transport

Sporades is client-framework-agnostic at its internal transport seam, which owns the WebSocket connection, query subscriptions, mutation sending, auth state, and current-user preferences. The public `sporades/client` surface currently exposes that query and mutation behavior through `createHooks`, a React/Preact adapter that takes compatible primitives (`useState`, `useEffect`) and returns ready-to-use hooks (`useQuery`, `useMutation`, `useAuth`). Direct framework-neutral query subscriptions are not yet public. Frameworks with different reactivity models require native adapters over the internal transport seam rather than emulating React hooks.

**createHooks**:
A React/Preact adapter factory exported by `sporades/client`. Accepts React/Preact-compatible `{ useState, useEffect }` primitives and returns Sporades hooks bound to that lifecycle model. It is not the framework-neutral transport interface and does not model SolidJS signals, Vue composables, Svelte stores, or other native reactivity systems.
_Avoid_: useQuery (that's what it produces, not what it is), hooks provider

**App message**:
An application-defined message sent over the Sporades client transport. App and server code provide an unprefixed type name; Sporades owns adding and reserving the internal `app.` prefix. Client-origin app messages are always mediated by server code. App messages default to the current user's connected clients; app-wide broadcast is a server-code-only capability. App code uses SDK send/subscribe APIs such as `onMessage().filter(...)`, not raw WebSocket objects.
_Avoid_: raw WebSocket message, custom socket packet, transport frame

**User journey tracker**:
An opt-in Capsule-wide view of what enabled Sporades users, including Anonymous users, are doing across their live client connections. It converts safe navigation and focus signals, explicitly annotated semantic interactions, and manual updates into short-lived Journey state; all connected Capsule clients receive live updates until future Team-based delivery filtering exists.
_Avoid_: presence tracker, user analytics, activity log

**Journey consent**:
The page-runtime decision established by `journey.enable()` that permits manual and automatic Journey publication under a narrowed capture policy. Consent survives an ordinary transport reconnect in the same page runtime, but disablement, auth transition, page reload, or client-runtime replacement clears it. Consent is not a Journey session and creates no session ID by itself.
_Avoid_: Journey session, resume credential, durable consent record

**Journey session**:
One server-owned segment of accepted Journey publication activity, identified by a Journey session ID and attached to its Sporades user ID. It is created lazily on first publication; every new transport connection or configured inactivity gap produces a new session. A user may have multiple simultaneous Journey sessions.
_Avoid_: auth session, browser identity, page consent, durable activity record

**Journey state**:
The latest bounded status and metadata published by one Journey session, buffered until its server-calculated expiry. Expiry removes the state; a later accepted publication reuses the session ID only when it remains on the same connection and inside the configured inactivity interval.
_Avoid_: journey event, durable presence, session record

**Journey signal**:
A privacy-bounded client event that replaces the current Journey state, produced from navigation, focus/visibility changes, an explicitly annotated semantic interaction, or a manual update. Navigation exposes only a normalized pathname or explicit semantic page name; signals never contain URL origin/query/raw hash, form values, raw DOM text, CSS selectors, pointer coordinates, or raw browser payloads.
_Avoid_: clickstream event, DOM event dump, analytics event

**Inactive journey state**:
The derived state of a Sporades user with no unexpired Journey state across their Journey sessions in a Capsule. It is absence of live activity, not a stored Journey state or status event.
_Avoid_: inactive presence record, offline event, persisted inactivity

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
A runtime-owned boundary that maps the Sporades table API, schema migration model, auth storage, file metadata storage, log index, system metadata, and inspection queries onto one database engine's connection behavior and SQL dialect. Code above the Database adapter must remain agnostic to the selected engine. Its method set is engine-agnostic and defined once; a Database engine supplies statement primitives, a Database dialect, and row and value normalization, and no behavioural method body of its own.
_Avoid_: driver (too low-level), ORM, database plugin

**Database dialect**:
The closed set of places where database engines genuinely cannot agree on the text of a statement — identifier quoting, column type mapping, the upsert form, the catalog queries behind listing tables and describing columns, and the strategy for declaring a column an older database may not have. A Database engine answers every entry or fails when its adapter is constructed. A difference that is not one of these entries is not a dialect difference and does not license a per-engine method body.
_Avoid_: SQL flavor, engine quirks, database-specific overrides

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
A constrained read-only policy context exposed to ACL rules as `ctx.acl`. It provides scoped helpers such as `ctx.acl.db.get()`, `ctx.acl.db.exists()`, `ctx.acl.storage.get()`, `ctx.acl.storage.exists()`, and explicit-Team `ctx.acl.teams` membership, admin, and declared application-role decisions so database and storage ACL rules can check stable resources without exposing normal runtime APIs or allowing writes. Team helpers never choose a current Team, enumerate memberships, or manage membership state.
_Avoid_: ctx.db in ACL, admin client, bypass API

**Privileged server role**:
A server-only authority for trusted system-owned execution that intentionally runs without a Sporades user identity, such as scheduled Jobs or platform-owned maintenance. It is separate from Capsule roles, app admin users, browser credentials, users, team members, sessions, and accounts.
Inside an active audited callback it may inspect one explicit existing Team's accepted-member count, safe member projection, and active Join-link metadata (never the target email), or safely inspect a Join link. It cannot list a current user's Teams, validate an email-bound Join link, or mutate Team state; no Team inspection grants or invents user identity or membership authority. In-flight inspection fails closed if the callback ends or its AbortSignal aborts before a result returns. Unknown or deleted explicit Teams fail as `TEAM_NOT_FOUND`; safe Join-link inspection preserves its invalid-capability result.
_Avoid_: root server role, admin user, superuser account, service account, Capsule role

**Privileged audit event**:
A platform-owned structured JSONL log event for privileged-boundary and comparable security-sensitive runtime activity, including current SSH configuration, lifecycle, and inspection events. It records actor kind, operation, Capsule identity, call site or API surface, correlation identity, target resource kind, outcome, safe error code, and bounded redacted metadata. Capsule app `ctx.log` cannot emit Privileged audit events, and browser/client credentials do not carry privileged authority.
_Avoid_: audit log, security log, admin log

## Configuration

**sporades.json**:
The project configuration file at the project root. Read by the CLI at startup; relevant pieces passed to the server runtime as a startup argument. The server runtime does not read files. Contains: app name, client framework, enabled auth providers (or legacy auth mode), security and scheduling policy, deploy port, optional dev port override.
_Avoid_: config file (too generic — it's the specific project config)

**Scheduling policy**:
The `sporades.json` configuration for Capsule-wide Job Scheduling runtime limits, such as payload-factory timeout. It controls scheduler operation rather than defining individual Schedules.
_Avoid_: Schedule definition, cron config, Job retry policy

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
