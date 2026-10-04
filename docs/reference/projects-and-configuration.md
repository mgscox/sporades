# Projects and Configuration Reference

Capsule creation, project layout, configuration, security policy, database services, and Dev sessions.

[Back to the feature reference index](../guide/reference.md).

## Runtime telemetry

[Sender credential lifecycle](./sender-credentials.md) documents operator-local
issue, protected export, staged rotation/commit, revocation and legacy migration.
These credentials belong to the Monitoring connection, outside Capsule Sealed
Server env; profiles retain only environment references.

The operator registers a named Telemetry profile separately from a Host profile:

```sh
sporades telemetry profile add local --endpoint http://127.0.0.1:4318 --loopback --credential-env TRACE_INGEST_TOKEN
sporades telemetry profile list --json
sporades dev --telemetry local
sporades deploy --telemetry local
```

For a remote collector, use an HTTPS OTLP/HTTP origin and omit `--loopback`.
`--ca-file /absolute/path/to/ca.pem` trusts a private CA while retaining TLS
verification. Container deploy checks that the selected CA is a readable,
regular PEM certificate file of at most 1 MiB before replacing a running
Container. It mounts a deployment-owned, read-only copy that the Container's
runtime user can read; the operator file and its permissions stay unchanged.
Keep the operator CA available for later redeploys. The optional `--dashboard`
is a credential-free HTTPS URL.
If deployment is interrupted, `sporades deploy reconcile` retires an unbound
staged CA after settling the Container attempt; a bound CA remains until that
Container is replaced or removed.
`--event-loop-delay-resolution-ms` tunes Node event-loop delay sampling from
10 to 1000 ms (default 20 ms); shorter intervals use more timer work. The
exported delay max, mean, and p99 are nonnegative milliseconds of event-loop
lag beyond that sampling interval, not the interval itself. Max uses the larger
of Node's measured peak and a conservative lower bound for time missed at a
histogram reset. That bound can understate a stall; mean and p99 use only Node's
recorded samples. A positive max bound may export even when Node records no
sample in a window. Mean and p99 receive no new observation then, although the
metric exporter may repeat their previous gauge values.
`--metrics-interval-ms` tunes metric export from 5000 to 300000 ms; the default
is 15000 ms. The monitoring dashboards default to a 12-minute Metric window
so even a 300-second profile has at least two samples for rates and p95. Select
2 minutes only for profiles exporting every 30 seconds or faster. GC counts and pause duration, event-loop delay and utilization use
the same process instance identity as CPU and memory. A finite stall appears
after recovery; a permanently blocked process may stop exporting. The monitoring stack's [operator README](https://github.com/mgscox/sporades/blob/main/monitoring/trace/README.md)
documents its separate scrape interval, retention, disk cap, and Grafana URL.
Profiles live in `$SPORADES_CONFIG_DIR/telemetry.json` (or the Sporades XDG
configuration directory), with restrictive file permissions. Their descriptors
contain an ingestion credential **environment variable name**, never its value.
Set that variable in the CLI process before starting Dev or Container. The token is sent as
`Authorization: Bearer` to `<endpoint>/v1/traces` and `<endpoint>/v1/metrics`;
it is not written to the
profile or generated Bundle.
The selected profile alone sets the OTLP destination, authorization and TLS
trust. Sporades sends uncompressed OTLP/HTTP with cumulative metrics for its
monitoring stack; ambient `OTEL_EXPORTER_OTLP_*` settings from other tooling do
not alter these exports. For a private CA, select the profile's `--ca-file`.

Telemetry exports are best effort and bounded independently of business work.
The SDK exports `otel.sdk.processor.span.queue.size` and `.capacity` (128
waiting spans) and `.processed` with bounded `error.type` values `queue_full`
and `Error` for saturation and failed export loss. `sporades.telemetry.export.failure.count`
counts failed attempts by `signal=traces|metrics`; `.in_flight` measures active
exports, and `.last_success` records Unix seconds of the last downstream
acceptance, with no sample until the first success. `sporades.telemetry.collection.time`
records source collection time in Unix seconds for detecting stale buffered
samples. These metrics share the existing resource identity and export path;
diagnostic samples can themselves be lost. Missing data is unknown, and export
acceptance does not prove storage delivery. The provisioned **Sporades Telemetry
Pipeline** dashboard and [outage runbook](https://github.com/mgscox/sporades/blob/main/monitoring/trace/OUTAGES.md)
describe finite retry/flush budgets, loss and optional quota-limited persistent
Collector queues. The source-stale warning uses the newest collection time in a
bounded 24-hour history per logical target, so a disconnected target can warn
after 15 minutes even after its instant series disappears. It drops only the
process-lifetime `instance` and `service_instance_id` labels: fresh collection
from a replacement clears the retired process warning, including after repeated
restarts or older batch replay. All remaining labels, including service,
environment and any stable replica labels, remain independent. Hosted service
names use `domain/subname`; processes sharing all remaining labels are one
target, so independently monitored replicas need distinct stable target labels
or service names. Never-observed targets and targets outside that history
remain unknown.
No Capsule instrumentation API or additional profile setting
is required. SIGTERM flush stays within 1500 ms and repeated shutdown joins the
same bounded operation.

Dev selection order is `sporades dev --telemetry <name>`, then the explicit project
binding below, then no export. A Container session uses `sporades deploy
--telemetry <name>`, its previously selected Container profile on redeploy, or
the project binding. `sporades deploy --no-telemetry` explicitly disables export
and persists that choice across redeploy and restart. To re-enable, deploy with
`--telemetry <name>`. A fresh Container with no selection does not export:

```json
{ "telemetry": { "profile": "local" } }
```

Dev resolves the selected profile in the CLI process. A local Container stores
the resolved nonsecret descriptor (or explicit disabled value) in Docker's saved
launch environment for its runtime to read at startup. CLI-generated server
Bundles contain no telemetry selection. The selected profile's credential
environment reference is read at startup. Container deploy forwards only the
named variable from the CLI process into Docker; its value is absent from
command arguments, the Bundle, browser assets and Capsule
Sealed Server env. Docker administrators can inspect Container environment, so
scope this credential to ingestion and use the operator's protected environment.
A loopback collector URL is routed through `host.docker.internal` with Docker's
`host-gateway` mapping; the collector must listen on an address reachable from
the Container, not solely on Host loopback. A verified HTTPS profile uses its
configured remote address and mounts an optional validated private CA copy read-only. Container
hardening and the self-contained server Bundle stay in effect. A missing
selected profile or credential fails before the session starts. With no
selection there is no exporter or retry loop. A collector outage leaves request
handling available; completed spans use a bounded batch queue, independent
metrics use a bounded reader/exporter, and shutdown has a fixed deadline. One
SERVER span and one metric completion cover each request, including streams and
premature closes. Counters, duration histograms, and in-flight counts ignore
trace sampling. Metric dimensions are bounded method, declared route (at most
128 distinct routes per runtime), status class, outcome, service, and environment.
The trace queue holds at most 128 completed spans and exports in batches of 32;
up to five trace requests may be in flight during shutdown so a scheduled batch
and four queued batches can drain within the deadline. The independent metric
exporter permits one request at a time, and its final collection waits for an
in-progress periodic export. A completed ordinary 4xx SERVER span keeps its
response status and `failure` outcome with unset span status. Completed 5xx,
handler errors, and aborts mark the span as an error.

Sampled HTTP requests also include runtime-owned authentication and File child
spans. No additional project setting or application import is required:

| Child operation | Timed boundary |
| --- | --- |
| `sporades.auth.session.resolve` | Resolve or establish the existing Session |
| `sporades.auth.access_key.resolve` | Validate the existing Access-key credential |
| `sporades.auth.admit` | Declarative or inline runtime auth check, or private File scope check |
| `sporades.file.authorize` | Resolve a private File and evaluate owner/ACL access |
| `sporades.file.upload.prepare` / `sporades.file.upload` | Prepare or complete the existing upload |
| `sporades.file.private_url` | Resolve the current actor's private File URL |
| `sporades.file.public_url.create` / `sporades.file.public_url.revoke` | Create or revoke a public File URL |
| `sporades.file.delete` | Current-actor File metadata deletion |
| `sporades.file.read` | Read File bytes through the selected storage adapter |
| `sporades.file.bytes.write` / `sporades.file.bytes.delete` | Write or remove version bytes, including compensation |
| `sporades.file.stream` | Open an exact-version attachment storage stream |
| `sporades.file.ingress.stage` | Stage and inspect admitted endpoint multipart ingress |

Each request creates at most **32 authentication and File child spans**, all
parented to its SERVER span. This budget is separate from database spans.
Further operations still execute normally. These children follow local trace sampling;
disabled telemetry, unsampled requests, background work and operations started
after request completion create no children. The HTTP span covers streaming
transfer time; `file.stream` measures opening the storage stream.
The sole authentication/File child attribute, `sporades.operation.outcome`, is one of `success`,
`denied`, `error` or `cancelled`. Returned File rejections and recognized auth
denials use `denied`; unexpected thrown failures use `error`. Active children
end once when their callback settles or the HTTP request terminates; an abort or
an operation outliving its response uses `cancelled`. Non-success children have
error span status without a message or exception event. Operation success means
that boundary completed, and does not promise that an enclosing transaction
later committed. Authorization, rollback, opaque errors and response headers
retain their existing behavior.
No tokens, cookies, bodies, credential or actor identifiers, grants, File IDs,
versions, names, paths, URLs, contents or exception details are child metadata.
Inspect the request's stored trace in Jaeger to compare authentication, File ACL
and storage duration; a denied request can have successful credential resolution
followed by a denied admission or File authorization child. Missing storage bytes
keep the existing opaque 404 while the storage child reports `error`.

An abort before response headers has status class `none` in request metrics and
no response status attribute on its trace; an abort after headers keeps the
status that was sent. Both retain the `abort` outcome and count once.
Unknown targets collapse to `/__unknown`; surplus routes collapse to `/__other`.
Trace IDs and release IDs are not metric labels. Request bodies, queries,
credentials, private identifiers, exception text, baggage, and trace state are
not exported. A valid
W3C `traceparent` can establish parentage; remote sampling flags do not override
the local sampling policy. Dev and local Container sessions use these explicit
profiles for HTTP traces, request metrics and periodic process signals. Hosted
Capsules use the Host's shared relay connection by default with a Host-owned
per-Capsule opt-out; project settings cannot replace that decision. Independent
blocked-loop detection remains separate work.

### Background Job traces and queue metrics

The same selected Telemetry profile automatically monitors ordinary, Privileged,
Schedule-enqueued and runtime-owned Jobs in Dev, Container and Hosted Capsules.
No Capsule instrumentation import, public tracing API or additional configuration
is required. Each durable claimed attempt gets a new CONSUMER span named
`job <handler>`, with `sporades.job.handler`, numeric `sporades.job.attempt` and
`sporades.job.outcome`. Successful settlement uses `succeeded`; retrying failures
use `retry` and exhausted failures use `failed`, both with error span status.
Other outcomes are `cancelled`, `deferred` (runtime fence contention), and
`claim_lost` (including an unstarted claim relinquished at shutdown). Duration
covers the owned execution and settlement, excluding time waiting in the queue.

Enqueue atomically stores at most a validated 55-character W3C v00 trace context
(trace ID, span ID and sampling bit) alongside the Job. Each attempt is a new root
trace with one causal **link** to that enqueue operation, rather than an HTTP
child span held open during delay. Retries retain the same enqueue link; a child
Job links to the attempt that enqueued it. Local sampling applies independently
to every attempt, regardless of the stored sampling bit. An idempotent enqueue
keeps the original Job's context. Legacy Jobs without context and malformed
context execute normally without a link. Baggage, tracestate, payloads, results,
exception text, Job IDs, actor IDs, credentials and claim tokens are excluded.

| OTLP metric | Meaning |
| --- | --- |
| `sporades.job.queue.depth` | Current pending Jobs (`queued` plus `delayed`, including future availability); running and terminal Jobs are excluded. |
| `sporades.job.queue.oldest_pending_age` | Seconds since the oldest pending Job's original enqueue time, including deliberate delays and retry backoff; zero for an empty queue. |
| `sporades.job.execution.duration` | Execution/settlement duration in seconds, histogram by bounded handler and outcome. |
| `sporades.job.retry.count` | Committed transitions into failure retry, including expired-lease recovery; excludes deliberate runtime fence deferral. |
| `sporades.job.failure.count` | Failed attempts and committed failure classifications, including retrying failures, exhausted leases and invalid retained state; excludes cancellation and claim loss. |

Metrics ignore trace sampling. Queue observations use one aggregate Database
adapter read per export interval and reflect durable state after normal transaction
serialization. Reads are single-flight across Dev reloads; failed or stopped reads
produce no observation, not a healthy zero. Handler names come only from declarations,
with at most 128 names per provider lifetime; unknown, oversized and surplus names
collapse to `__other`. Attempt numbers and trace links are never metric labels.
Existing service, environment and process instance attributes identify the Capsule.
Counters and histograms reset with their provider; use rates across resets, and use
Job inspection for retained history. A killed process may lose its final span;
recovery counts its durable retry/failure transition but does not manufacture a span
for an interrupted attempt. The next attempt receives a fresh span. Claims, leases,
at-least-once execution, authority, rollback and restart recovery are unchanged.
Telemetry outages do not fail Job work; spans share the bounded trace queue and
metrics share the existing reader/export deadline.

For stored-trace acceptance, run `node --test test/telemetry-jobs-bundle.test.js`
with `SPORADES_CONFIG_DIR` inside a disposable worktree. Optional
`SPORADES_TELEMETRY_TRACE_INGEST_URL` and `SPORADES_TELEMETRY_TRACE_QUERY_URL`
select disposable **loopback** Collector OTLP/HTTP and Jaeger query origins. The
suite verifies persisted attempt spans and links, delayed/retried/failed work,
restart and lease recovery, legacy context, rollback, child links, disabled export,
collector outages, and Dev reload. Its OTLP metric capture works independently of
Prometheus setup.

### Database time in request traces

An enabled, sampled HTTP request or WebSocket operation automatically contains CLIENT spans from the
internal Database adapter, across SQLite, PostgreSQL and libSQL. No Capsule import,
new configuration, or adapter/plugin API is needed. Existing profile selection,
sampling, export limits and shutdown deadlines also govern these spans.

| Span / attribute | Meaning |
| --- | --- |
| `db.TRANSACTION` | The runtime transaction interval, including connection acquisition wait, callback work, commit or rollback. |
| `db.SELECT`, `db.INSERT`, etc. | One adapter statement call, including any connection wait. Children of the owning transaction, or directly of the HTTP or WebSocket SERVER span. |
| `db.system.name` | `sqlite`, `postgres`, or `libsql`. |
| `db.operation.name` | `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP`, `BEGIN`, `COMMIT`, `ROLLBACK`, `PRAGMA`, `TRANSACTION`, or `OTHER`. |
| `db.collection.name` | A declared app-table name (up to 128 names per adapter, at most 64 ASCII identifier characters), `__runtime` for the reserved runtime namespace, or `__other`. Absent on transaction spans. |
| `sporades.db.outcome` | `success` or `error`; failures also set ERROR span status without a message or exception event. |

Expand a request in Jaeger to distinguish statement time from callback work and
transaction wait. Transaction duration overlaps its children: adding both would
double-count time. Some engine-owned commit/rollback mechanics are included only
in the transaction interval. This measures adapter calls, not a database query
plan or an application-wide SQL profiler. Complex statements and statements over
8,192 characters use conservative labels. SQL text, parameters, rows, connection URLs,
credentials, private row IDs and exception details are never attached.

Initialization, detached Jobs and work after operation completion create no database
spans in this slice. Disabled or sampled-out requests keep the same database
behavior without operation spans. A collector outage does not change database
results, ACL checks, retries, transaction ownership, rollback or handle revocation.

### WebSocket operation signals

The same selected Telemetry profile automatically instruments `query.subscribe`
dispatch, each subsequent live-query execution, and `mutation.run`. No additional
configuration, Capsule import, browser SDK or public API is required. Connection
tokens, Origin checks, credential revalidation, per-connection message ordering,
subscription generations and reconnection behavior retain their existing meaning.
Dev uses the current session profile after a successful configuration reload;
outgoing connections settle against their original adapter before it exports.
Graceful shutdown settles accepted connections before final metric collection,
so its last active-connection sample is zero even with operations in flight.

| Signal | Meaning |
| --- | --- |
| `websocket.query`, `websocket.mutation` | One SERVER span per logical execution, including translated handler failures and authorization denials. |
| `sporades.websocket.operation.count` | Completed executions, unit `1`, independent of trace sampling. |
| `sporades.websocket.operation.duration` | Execution duration histogram in seconds, independent of trace sampling; includes cancellation intervals. |
| `sporades.websocket.active_connections` | Gauge of accepted connections, unit `1`; exports zero after the last connection closes. Rejected upgrades do not increment it. |
| `sporades.websocket.operation.type` | `query` or `mutation`. |
| `sporades.websocket.operation.name` | Runtime-declared handler/table operation name, at most 80 ASCII identifier characters and 64 distinct names per process. Unrecognized names use `__unknown`; surplus names use `__other`. |
| `sporades.websocket.outcome` | `success`, `denied`, `error` or `cancelled`. Denials, errors and cancellations set ERROR span status without exception details. Counts partitioned by outcome provide error/denial rates. |

Each operation has an isolated async context; database children belong to that
execution. Spans end on result settlement, unsubscribe, replacement, connection
close or shutdown. A superseded live-query execution is `cancelled`; this only
ends its telemetry and does not abort its handler or change transaction behavior.
There is no connection-lifetime or subscription-lifetime span. Refresh executions
start new root traces and retain neither subscription nor triggering mutation
context. Duration starts at dispatch, excluding time in the existing message queue.

A raw runtime message may supply an optional top-level `traceparent`, accepted
only as a nonzero, lowercase W3C version `00` trace/span identity with flags `00`
or `01`. Invalid correlation starts a new root trace; local sampling policy still
applies. Upgrade context is not inherited. `tracestate` and baggage are discarded,
and correlation is never retained in subscriptions. Arguments, payloads, message
IDs, connection/session tokens, user IDs, email addresses and exception text are
excluded from spans and metric labels. Existing browser transport messages need
no change. Prometheus stores the dimensionless connection gauge as
`sporades_websocket_active_connections_ratio`; its value is a connection count.
The Capsule API dashboard includes operation rates, p95 duration,
errors/denials/cancellations and active connections; its HTTP Route selector does
not filter WebSocket panels.

The generated-Bundle tests exercise SQLite by default. To also verify PostgreSQL,
set `SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL` to a dedicated disposable database.
The focused adapter tests use a separate disposable database selected through
`SPORADES_TELEMETRY_POSTGRES_TEST_URL`. For stored-trace acceptance, set
`SPORADES_TELEMETRY_TRACE_INGEST_URL` to a disposable Jaeger OTLP/HTTP origin and
`SPORADES_TELEMETRY_TRACE_QUERY_URL` to its query origin; the Bundle tests verify
stored traces through `/api/v3/traces/:id`. These test settings never configure a
real Host or the operator's saved Telemetry profiles.

When either the selected trace or periodic metric exporter fails, the existing
platform log records `telemetry.export.failed` with one bounded reason:
`AUTH_REJECTED`, `DESTINATION_UNAVAILABLE`, `TLS_FAILED`, or `EXPORT_FAILED`.
Repeated failures are limited to one event per reason per minute. Once a failure
has been reported, `telemetry.export.recovered` is recorded only after every
failed exporter has succeeded again. These events include no destination URL,
credential, response body, or exception text. An authentication rejection or
unreachable collector does not block Capsule requests. Check the Container's
platform log and monitoring stack readiness/storage separately when tracing is
missing.

### Outbound HTTP time

An enabled Telemetry profile also creates one `CLIENT` span for each native
global `fetch` call made while an HTTP request is active. No application
instrumentation import is required. Overlapping calls remain children of their
own `SERVER` span. The span measures time until response headers arrive,
including connection setup and the dependency's wait. Reading or streaming the
response body remains the caller's responsibility and is outside this span.
HTTP status 400 and above records `failure`; rejected calls record
`network_error`, `timeout` (a native `TimeoutError` DOMException, as produced by
`AbortSignal.timeout`) or `cancelled`. Caller-owned reason properties are never
evaluated to classify a rejection; a custom `name: 'TimeoutError'` remains cancellation.
If a signal becomes unsupported while a call is pending, telemetry records
`network_error` without inspecting its cancellation state.
Rejections retain the original error object. Telemetry does not add retries,
deadlines or redirects, and a blocked exporter does not delay dependency calls.

Span names are `HTTP <method>`. Attributes contain only a bounded method,
response status when available, and `sporades.http.outcome`. No destination,
path, raw query, headers, body, exception text or private identifier is exported.
Exporter calls, work outside an active HTTP request, and runtime-owned background
tasks are excluded. This slice does not instrument `node:http`/`node:https`,
imported fetch implementations, a fetch reference captured before telemetry
startup, WebSocket operations or Jobs. It supplies no public instrumentation API.
Do not layer another fetch instrumentation package over this owned wrapper.
The original global fetch is restored when the last telemetry owner shuts down.
Instrumentation supports native string/URL/Request inputs and ordinary data
`RequestInit` dictionaries (including frozen or inherited data fields). Accessor
or Proxy options, subclasses, custom coercion, custom dispatchers, custom header iterators,
unsupported or accessor-modified signals, and composite `AbortSignal.any` signals are
delegated directly to native fetch without spans or injected context. Evaluating
those options ahead of fetch could change redirect or rejection behavior.

Propagation defaults to off. An operator may repeat
`--trace-propagation-origin <origin>` when adding a profile:

```sh
sporades telemetry profile add dependencies --endpoint https://monitor.example --credential-env TRACE_INGEST_TOKEN --trace-propagation-origin https://dependency.example
```

The profile's optional `tracePropagationOrigins` array holds at most 32 exact
HTTP/HTTPS origins. Scheme, normalized hostname and port must match; wildcards,
credentials, paths, queries and fragments are rejected. This approval is separate
from the OTLP export destination and is never inferred from incoming headers or
Capsule project configuration. Local Container launch descriptors retain it;
`host telemetry connect` persists it in the Host-owned connection and subsequent
Hosted launch descriptors. Reconnect and restart existing Capsules to change it;
runtime coverage reports the usual pending restart until the descriptor matches.

Sporades adds a validated `traceparent` identifying the client span only when the
destination is approved **and the caller selected `redirect: 'manual'` or
`redirect: 'error'`** (including on a `Request` input). Default/follow redirects
are traced but receive no injected context, preventing cross-origin redirect
leaks without changing fetch semantics. No incoming baggage or trace state is
copied. Caller-authored headers remain the caller's responsibility. Each new
manual redirect fetch is checked independently against the approval list.

Focused packaged ESM tests run without runtime package resolution on Node 22.13,
Node 24, and the exact `ghcr.io/sporades/sporades-base:0.2.0-node22-alpine`
image. Run `SPORADES_FETCH_DOCKER=1 node --test
test/telemetry-fetch-bundle.test.js` to include the Docker matrix; it uses only
disposable containers and prints the tested image digests. Runtime behavior and
outage/redirect/privacy tests are in `test/telemetry-fetch.test.js`; native rejection
identity, getter-evaluation parity and classification regressions are in
`test/telemetry-fetch-rejection.test.js`.

## Create a Capsule

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
client/index.tsx (or client/index.ts for Vanilla TypeScript)
shared/types.ts
AGENTS.md
README.md
package.json
```

Blank Capsules additionally contain `server/payments.ts` and
`shared/payments.ts`. They are ordinary blank-template source: there is no
separate payment template or post-generation codemod.

Useful create options:

```sh
sporades create notes --template blank
sporades create guestbook --template guestbook
sporades create gallery --template photo-library
sporades create campfire --template campfire
sporades create tiny --framework preact
sporades create framework-free --framework vanilla
sporades create vite-react --framework react --toolchain vite
sporades create vite-preact --framework preact --toolchain vite
sporades create vue-todo --template todo --framework vue
sporades create vue-guestbook --template guestbook --framework vue
sporades create vue-gallery --template photo-library --framework vue
sporades create vue-campfire --template campfire --framework vue
sporades create svelte-todo --template todo --framework svelte
sporades create svelte-guestbook --template guestbook --framework svelte
sporades create svelte-gallery --template photo-library --framework svelte
sporades create svelte-campfire --template campfire --framework svelte
sporades create no-install-yet --no-install --no-git
```

Available templates are `blank`, `todo`, `guestbook`, `photo-library`, and
`campfire`. See [Projects and Client Frameworks](../guide/projects.md#choose-a-template)
for a short description of the features each template demonstrates.
Available client frameworks are `react`, `preact`, `inferno`, `lit`, `solid`, `vue`, `svelte`,
and framework-neutral Vanilla TypeScript. esbuild remains the React, Preact, and Inferno default client
toolchain, and they can explicitly select Vite with `--toolchain vite`. Vue
selects Vite and supports the complete template set. Svelte and SolidJS also
select Vite and support the complete template set. Lit also selects Vite and
supports the complete template set with native Web Components; Vanilla
TypeScript remains on esbuild. Inferno supports the complete template set, defaults
to esbuild, and accepts explicit `--toolchain vite`; both paths use native class
components and lifecycle adapters without React compatibility packages. Inferno/Vite
emits normalized hashed assets and uses Sporades full-page Dev refresh rather than HMR.
See [Choose a client framework](../guide/projects.md#choose-a-client-framework) for the
authoring style and adapter exposed by each framework.

The authoritative client capability matrix is:

| Framework | Default | Also admitted | Templates |
| --- | --- | --- | --- |
| Vanilla TypeScript | esbuild | — | blank, todo, guestbook, photo-library, campfire |
| React | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |
| Preact | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |
| Vue | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Svelte | Vite | — | blank, todo, guestbook, photo-library, campfire |
| SolidJS | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Lit | Vite | — | blank, todo, guestbook, photo-library, campfire |
| Inferno | esbuild | Vite | blank, todo, guestbook, photo-library, campfire |

Angular and server-owning meta-frameworks remain outside the Capsule runtime
contract: they fail before scaffold output rather than entering a partial path.

React/Vite, Preact/Vite, and SolidJS/Vite scaffolds reference `/client/index.tsx`; Lit/Vite,
Vue/Vite, and Svelte/Vite reference `/client/index.ts`. Lit defines the
`<sporades-app>` Web Component directly, while Vue and Svelte compile native `client/App.vue`
or `client/App.svelte` components respectively. SolidJS authors native JSX in
`client/App.tsx` with `jsxImportSource: "solid-js"`. All
keep `index.html` author-owned. Sporades runs Vite as an isolated one-shot build,
loads a regular project-owned `vite.config.*` so trusted project plugins can
extend transforms and resolution, and serves transformed HTML with its hashed
JS, CSS, source-map, and imported-asset tree. Project config is executable build
code and should only import trusted dependencies. Sporades always overrides
root, base, entry, output capture and names, public-directory handling, `.env*`
loading and `import.meta.env`, source maps, watch/library/SSR modes, PostCSS config
discovery, and the required framework/runtime plugins. Sporades remains the only
Dev watcher/server and requests a full-page refresh after successful rebuilds;
none uses a Vite dev server, HMR, framework refresh plugin, or another socket.
The same acknowledged Sporades full-page refresh protocol covers admitted
esbuild pairs, so toolchain selection never changes the Dev transport contract.
Migrating an existing React or Preact esbuild Capsule requires replacing the
`/client.js` script in author-owned `index.html` with `/client/index.tsx`. A
Vue source shell uses `/client/index.ts`. Sporades reports a mismatched source
entry as a write-free preflight error and never rewrites the source shell.

## Project public files

The optional project `public/` directory is merged by the Bundle pipeline for
both esbuild and Vite; no configuration setting is required. Regular files keep
their relative names and bytes: `public/favicon.ico`, `public/sitemap.xml`, and
`public/robots.txt` become `/favicon.ico`, `/sitemap.xml`, and `/robots.txt`.
Nested paths are supported, and a missing directory preserves existing behavior.
These assets are unauthenticated; other project directories are not published.

Generated output, including the required HTML entry, cannot be overwritten.
Symlinks, unsafe paths, `__sporades` paths, case and Unicode alias collisions, and combined
public-tree limit violations fail before publication. Dev watches additions,
edits, and removals and retains the last successful tree after a failed build.
Container and Hosted packaging, restart, and rollback use the same release-owned
tree. XML uses `application/xml; charset=utf-8` for GET and HEAD; ICO and TXT
retain their usual types. Unversioned assets use conservative caching.
See [Project public files](../guide/client.md#project-public-files) for limits
and [Public asset caching](../guide/client.md#public-asset-caching) for caching.

## How Sporades Projects Fit Together

### Project Files

`server/index.ts` defines the Capsule: schema, queries, mutations, endpoints,
messages, Jobs, middleware, and server-side behavior. A blank Capsule imports
its built-in payment mutations, Jobs, policy seam, and known-Job query from
`server/payments.ts`.

`client/index.tsx` is the browser entry. It imports the configured framework and
`sporades/client`.

`shared/` is for types and pure shared helpers. Keep it free of DOM APIs, Node
APIs, Server env, and Sporades runtime imports.

`index.html` is user-owned and served at `/`. esbuild clients load `/client.js`.
React/Vite and Preact/Vite source HTML instead load `/client/index.tsx`;
Vue/Vite loads `/client/index.ts`. Released HTML references transformed hashed
toolchain assets and stable URLs for project public files.

`sporades.json` configures the Capsule name, template, client framework and
toolchain, auth, optional payments, and default ports. Omitting `client.toolchain` preserves the
esbuild default for existing React and Preact Capsules. Vue defaults to Vite.

Sealed Server env stores server-only values in `.sporades/sealed-server-env/`
and exposes them as `ctx.env` inside server handlers. `.env.sporades.server`
remains supported as a legacy/import-friendly source.

`.sporades/` is the Runtime directory. Sporades owns it. It contains Bundles,
SQLite data, uploaded files, and local binding metadata. Do not edit it by hand.
For exact paths and mount layouts, see
[runtime layout](../runtime-layout.md#project-runtime-directory).

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

### Static prerender configuration (Vite)

`client.prerender` is an optional ordered array of `{ "name": "landing", "module": "client/render/landing.ts" }`
entries. Names must be unique, start with a letter and contain 1–64 letters,
digits, underscores or hyphens. Modules must be regular project-owned files at
explicit project-relative paths, without absolute paths, backslashes, `.` or `..`
segments. The selected toolchain must be Vite; esbuild rejects this configuration.

Each module default-exports a zero-argument function returning HTML or a promise
of HTML. Renderers execute sequentially in array order. In author-owned
`index.html`, `<!-- sporades:prerender NAME -->` places one fragment and
`<!-- sporades:prerender -->` places all fragments in order. Markers can occur in
the head or body and may be mixed or repeated. With no markers, all fragments
are inserted immediately after the opening body; fallback fails without a body.
Source HTML remains unchanged and emitted fragments have private comment
boundaries, without wrapper elements.

Unknown markers remain comments and warn with `PRERENDER_UNKNOWN_MARKER`.
Repeated placement warns with `PRERENDER_DUPLICATE_PLACEMENT`; configured but
unplaced fragments warn with `PRERENDER_UNUSED_FRAGMENT`. These warnings retain
successful build status and appear in human output and structured `warnings`
entries (`code`, `fragment`, `message`). Duplicate configured names, missing
modules, thrown/rejected renderers and non-string results fail the candidate
build without replacing the last successful normalized public tree.

Renderers are trusted build code, not sandboxed SSR. They receive no Server
runtime or Server-env context. Renderer-only assets are unsupported; use assets
from the ordinary Vite client graph. See [Build static prerender fragments](../guide/client.md#build-static-prerender-fragments)
for a configuration example and the trust and asset boundaries. See
[Prerender modules](./prerender-modules.md) for supported module formats,
module-relative loading and explicit CommonJS restrictions.

### Built-in Stripe payments in blank Capsules

Every newly generated blank Capsule includes this credential-free project
configuration:

```json
{
  "payments": {
    "stripe": {
      "enabled": false
    }
  }
}
```

`payments` remains optional so existing Capsules and non-blank demonstration
templates retain their current behavior. The dormant shape is exact and grants
no provider authority. Activation is all-or-nothing:

```json
{
  "payments": {
    "stripe": {
      "enabled": true,
      "secretKeyEnv": "STRIPE_SECRET_KEY",
      "webhookSecretEnv": "STRIPE_WEBHOOK_SECRET",
      "publicOrigin": "https://capsule.example",
      "callbackPath": "/stripe/webhook",
      "apiVersion": "2026-08-26.dahlia",
      "livemode": false,
      "requestTimeoutMs": 10000
    }
  }
}
```

The two env fields name values stored with `sporades env set`; secret values do
not belong in `sporades.json`. The runtime validates the complete shape and the
matching `sk_test_` or `sk_live_` and `whsec_` Sealed Server credentials before
publishing an activated Capsule. A hosted `publicOrigin` must be an exact HTTPS
origin. Explicit loopback HTTP origins are admitted for Dev sessions. Return
paths are resolved only against that trusted origin, never an incoming Host
header. Unknown providers, undeclared options, partial activation, mode-mismatched
credentials, malformed origins, and unsupported compatibility versions fail as
`INVALID_STRIPE_PAYMENTS_CONFIG`.

`callbackPath` is an exact same-origin absolute path outside the reserved
`/__sporades` runtime namespace. URL parsing must preserve the path exactly;
dot-segment forms, including percent-encoded forms, are rejected. When Stripe
is enabled, startup claims that path for one runtime-owned POST callback after
rejecting method-and-path collisions with Capsule Custom endpoints and other
enabled provider routes.
Disabled or absent Stripe configuration registers no callback route.
Sporades does not create or reconcile a Stripe webhook endpoint. The operator
registers the exact `publicOrigin + callbackPath` URL in Stripe after the
Capsule is reachable and seals that endpoint's matching `whsec_` secret.

The generated `server/payments.ts` contains an empty server-owned Price
catalogue, deny-by-default `authorizeStripeCheckout` and
`authorizeStripeCustomerPortal` policy seams, a Capsule-owned
`resolveStripeCustomerForPortal` seam, named
Checkout and Customer Portal Jobs, one `paymentStripeEvents` policy declaration,
and a query that exposes only bounded state
for a known payment Job owned by the current actor. `shared/payments.ts`
contains the serializable Job-state shape. `client/payments.ts` starts Checkout or Customer Portal,
reports pending, succeeded, or safely failed progress, validates the returned
Stripe-hosted URL, and redirects only after success. It is not imported into the
blank UI automatically.

To activate Checkout, define Capsule product keys in the server-owned Price
catalogue with an explicit `payment` or `subscription` mode, matching Stripe
Price identity, and maximum quantity. Then make an explicit billing decision in
`authorizeStripeCheckout`, enable the complete configuration, and seal both
named credentials. Browser input contains only an opaque intent ID, Capsule
product key, and bounded quantity; it cannot select the Stripe Price, Customer,
mode, metadata, idempotency namespace, or return origins. The linked-user
mutation atomically persists the selected mode with the intent and enqueues the
same durable Checkout Job for one-time and recurring work. Network I/O starts after commit. Capsule,
operation, actor, and intent identity form the stable Stripe and Job idempotency
key, so retries and repeated mutation calls converge on the same work. Transient
provider failures retry within the declared Job policy; permanent rejection is
retained as bounded redacted failure metadata.

Customer Portal is the preferred surface for ordinary customer-managed payment
methods, invoices, cancellations, and supported subscription changes. Capsule
policy still decides who may enter it. The linked-user Portal mutation first
checks `authorizeStripeCustomerPortal`, then asks Capsule code to resolve the
opaque billing-holder key to one existing Stripe Customer. Unknown Customers,
unauthorized holders, deleted Teams, and missing billing authority all fail
with the same unavailable result before enqueue and provider access. Sporades
does not create, enumerate, infer, or persist Customer ownership; the durable
Job payload carries the opaque Capsule billing-holder key rather than a Customer
identity. Immediately before provider access, the Job repeats policy admission
and Customer resolution under its captured linked actor, so Team deletion and
billing-authority revocation fail safely. The return path and idempotency namespace remain server-owned, and only
the initiating actor can observe the known Job and its validated short-lived
`billing.stripe.com` redirect.

Anonymous Checkout remains off by default. A Capsule may opt in only by
deliberately relaxing the linked-user guard, authorizing the guest in the policy
seam, and deriving the business reference in server code. That opt-in grants no
Customer Portal or Team billing authority. Portal always retains its linked
guard and independent Capsule billing-holder policy. The activated callback
verifies the exact bounded request bytes and `Stripe-Signature` header before
parsing. Each accepted provider Event identity commits one idempotent Privileged
Job before the route returns `200`; retries receive the same Job identity.
That identity is scoped by the retained Capsule database, not the mutable
configured Capsule name, so a rename and restart cannot admit the Event again.
Admission does not wait for or perform Capsule subscription, entitlement, or
access consequences.

The admitted Job is the only delivery path into Capsule policy. The blank
Capsule registers `stripeEvents: paymentStripeEvents`, where
`paymentStripeEvents` is declared with `stripeEvent(handler)` in
`server/payments.ts`. The handler receives the Verified Stripe event—not an HTTP
request, signature, or unverified body—inside the Job's userless Privileged
server-role attempt. Existing Job retry and cancellation keep the same Job
identity, and Privileged authority is revoked when each audited attempt settles.

Provider deliveries are duplicated and may be out of order. Make every Capsule
consequence idempotent and order-independent. Compare provider creation time or
authoritative provider state so a later-arriving older event cannot roll back
newer state. Unknown event types are forward-compatible and safe to ignore. The
verified raw provider value is sensitive: do not log or persist it by default;
store only bounded fields required by deliberate Capsule policy. Sporades stores
no second raw-event history and routine Job inspection omits the durable payload.
The reserved Job retains that payload while work is unresolved and for 30 days
after successful settlement, then replaces it with a non-sensitive marker while
keeping the digest-backed terminal replay tombstone. Failed, exhausted,
cancelled, queued, delayed, and running deliveries remain explicit unresolved
exceptions; Sporades never pretends discarded repair evidence was resolved.
A legacy successful row with an absent or malformed completion timestamp is
likewise unresolved and retains raw data without a deadline. Safe Job inspection
reports `INVALID_COMPLETED_AT`; once storage recovery restores a canonical
completion timestamp, inspection reports `CANONICAL_REPAIR_PENDING` until
cleanup automatically derives and applies the 30-day clock, without exposing a
general Job mutation surface.
Repair discovery is bounded and starvation-safe: a durable runtime-only opaque
cursor pages across classified rows, survives restart and overlapping cleanup,
and contains no Stripe identity or payload value. Incomplete pages re-arm
immediately. Once a full cycle still contains malformed rows, the runtime stores
a 24-hour safety deadline and resets the cursor; this bounds idle scanning while
guaranteeing that a direct canonical storage repair is detected within 24 hours
plus the time needed to drain any bounded 100-row pages ahead of it.

Subscription Checkout begins provider billing; it does not grant local access.
Verified events and Capsule policy determine any subscription, entitlement,
seat, order, billing-holder, or access consequences. Sporades creates none of
those Capsule records automatically.

Sporades owns Stripe transport, retries, compatibility, redirect validation,
and safe provider-error translation behind `sporades/server/stripe`. The Capsule owns
Prices, Customers, Teams, billing authority, subscriptions, entitlements,
notifications, retention, export, and erasure. Do not place secrets or provider
identities in `sporades.json`, shared code, or browser code.

#### Inspect a payment-bearing release candidate

Build and test the exact checkout first, then create an immutable local candidate
with `npm pack --json --ignore-scripts`. Record the reported `integrity`, `shasum`,
filename, and file list. Inspect that list for the Stripe integration runtime,
event dispatcher, declarations, generated manifest, scaffold generator, CLI, package
metadata, and consumer README before treating repository behavior as shipped proof.

Install the packed candidate into a fresh generated blank Capsule and run its
strict typecheck and real Dev Bundle as a consumer artifact. Prove the dormant
route remains absent, then exercise activated Checkout, Customer Portal, and
verified event delivery through that installed package. Scan the packed files,
generated source, Bundle, CLI output, Job state, and runtime logs for the exact
fixture secrets, signatures, raw-provider markers, authorization values, and
short-lived URLs used by acceptance. `npm pack` only creates a local candidate;
it does not publish, upgrade another Capsule, call Stripe, mutate a provider
account, or activate production.

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

#### Use Postgres locally

To run a Capsule against Postgres instead of the default embedded SQLite
database, declare a Postgres database Capsule service in `sporades.json`:

```json
{
  "name": "notes",
  "services": {
    "database": {
      "kind": "database",
      "engine": "postgres"
    }
  }
}
```

Then start the Capsule normally:

```sh
# Starts a Dev session and its Postgres service.
sporades dev

# Or builds and starts a local Container session on the same services network.
sporades deploy
```

Sporades generates `.sporades/compose/capsule-services.compose.yml`, starts a
`postgres:16-alpine` service, waits for it to become healthy, and selects the
internal Postgres Database adapter. Dev sessions connect through a generated
loopback port; local Container sessions use the generated Compose service name.
Sporades owns the database name, user, password, connection URL, network, and
Compose configuration. Do not copy those generated credentials into app code
or add a Postgres client dependency.

Capsule server code does not change when the database engine changes. Define
tables with `table()`, read and write through `ctx.db`, and use the normal query
and mutation APIs. Sporades applies the supported app-schema setup and
migrations through the selected adapter:

```ts
export default capsule({
  name: "notes",
  mutations: {
    createNote: mutation(async (ctx, input: { body: string }) => {
      return await ctx.db.notes.insert({ body: input.body });
    }),
  },
});
```

Inspect the running local session and its service state with the existing
structured commands:

```sh
sporades dev status --json
sporades deploy status --json
sporades doctor --session dev --json
```

Postgres data persists under `.sporades/services/database/` across ordinary
stops and restarts. `sporades dev reset` or `sporades deploy reset` deliberately
deletes generated Capsule service state, including the Postgres data. Changing
an existing Capsule from SQLite to Postgres selects a separate database; it
does not copy the existing SQLite rows automatically.

Postgres Capsule service orchestration is currently local-only. Hosted Capsules
do not provision or attach the declared service yet, so a Capsule that must run
on a Host server today should continue using the default embedded SQLite path.

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

`files.maxSizeBytes` configures the maximum size of one uploaded File. When it
is omitted, the limit defaults to 10 MiB (10 * 1024 * 1024 bytes). An explicit
value must be a positive integer byte count. `0`, fractions, non-numeric
values, and `null` are rejected at startup with `INVALID_FILE_CONFIG`.

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

## Start a Dev Session

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

## Log payload cap

See the [structured log payload cap contract](../guide/configuration.md#structured-log-payload-cap)
for `logs.payloadMaxBytes`, its `logging` alias, the identity-aware minimum,
and the `INVALID_LOG_CONFIG` error. The default is 4096 bytes; validation
never silently increases a configured cap.


## Additional deployment files

Use `deploy.files` to ship exact files from the project root to the same relative
location under `/app` in local Container sessions and Hosted Capsules:

```json
{
  "deploy": {
    "files": [
      { "path": "config/settings.json", "update": "preserve" },
      { "path": "resources/defaults.json" }
    ]
  }
}
```

`update` defaults to `"replace"`: the build snapshots the local bytes, and each
release supplies a read-only file. `"preserve"` seeds the file only if no stored
copy exists and mounts that copy writable. Server edits survive redeployment,
restart, and rollback. Replaced files roll back with their release; preserved
files do not roll back their contents. Failed installation attempts remove
only newly seeded files whose identity and contents are unchanged from their
active paths; existing preserved files and intervening edits are retained.
Rollback atomically moves seeds to `.rollback-<id>` recovery files under
`preserved-files/`, retaining those bytes because an editor may still have an
open file handle. If an atomic save races with rollback, Sporades restores the
captured replacement without overwriting a newer save, or retains it in recovery
storage. Recovery files can be removed manually after confirming they are no
longer needed.

Removing a preserved entry stops mounting it without deleting its stored copy.
Switching to `replace` also retains the inactive copy; switching back to
`preserve` reuses it. On a Host server these copies live under the Capsule's
`preserved-files/` directory; locally they live in `.sporades/preserved-files/`.
Each stored file uses `<SHA-256 of the NFC-normalized relative path>.file`, while
its Container mount remains `/app/<relative-path>`. This flat storage lets an
inactive `config` file coexist with a later `config/settings.json` declaration,
and switching back reuses the original stored bytes. The seed journal records
both the logical path and physical `storagePath`.
Local preserved copies stay owned by the invoking user with mode `0600`,
exactly like `.sporades/data`. Sporades never changes their ownership and runs
no privileged helper; SSH-enabled Container sessions reach them the same way
they reach `/app/data`. Before a Container starts, restarts, or is restored
after a failed replacement, each active preserved file is proven to be a
regular single-link file and tightened back to owner-only if an editor
loosened it. Removing a local Container removes its replacement snapshot while
preserving stored edits.

Every local or Hosted deployment that declares `deploy.files` is recorded before publication in `deploy-file-attempt.jsonl`
under the local `.sporades/` directory or the Hosted Capsule directory. The
journal names the attempted release, the candidate and previous Containers, every
temporary `.seed-*` path before it is created, and each seeded file's inode and
content hash. Successful installation or completed rollback removes the journal.
If the deployment process exits unexpectedly or recovery is incomplete, later
commands stop with the journal path instead of silently adopting uncommitted seed
bytes: locally `sporades deploy`, `deploy stop`, `deploy restart` and
`deploy remove`; on a Host, start, restart, rollback and verification fallback.
The install currently creating the journal may complete its own runtime start; a
later command cannot claim that exception.

Recovery is one explicit command rather than a manual procedure:

```sh
sporades deploy reconcile --json
sporades host reconcile <subname> --host <alias> --json
```

Reconciliation reads the journal and settles exactly what it recorded. When the
attempt never committed (the local binding does not name the journaled snapshot,
or the Host registry never recorded the release), it removes the untracked
candidate Container by its transaction label, restores the previous Container's
name, rolls back only seeds whose inode and bytes are unchanged (moving them to
`.rollback-<id>` recovery files), drops the candidate snapshot or release
directory and its private key, restores the Host `current` pointer to the
recorded release, and restores the bound runtime's file access. When the attempt
did commit, everything stays installed and only the journal and its recorded
temporary files are cleared. Edited seeds are always retained. The command
reports the actions it took and is safe to repeat; with no journal it reports a
clean state. Retry the deployment after it succeeds.

Local Container snapshots and Hosted archives have different size contracts.
The shared build checks paths, file types and source availability, but does not
apply Hosted archive quotas. The Host helper enforces these limits on the **whole
release archive**, including Sporades-managed files and directories:

- 247 UTF-8 bytes per archive path.
- 64 MiB per file.
- 128 MiB total uncompressed file bytes and 128 MiB compressed archive bytes.
- 2,048 archive entries, including directories.

A file set can therefore build or run in a local Container yet exceed Hosted
limits and be rejected during Host installation. Keep additional files within
the remaining archive budget; local build success does not establish that budget.

Preserved storage roots, local snapshot roots and Host-push staging roots are
owner-only. Additional staged
files and archives are private; the Host helper grants its runtime read access
to additional release files after validated extraction.

Local bindings retain pending snapshot cleanup paths until deletion succeeds.
A later deployment or Container removal retries that cleanup.

Preserved storage must have a single link so ownership and rollback operations
cannot affect an unrelated pathname.

Source snapshots reject symlink substitution during a build on every platform.
Linux and macOS read through descriptors that never follow symlinks; other
platforms open the validated path and then prove the opened inode is still the
one a symlink-free walk names before reading it.

Edit the file contents in place when editing a bind-mounted file. Replacing its
inode with an editor's atomic-save operation requires restarting the container
to refresh the bind mount. Locally, use `sporades deploy stop` followed by
`sporades deploy restart`; Hosted Capsules use `sporades host restart`. These
paths validate preserved files and restore the bound runtime's file access before
starting it. A surviving local attempt journal also blocks stop, restart, and removal until `sporades deploy reconcile` settles the candidate. Failed replacement restores access for the prior binding even when an editor has replaced the file inode; if that repair fails, the old runtime stays stopped and recovery is reported as incomplete.

Paths are normalized using Node path resolution. They must stay under the
project root and cannot collide with `.sporades/`, `public/`, `data/`, the server
or legacy client bundles, `index.html`, `sporades.json`, or Server env. These
reserved names are matched without case sensitivity on every platform, so
`.SPORADES/` and `Public/` are also excluded. Only
regular source files (including hard links) are accepted: directories, symlinks (including parent symlinks),
conflicting paths, and paths incompatible with the archive or
container mount format are rejected. Every declared source must exist at local
build time, including preserved seeds; failure names the file before upload.
Omitting `deploy.files` keeps the existing payload unchanged.

These files are server-side resources, not public assets. A Dev session reads
the original project files directly: `sporades dev` never snapshots, validates,
or mounts `deploy.files`, so a missing or symlinked declaration only fails
`sporades deploy` and `sporades host push`. Application code owns reading and reloading them;
Sporades does not watch or reload configuration for the application.

## Request-admission policy publication

Declare one deployer-owned JSON seed separately from writable `deploy.files`:

```json
{
  "admissionPolicy": { "path": "config/admission.json" }
}
```

Example v1 policy:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "blocked-path",
      "enabled": true,
      "conditions": [{ "kind": "pathname", "exact": "/blocked" }],
      "action": { "kind": "deny" }
    }
  ]
}
```

Dev, Container and Hosted HTTP runtimes enforce enabled non-address `deny` rules
before Capsule auth, File routes, endpoint middleware/handlers and public assets.
Each request snapshots one immutable generation. Disabled rules are skipped;
conditions are ANDed, and the first matching rule decides. A nonmatching request
keeps its original method, target, headers and body for the existing router.

A denial returns status `403`, `Cache-Control: no-store`, and exactly ten UTF-8
bytes: `Forbidden\n` (a final newline). The body and headers contain no rule ID,
reason, matched value or policy digest. The connection closes without reading the
application body. HTTP HEAD responses omit body bytes as required by HTTP while
retaining the same status and content length. CORS preflights are also admitted
before their automatic response. No Capsule request code runs on denial.

Admission canonicalization is explicit and does not change the original request:

- Methods compare after ASCII uppercase normalization; policy values are uppercase
  letters. HTTP extension method tokens remain valid requests but do not match
  an unrelated method condition. `OPTIONS *` has pathname `*` and no query keys.
- Origin-form and HTTP(S) absolute-form targets use the raw pathname (absolute
  authority is not a matching or identity input). An empty or whitespace-bearing
  absolute authority is rejected, including forms the URL parser could repair
  such as `http:///example.test/admin`. Path percent escapes decode
  exactly once as strict UTF-8, then `.` and `..` segments normalize, including
  encoded dots. A final dot segment preserves the resulting trailing slash;
  parents above root stay at root. Case, Unicode, trailing and repeated slashes
  remain distinct. `/admin` matches exact `/admin`, while prefix `/admin` matches
  `/admin`, `/admin/` and `/admin/child`, never `/administrator`. Prefix `/admin/`
  requires that trailing slash. Unicode is compared without Unicode normalization.
- Raw backslashes, whitespace/control bytes, encoded slash/backslash, malformed
  percent escapes, invalid UTF-8, decoded controls and remaining `%HH` path
  escapes fail closed while a nonempty policy is active. Thus `%252e` never
  receives a second decoding pass. Query and fragment bytes are never pathname
  inputs; literal fragments are invalid HTTP request targets and fail closed.
- Header names compare case-insensitively to lowercase policy names. Values trim
  only leading/trailing ASCII space and tab (HTTP OWS); interior whitespace and
  value casing stay exact. Policy exact values must already have no outer OWS.
  Presence includes an empty value and repeated occurrences. Exact-value
  matching requires **one raw header occurrence**; duplicates are indeterminate
  and fail closed unless another condition rules out that rule. Values are
  never split on commas or compared using Node's joined/discarded header map.
- Query keys use form decoding once: percent-encoded UTF-8 and `+` as space.
  Key casing is exact; repeated keys mean presence, regardless of their values,
  and empty `&` components are ignored. Encoded `&` or `=` inside a key remains
  part of the key. `%256bey` is the literal key `%6bey`, not `key`. Invalid escapes,
  UTF-8 or decoded controls anywhere in the query, including values, fail closed;
  the URL parser's replacement-character repair is never matching policy.

Invalid targets and malformed canonicalization return the same opaque denial,
even when a rule would otherwise not match. No policy retains existing behavior.

Genuine GET runtime-health and connection-token controls dispatch before
admission, with their existing Host probe and same-origin token-request checks.
They never read the admission generation. Reserved exact paths and prefixes
covering them are rejected during policy validation, even in disabled rules or
rules with additional conditions. Aliases and other methods enter admission.

HTTP admission supports method, exact/prefix pathname, header, query-key and
trusted Hosted address/CIDR conditions. Every supported condition must match;
their order inside a rule does not affect the outcome. A missing trusted address
or ambiguous exact-header duplicate is indeterminate:
a nonmatching condition skips the rule, otherwise it fails closed. Evaluation
stops at the first match; a matching deny returns the opaque denial, while a
matching quota action applies its bounded fixed-window counter. Traffic denied
earlier never reaches a later rule or action.

WebSocket upgrades use the same gate before any protocol switch in Dev, Container
and Hosted runtimes. The request's actual HTTP method, canonical pathname, raw
public headers, query keys and Host-authenticated address select one complete
generation, exactly as for ordinary HTTP. `/__sporades/ws` is Capsule traffic;
it has no blanket exemption. A matching deny returns the same opaque HTTP 403
and never sends `101 Switching Protocols`. Quotas share their per-process buckets
with ordinary HTTP and return the same opaque 429 and Retry-After. Nonmatching
upgrades retain existing connection-token, Origin and application transport checks.
Unsupported Capsule upgrade targets also enter admission before rejection.
Reserved GET control targets have no WebSocket transport: the runtime closes them
without reading policy or consuming quota buckets. They do not become alternate
Capsule upgrade endpoints.

Without a policy declaration, the admission gate returns synchronously before
parsing or touching request/response objects, reading bodies, or emitting logs.
Removed and empty policies also pass through. The explicit no-policy gate budget
is a warmed median below **1 microsecond per call**, measured by seven batches of
200,000 calls in `test/http-admission.test.js` (loop/assertion overhead included).
This is an incremental gate budget, not a network round-trip or event-loop latency
guarantee. Existing no-policy HTTP/streaming/WebSocket tests retain their behavior.
Rules retain array order, stable unique IDs (1–64 ASCII letters, digits, `.`, `_`,
`-`, starting with a letter or digit), explicit Boolean `enabled`, and one or more
AND conditions. The closed v1 vocabulary is:

| Condition/action | JSON fields |
| --- | --- |
| Method | `kind: "method"`, uppercase `value` (1–32 letters) |
| Pathname | `kind: "pathname"`, exactly one of `exact` or `prefix` |
| Address/CIDR | `kind: "address"`, IPv4/IPv6 `value` with optional valid prefix length |
| Header | `kind: "header"`, lowercase token `name`, optional exact `value`; omitted value means presence |
| Query key | `kind: "query-key"`, `name` (presence only) |
| Denial | `kind: "deny"` |
| Fixed-window quota | `kind: "rate-limit"`, integer `limit` (1–1,000,000), integer `windowMs` (1,000–86,400,000) |

Unknown fields, versions, match kinds and actions fail validation. Paths must be
absolute canonical pathnames, without percent escapes, backslashes, query or
fragment components, raw whitespace or dot segments that require normalization. Rules cannot name the runtime-health or
connection-token controls, or a prefix covering them. Header matching excludes
credentials, cookies, Host/routing and internal/proxy address fields: `host`,
`connection`, `authorization`, `cookie`, `set-cookie`, `forwarded`, `via`,
`true-client-ip`, `x-real-ip`, and names beginning `proxy-`, `x-forwarded-`,
`x-sporades-` or `cf-`. These fields cannot supply public matching or authenticated
identity shortcuts. Header/query matches grant no identity or application
permissions.

Address conditions match one canonical IPv4 or IPv6 literal, or a CIDR network.
IPv6 is normalized to lowercase with the first longest zero run compressed.
IPv4-mapped IPv6 (`::ffff:192.0.2.1` or `::ffff:c000:201`) is the same identity as
`192.0.2.1`, and matches IPv4 networks. Mapped CIDRs must use prefixes 96–128,
which normalize to IPv4 prefixes 0–32; shorter mapped prefixes are rejected.
Other IPv6 networks never match normalized IPv4 identities, including `::/0`.
Network host bits are masked during matching. Prefix lengths must be decimal,
without signs or leading zeros, in 0–32 for IPv4 or 0–128 for IPv6. Malformed
addresses, multiple slashes, zones, ports, brackets, whitespace and lists fail
generation validation, including in disabled rules.

Only Hosted mode can supply trusted client identity. The Host's Caddy route
replaces caller-supplied `x-sporades-client-address` and
`x-sporades-client-address-token` values. Automatic TLS routes use the connection
peer, never `Forwarded`, `X-Forwarded-For` or `CF-Connecting-IP`. In
`cloudflare-origin` mode the existing Cloudflare IPv4/IPv6 source allowlist rejects
other peers before forwarding `CF-Connecting-IP`. This uses the ordinary free
Cloudflare proxy and requires no paid account feature. Duplicate Cloudflare
headers become a list and cannot supply identity.

The Host/runtime boundary validates and canonicalizes exactly one address before
admission. It requires a per-runtime capability derived separately from the
Host-owned readiness token; Hosted mode or a private header name alone grants no
authority. Missing/invalid capability, duplicate headers, absent address, or an
invalid address yields no trusted identity. The capability is omitted from
Capsule endpoint request headers and never emitted by admission diagnostics.
Changing the Host readiness credential revokes older address capabilities;
ordinary restarts retain the existing Host credential. Upgrade the Host helper
and regenerated Capsules together and recreate their managed routes; an older
route without the capability cannot provide trusted identity. Existing
loopback-only published ports and managed route ownership remain required;
public callers must not reach a Capsule origin around Caddy. The capability also
prevents an unauthenticated caller reaching the origin from forging identity.
Access-key source limiting uses this same canonical authenticated identity.

An enabled address-dependent rule is evaluated after any condition mismatch has
been ruled out. If it might apply and trusted identity is absent, the request
receives the same opaque `403`, `Forbidden\n` bytes and `Cache-Control: no-store`
as a matched denial. It does not fall back to a public forwarding header or the
runtime socket's proxy address. Dev (including Public Dev) and local Container
sessions always have no trusted address, even if supplied with internal headers;
potentially applicable address rules and quotas fail closed there. Disabled rules
are skipped and unrelated rules continue to operate normally.

A matching `rate-limit` action counts each request in a fixed window keyed by
`(stable rule ID, canonical trusted client address)`. Under quota, the first
matching rule admits the request; later rules are not evaluated. An earlier deny
therefore never consumes a later quota. Quotas always require trusted identity,
even without an address condition. Missing identity takes the opaque `403` path
above, without creating a bucket or falling back to public forwarding headers.

For example, `"action": { "kind": "rate-limit", "limit": 20, "windowMs": 10000 }`
allows twenty matching requests per client in a ten-second local window. The
first counted request starts the window using monotonic elapsed time, independent
of wall-clock changes. At exactly `startedAt + windowMs`, the next request starts
a fresh window. Over-quota matches count with a saturated counter, without
extending the window. They return an opaque `429`, exactly `Too Many Requests\n`
(18 UTF-8 bytes), `Cache-Control: no-store`, and integer `Retry-After` seconds
rounded up from the remaining window time. HEAD omits body bytes. No Capsule
request code runs; no rule ID, address or policy digest appears in the response.
Fixed windows permit a boundary burst: up to twice the quota can arrive around a
window boundary (the remaining quota immediately before, then a fresh quota after).

Each runtime caps the combined table at **10,000 buckets across all rules**.
Expired windows are pruned during counting. At capacity, insertion evicts the
least recently counted bucket; ties follow deterministic Map insertion order.
Denied matches refresh recency. Capacity evictions increment `rateLimit.evictions`
in authenticated runtime health; expiry and policy invalidation do not. Bucket
keys and counters are bounded by the validated rule ID, canonical IP and quota
bounds. An evicted identity gets a fresh window on its next match: address churn
can weaken quotas at capacity. Monitor aggregate eviction counts and size quotas
with that tradeoff in mind. No raw addresses or rule IDs enter these diagnostics.

Hot reload preserves buckets only for still-enabled stable IDs with unchanged
`limit` and `windowMs`; matcher/order edits preserve compatible buckets. Changing
an ID or either parameter, disabling/removing a rule, or removing the policy
clears affected buckets before the new generation becomes active, even with no
intervening request. Invalid hot updates retain both policy and buckets.
**v1 is in-memory and per-process**, rather than a global or distributed quota.
Process restart resets all buckets; replicas and separate Capsule processes have
independent quotas. It is a fixed-window counter, not a token bucket.

Bounds are 65,536 UTF-8 bytes, nesting depth 8 (root depth 0), 128 rules,
16 conditions per rule, and 1,024 UTF-8 bytes per match string. An empty rule array
is valid. The seed and active stored policy must be contained regular files with
no symlinks or hard links. The seed cannot overlap any `deploy.files` path or a
Sporades-managed path. The internal `"admission"` storage class is not a valid
project `deploy.files.update` value.

Container and Hosted deployment seeds once into persistent, isolated storage.
The policy directory mounts read-only at `/run/sporades-admission`, rather than
at its project-relative source path. Capsule code cannot modify it. Existing
stored edits and explicit removal survive redeploy, restart and rollback.
Changing/removing the declaration keeps the inactive copy. In Dev the loader
reads the project seed; no deployment ownership isolation is promised there.

After the first deployment, publish through the operator boundary:

```sh
sporades deploy policy publish ./next-policy.json --json
sporades deploy policy remove --json
sporades host policy publish ./next-policy.json --host work --subname notes --json
sporades host policy remove --host work --subname notes --json
```

These commands require a recorded deployed policy and reuse lifecycle locking;
interrupted deployment journals require reconciliation first. Publication accepts
only bounded validated policy JSON, commits by atomic rename and does not require
a rebuild or restart. Removal writes an explicit internal marker; a transient
missing/unreadable file retains policy and reports degradation. Publish a valid
policy again to re-enable it.

Startup loads before Capsule code and app traffic. Invalid configured startup
fails; hot failures retain the complete immutable last-known-good generation.
The runtime polls every two seconds and swaps complete generations atomically,
meeting the ten-second update target under normal scheduling. The Host-authenticated
runtime-health response adds `data.runtime.admissionPolicy` with `state`
(`healthy`, `degraded`, `disabled`), active SHA-256 `digest` or `null`, and
`rateLimit: { buckets, maxBuckets, evictions }` aggregate local quota diagnostics.
It also adds `evidence.version: 1` with fixed aggregate `counters`: `evaluated`,
`admitted`, `denied` (opaque 403), `rateLimited` (opaque 429), `reloadFailures`,
`reloadRecoveries`, `limiterEvictions`, `decisionsEmitted` and
`decisionsSuppressed`. Counters are unsigned 64-bit **decimal strings**, exact
through `18446744073709551615`; reaching the ceiling retains that value and a
subsequent increment sets `saturated: true`. They never wrap or silently lose
precision. Totals and sampling reset on process restart, survive hot policy
changes and explicit removal, and have no per-client or per-rule dimensions.
Each evaluated active generation, including an empty policy, has exactly one
admitted/denied/rate-limited outcome. Removal disables evaluation; genuine
reserved GET controls never count. HTTP and pre-switch WebSocket admission
use the same accounting and quota buckets. Limiter eviction counts capacity
evictions, excluding ordinary window expiry and reload reconciliation.

Platform `admission.decision` events are sampled: at most **20 attempts per
60,000 monotonic milliseconds**, and at most one per stable rule ID/outcome pair
in that window. A process retains at most **20 sample keys**, even across
generation churn; address, route, headers and query values never form a sample
key. Suppression increments its exact aggregate total without allocating a log
event. Sink failures cannot alter decisions and still consume the sample budget.
Samples contain only the validated rule ID or `null`, action or `null`, closed
outcome, active digest, session kind (`dev`, `public-dev`, `container`, `hosted`),
transport (`http`, `websocket`) and route class (`ordinary`, `capsule-transport`,
`invalid`). Route class never contains a pathname. No address fingerprint is
emitted in v1; client addresses and all match values are omitted entirely.

`admission.policy.loaded`, `admission.policy.failure` and
`admission.policy.recovery` events carry redacted health/digest/counters.
Every failed load attempt and recovery bypass decision sampling, including a
cold failure before the runtime logger exists (redacted stderr JSON). Concurrent
reload calls coalesce into one load; normal polling is once per two seconds.
A hot failure retains the complete last-known-good digest while reporting
`degraded` (or retains the disabled state after explicit removal). Successful load or explicit removal after degradation increments
`reloadRecoveries` and emits recovery.

`sporades doctor --session dev|public-dev|container|hosted --json` reports the
active snapshot under the corresponding `doctor.<session>.admission-policy`
check (`public-dev` uses `dev`). Degradation, unavailable inspection or a legacy
runtime without v1 counters is a warning;
`--strict` makes warnings fail. Text doctor includes digest and totals too.
`sporades host stats <subname> --json` adds `data.admissionPolicy` for a Capsule
whose release declares policy storage, using an authenticated probe inside the
bound container; `null` means evidence could not be read and resource stats
remain available. Hosted health carries the snapshot in `data.runtime`.
Operator surfaces allowlist fields and validate bounded strings/counters even
when a runtime supplies extra fields. They expose no raw addresses, matched
header/query values, raw query strings, credentials, bodies or proxy headers.
These are read-only extensions of existing commands, with no new dashboard,
public evidence route or Capsule API. No declaration adds no loader, policy
fields, inspection check or policy logs. See
[the authority ADR](../adr/0054-request-admission-policy-is-deployer-owned.md).
