# Standalone monitoring stack

This directory runs authenticated OTLP/HTTP traces, independent API metrics, and periodic process resource and pressure metrics for enabled Capsules. Jaeger remains at the protected gateway root; Grafana provisions **Sporades Capsule API** at `/grafana/d/sporades-api` and **Sporades Capsule Resources** at `/grafana/d/sporades-resources`. The stack is independent of a Sporades Host and can run on a separate VM. Container/Host collectors, alert routing, and Host relay are separate increments.

## Requirements and images

Use Linux `amd64` or `arm64`, Docker Engine 29.x and Docker Compose 2.40.3 or later (Compose 5.5.1 is also tested), Node.js 22.13+ for setup and smoke scripts, and local disk for retention. Image tags are fixed: OpenTelemetry Collector contrib `0.138.0`, Jaeger `2.21.0`, Prometheus `3.13.3` LTS, Grafana `13.2.2`, BusyBox `1.37.0`, and gateway base Node `24.13.0-alpine3.23`. The Prometheus LTS and Grafana release were checked against their [official download](https://prometheus.io/download/) and [official release](https://grafana.com/grafana/download/) pages on 2026-09-27; Grafana `12.2.0` was avoided because it predates the [CVE-2026-33382 fix](https://grafana.com/security/security-advisories/cve-2026-33382/). Check newer patches during upgrades.

Named `traces`, `metrics`, and `grafana` volumes persist Jaeger Badger, Prometheus TSDB, and Grafana state. Jaeger retains spans three days by default (`TRACE_RETENTION=72h`). Prometheus starts at 14 days (`METRIC_RETENTION=14d`) and 8 GB of retained blocks (`METRIC_DISK_CAP=8GB`), whichever limit comes first. Reserve **at least 10 GB of local disk for metrics**: the 8 GB setting leaves 20% nominal room, but WAL/head and compaction can briefly exceed the retention target. Monitor free space and size the Host from measured series and sample rates. Prometheus initially scrapes its own health metrics every 15 seconds; Capsule metrics export every 15 seconds by default. Edit `prometheus.yaml` for the scrape interval and use the Telemetry profile's `--metrics-interval-ms` for Capsule export. Prometheus, Grafana, Collector, and Jaeger have no published ports; only the gateway publishes one. Services have bounded memory, CPU, process, queue, request, and log settings.

For sizing, record real peak request rate, active series (`prometheus_tsdb_head_series`), ingested samples/s (`rate(prometheus_tsdb_head_samples_appended_total[5m])`), volume usage, and memory with `docker stats --no-stream` over a representative day, then project 14 days with the [Prometheus storage guidance](https://prometheus.io/docs/prometheus/latest/storage/). A tiny installed-CLI canary on 2026-09-27 used 264 KiB of metrics volume and one snapshot showed gateway 22 MiB, Collector 174 MiB, Jaeger 22 MiB, Prometheus 35 MiB, and Grafana 314 MiB; that traffic is too small to establish production capacity. The Compose memory limits total about 3 GiB, and the Host needs room beyond container limits for Docker and the OS.

## Configure and start

From an installed Sporades CLI, run `sporades monitoring stack init --dir '/srv/sporades traces'` to generate this directory, then `sporades monitoring stack validate --dir '/srv/sporades traces'` to inspect missing settings and version differences. Both commands support `--json` with the standard `{ ok, data, error }` envelope. Initialization requires a running Docker Engine 29.x, Docker Compose 2.40.3 or later, and a supported amd64/arm64 host (macOS with Docker Desktop is supported for local testing). It copies packaged assets only when absent, leaves `.env`, Compose overrides, and data untouched, and never starts services. A `stack-manifest.json` records the package and schema version for a new empty directory. An existing directory without a manifest is reported as having unknown provenance and is not stamped with the current version. A later package version is reported for review, while local files remain in place. For upgrades, compare preserved files with the new versioned release asset before applying pinned configuration changes. Do not place an operator `.env` in a release asset.

From this directory, run `node setup.mjs` as the user who owns the stack directory. It creates `.env` with mode `0600` if absent and generates only missing `TRACE_INGEST_TOKEN`, `TRACE_UI_PASSWORD`, and `GRAFANA_ADMIN_PASSWORD`. Existing values, unknown keys, and operator comments stay literal and unchanged. The example leaves stack-owned credentials unset and certificate paths commented, so copying `.env.example` to `.env` safely generates those credentials on setup and reports the two external certificate keys as missing. Explicit `REPLACE_WITH_GENERATED_SECRET` or empty owned credentials are rejected by setup before private files are written; validation rejects the placeholder by key name without showing its value. Setup reports missing external setting names, never their values. It writes `.private/credentials.json` for the three gateway credentials and `.private/grafana-admin-password` for Grafana; both are mode `0600`, while `.private/` is `0700`. Credentials are mounted as files, never interpolated through Compose. `.compose.env` contains only settings Compose needs, including retention, the Grafana root URL, and the non-root service UID/GID. A root Linux installer transfers only derived private credential files to UID 1000. Grafana's persistent volume is initialized for the same non-root identity. Use `.compose.env` with `--env-file`; do not print resolved Compose configuration because it can contain operator paths. Unquoted `.env` values are literal after `=`; single-quoted values can escape an apostrophe with `\'`, and double-quoted values use JSON escapes. Run setup after every `.env` edit. Keep `.env`, `.private/`, `.compose.env`, `certs/`, and private backups off Git.

Choose one TLS arrangement in `.env`:

- **Direct TLS:** Keep `TRACE_TLS_MODE=tls`. Place the certificate chain and key in `certs/`, set `TRACE_CERT_FILE=/certs/fullchain.pem` and `TRACE_KEY_FILE=/certs/privkey.pem`, and make them readable to the gateway UID in `.compose.env`. For a separate monitoring VM, set `TRACE_BIND=0.0.0.0`, open only `TRACE_PORT` (default `8443`), set `GRAFANA_ROOT_URL=https://monitor.example:8443/grafana/`, and use `https://monitor.example:8443` as the OTLP/HTTP origin. Private CA clients must trust the supplied CA. For smoke, set `SMOKE_ORIGIN=https://monitor.example:8443` so the hostname matches the certificate; use `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` when the issuing CA is private. The smoke script keeps normal TLS certificate and hostname verification.
- **Existing TLS proxy:** Set `TRACE_TLS_MODE=proxy` and keep `TRACE_BIND=127.0.0.1`. Point the same-VM HTTPS reverse proxy at `http://127.0.0.1:8443`, forwarding `/v1/traces`, `/v1/metrics`, `/health`, root Jaeger paths, and `/grafana/*`. Set `GRAFANA_ROOT_URL=https://monitor.example/grafana/`; the public ingestion origin is `https://monitor.example`. Proxy mode refuses a non-loopback gateway bind. Forward the original path and public Host; keep the loopback HTTP listener private.

Run `node setup.mjs` again after editing, then `docker compose --env-file .compose.env up -d --build`. Ordinary `docker compose --env-file .compose.env down` preserves all three volumes; `down -v` destroys them. Use `docker compose --env-file .compose.env ps` and `GET /health` to check readiness. The endpoint returns only `{"ok":true}` with HTTP 200 after bounded synthetic writes through Collector and stored Jaeger/Prometheus reads, or only `{"ok":false}` with HTTP 503 otherwise. It caches checks briefly to bound probe load. No watchdog is installed. Each probe stores a small synthetic trace and a metric with a fresh value; an older readable metric cannot satisfy a new probe.

Send OTLP/HTTP traces to `/v1/traces` and metrics to `/v1/metrics` with `Authorization: Bearer <TRACE_INGEST_TOKEN>`. This credential grants ingestion only. The gateway accepts uncompressed OTLP/HTTP or `Content-Encoding: gzip`, forwarding compressed bytes unchanged to Collector; other content encodings return HTTP 415. Uploads have a 2 MiB wire-size limit and a three-second body deadline. Jaeger root UI/query and Grafana `/grafana/` share HTTP Basic with `TRACE_UI_USER` and `TRACE_UI_PASSWORD`; Grafana then serves a provisioned anonymous Viewer role behind the gateway. The separate generated Grafana admin password is a private file. Raw backend ports remain inside the Compose network. The UI gateway allows up to 15 seconds total per authenticated Jaeger or Grafana request, including response streaming; stalled or interrupted backend responses and disconnected browsers close their upstream connection. The three-second ingest body deadline and two MiB wire limit remain separate. The API dashboard has Capsule, environment, and declared-route selectors, plus throughput, p95 latency, errors/denials, in-flight requests, and p95 by route. The Resources dashboard selects Capsule, environment, and process instance and shows CPU cores, cumulative user/system time, RSS, heap, external memory, ArrayBuffers, uptime, GC count/duration, event-loop delay/utilization, and API p95 latency excluding aborted requests, matching the API dashboard. CPU cores use reset-aware `rate(process_cpu_time_seconds_total[${metric_window}])`: `1.0` means one full core and a multi-core process can exceed `1.0`.

Process metrics use `service.name` and a random `service.instance.id` per Node process lifetime, avoiding a reused PID being mistaken for one continuous series. Dev telemetry reload within one process keeps the same identity. `process.cpu.time` is cumulative user/system **seconds**; `process.uptime` is **seconds**; memory gauges are **bytes**. The V8 heap limit is not a container/RSS cap. RSS, heap, and external memory overlap; ArrayBuffers (including Buffers) are already part of external memory, so do not add these lines. Heap changes cannot reliably attribute a leak to a request. The exporter samples only on the configured metric interval (15 seconds by default; profile range 5–300 seconds), even when no requests arrive, and its reader stops on disable/reload/shutdown. GC uses a single Node PerformanceObserver: `process.gc.count` (cumulative count, `1`) and `process.gc.duration` (cumulative seconds, `s`), with only `kind=major|minor|incremental|weakcb|other`. Grafana shows reset-aware rates. Event-loop delay is sampled by Node's interval histogram, with `process.event_loop.delay.max`, `.mean`, and `.p99` gauges reporting nonnegative **milliseconds of lag beyond the configured sampling interval** for the latest export window. Max uses the larger of the measured peak and a conservative lower bound for unrecorded time around a histogram reset, even when there are no native samples. The lower bound can understate a missed stall. Mean and p99 use only Node's recorded samples; with no new native sample the exporter may repeat their prior gauge values. `process.event_loop.utilization` is a **0–1 fraction** since the previous periodic collection, with the first sample used only as a baseline. It measures time outside the event provider, not CPU. Both dashboards default their `Metric window` selector to **12 minutes**, which includes at least two exports at the supported 300-second maximum (Prometheus range selectors exclude the left boundary). For profiles exporting every 30 seconds or faster, select **2 minutes** to read short changes more clearly. The selected Metric window must contain two actual exports; `rate` and histogram p95 cannot be computed from a single sample. Choose a dashboard time range that shows the workload and its later exports. The Resources dashboard applies this window to CPU/GC rates, API p95, and the recent maximum event-loop delay; the API dashboard applies it to request rates and p95. A longer window smooths rates and holds an old delay peak longer, so it does not prove a stall is still occurring. The metric reader remains the only collection interval. The delay monitor runs at `--event-loop-delay-resolution-ms` (10–1000 ms, default 20 ms); shorter resolution costs more timer work and may reveal shorter stalls. GC callbacks also cost workload-dependent time. A finite synchronous stall appears only after the event loop recovers. A permanently blocked process cannot run its own collector and may stop exporting; independent probes are a later increment. These measurements are per Node process, with the same instance selector as CPU/memory. Container and Host series are later increments.

## Smoke test and restart proof

After startup, choose the origin the smoke command will contact. Direct TLS requires `SMOKE_ORIGIN=https://monitor.example:8443` (or your actual certificate hostname and port). For an existing public HTTPS reverse proxy, use `SMOKE_ORIGIN=https://monitor.example`. A proxy-mode stack on the same machine can omit `SMOKE_ORIGIN` and keep the loopback `http://127.0.0.1:TRACE_PORT` default. Only loopback HTTP is accepted; a remote origin must use HTTPS. For a private CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the smoke command environment. From this directory, for example, run `SMOKE_ORIGIN=https://monitor.example:8443 NODE_EXTRA_CA_CERTS=/path/to/ca.pem node smoke.mjs send`. It checks readiness, rejects invalid trace/metric ingestion and missing UI credentials, verifies the provisioned Grafana dashboard, sends a real authenticated trace, and queries it through Jaeger. Save the trace ID. Then run `docker compose --env-file .compose.env restart collector jaeger prometheus grafana gateway`, repeat the same `SMOKE_ORIGIN` and optional `NODE_EXTRA_CA_CERTS` with `node smoke.mjs query TRACE_ID`, and check that the prior metric series remain queryable in Grafana. Generate real Capsule requests before judging API panels; `rate(...[5m])` needs two metric export points at least 15 seconds apart. The script reads `.env` locally and prints no credentials. Never paste `.env`, `.compose.env`, or `.private/` into diagnostics.

## Backup, restore, and upgrades

Stop the stack for a consistent backup of Jaeger, Prometheus, and Grafana. Back up all four named volumes (traces, metrics, grafana and inventory) plus private `.env`, `.private/`, `certs/`, configuration, and any proxy config. Protect backups like credentials. To restore, stop the stack, restore those volumes/files, run `node setup.mjs`, then `docker compose --env-file .compose.env up -d --build`; the one-shot initializers restore non-root volume ownership. Verify with smoke and stored metric queries. For upgrades, save a backup and pinned files, review image/config changes, then run `docker compose --env-file .compose.env pull` and `docker compose --env-file .compose.env up -d --build`. Roll back with saved files and volumes if a new version changes storage format. Setup never rotates a present credential.

## Host pressure and Caddy dashboards

The distribution includes `/grafana/d/sporades-hosts` and
`/grafana/d/sporades-caddy`. Upgrade the Sporades CLI/helper and run
`sporades host telemetry reconcile --host <alias> --json` on connected Hosts
(or `connect` for a new connection). The Host relay privately scrapes pinned
node_exporter and Caddy and sends metrics over its existing authenticated
OTLP/HTTPS connection. No new public scrape port is needed, including when
this stack runs on a separate VM. Deploy the new Compose/dashboard assets and
recreate Grafana to mount the new dashboards; preserve `.env` and data volumes.

Select a Host using `sporades_host`. Missing data/unsupported PSI is not zero.
Caddy graphs use the top-level subroute handler only; do not add these edge counters
to Capsule request counts. Host data does not attribute resource use to a
container. See the Sporades server-installation guide for resource lifecycle,
private networking, real filesystem coverage and rollback.

## Automatic lifecycle inventory

The gateway also owns a narrow lifecycle inventory service. Its separate `inventory`
volume retains expected Hosts, Capsule identities, states, release IDs, lifecycle
change times and sanitized public origins independently of Host availability. This
service does not schedule probes, send absence alerts, or administer Capsules.
Every accepted Host record remains expected until explicit operator recovery;
revoking a sender or losing contact never deletes its record. `started` and `failed`
Capsules are expected active targets; `registered`, `released`, `stopped`, `deleted`
and `opted-out` states suppress active-target expectations. Public origins alone
are exported; protected runtime readiness credentials stay on the Host.

Provision one independent random token per Host (at least 16 characters; 32 random
bytes recommended) in the operator-owned `.env`, using a single-quoted JSON map:

```dotenv
TRACE_INVENTORY_HOSTS='{"host-one":"<independent-random-Host-token>"}'
```

Use a stable inventory Host ID matching `[a-z0-9][a-z0-9.-]{0,127}`. Identity is the
whole Host installation/remote root, including all its Hosted domains. Never share
this token between Hosts or reuse the ingestion/UI token. `node setup.mjs` validates
unique authorities and writes them only to protected `.private/credentials.json`;
then recreate the gateway to apply additions, rotation or revocation. An absent map
means no Host can write inventory. There is no enrollment or remote-admin API.
Keep existing entries when adding another Host. Setup preserves `.env` and never
implicitly generates, changes or removes these Host authorities.

Register the matching verified HTTPS profile on the workstation:

```sh
sporades telemetry profile add monitored --endpoint https://monitor.example \
  --credential-env TRACE_INGEST_TOKEN --inventory-host host-one \
  --inventory-credential-env HOST_ONE_INVENTORY_TOKEN
sporades host telemetry connect --host work --profile monitored --json
```

Set both referenced tokens in the configuring process environment. The helper
stores the inventory token separately in its protected `telemetry` directory.
Upgrading an older connected Host requires adding the inventory reference and
reconnecting with the current CLI/helper; old connections expose
`inventory.configured: false` until this migration. The ingestion-only profile
continues to work for Dev/Container sessions. The default inventory identity when
`--inventory-host` is omitted is the selected Host profile's Hosted domain; once
connected, keep that ID when changing endpoint, credentials or Hosted addresses.

Bootstrap/connect install a per-domain systemd inventory timer, after network
startup, at 30-second intervals. It scans **all** authoritative registries under
the Host root, persists the latest desired snapshot with an increasing revision,
and sends it outbound over verified HTTPS. Lifecycle actions queue desired state
locally without a network request; timer reconciliation also recovers a crash
between registry commit and queueing. No workstation is needed after connection.
Non-systemd installations must schedule the installed helper's `--sync-inventory`
entry point at the same interval; the argument is base64url JSON containing the
Host's `alias`, `domain`, `scheme` and absolute `remoteRoot`. Capsule operation
remains available if inventory is temporarily unavailable. Check bootstrap's
`autostart.installed` or connect's `inventoryScheduler.installed` result; unsupported systemd is not automatic reconciliation.

`sporades host telemetry status --host work --json` exposes desired/acknowledged
revision, original acknowledgement time, last attempt/confirmation time, pending
revision, stale contact (no successful confirmation for two minutes), and sanitized
delivery status. Changing the Monitoring endpoint queues a new revision and resets acknowledgement
status until that destination confirms it; an in-flight acknowledgement from the
old destination cannot mark the new inventory synchronized. Lost acknowledgements
retry the same revision. Identical retries
return the original acknowledgement; reordered older revisions or conflicting
same-revision payloads return HTTP 409. Snapshots retain deleted identities as
empty-target tombstones; omitting previously acknowledged identities is rejected.
An unavailable sender leaves central expectations intact. Address/alias changes,
registration, deploy, start/restart/rollback, stop, delete and opt-out are inferred
from Host state; a restart of the same release changes its lifecycle timestamp.

The only HTTP inventory paths are `GET` and `PUT /v1/inventory/<host-id>` with that
exact Host's Bearer token. Ingestion and UI credentials grant no inventory access.
The body is the version 1 `TelemetryInventory` JSON contract shipped in
`src/types/telemetry-inventory.d.ts`, capped at 2 MiB. GET returns the stored snapshot
and acknowledgement; PUT returns revision and acknowledgement time. Wrong Host
identity/authority returns 403; invalid input returns 400. The service namespaces
all Capsule identities under its authenticated Host. It does not grant authority
over any other Host, even when two records contain the same domain/subname.

### Recovery and durable storage

Use manual transfer only for disaster recovery, never ordinary deployment:

```sh
sporades host telemetry inventory-export --host work --json
sporades host telemetry inventory-sync --host work --json
INVENTORY_ORIGIN=https://monitor.example INVENTORY_TOKEN="$HOST_ONE_INVENTORY_TOKEN" \
  node inventory-recovery.mjs export host-one > central-export.json
```

For a lost Host inventory journal, extract `.inventory` from that central export
into a snapshot JSON file and run `sporades host telemetry inventory-import
snapshot.json --host work --json`. It checks the exact connected Host and version,
then reconciles authoritative local registry state above the recovered revision.
For lost central inventory, extract `.data` from Host `inventory-export --json`
into a snapshot and pipe it to `inventory-recovery.mjs import host-one` with the
same environment. Private CAs use `NODE_EXTRA_CA_CERTS`. Both recovery paths use
the live validation, authority and revision rules; they cannot bypass a conflict.
If both journals are lost, restore a backup before reconnecting. Do not delete a
central record to clear stale contact or reuse a Host identity for another server.

Include the `inventory` volume in consistent stack backups and preserve the Host's
`telemetry/inventory/desired.json` alongside its protected connection, inventory
credential and CA. Restore the four storage volumes and private configuration
before readiness verification. `inventory-init` restores volume ownership before
starting the gateway. `/health` also requires writable, protected inventory state;
telemetry ingestion and the inventory write path remain independent of backend
trace/metric availability. Existing stacks must review and install the new gateway,
Dockerfile, inventory assets, Compose service/volume and setup changes; regeneration
preserves operator overrides and does not silently overwrite old assets. The gateway
image includes Linux `flock`; Linux Hosts already require `flock` for lifecycle locks.
