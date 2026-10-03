# Monitoring outage and recovery runbook

Telemetry is best effort. Capsule requests, Jobs and Host lifecycle changes do
not wait for Monitoring. A successful SDK/gateway export means downstream
acceptance, not durable backend storage. Sampling, overflow, retry expiry,
process termination and storage failures can lose data; retries can duplicate it.

## Budgets

| Stage | Fixed limits | Load-dependent buffering | Expiry / shutdown |
| --- | --- | --- | --- |
| Capsule SDK | 128 queued spans, 32 per batch; 5 trace and 1 metric sockets | Queued span objects plus metric series under existing cardinality caps; no disk spool | 600 ms HTTP attempt, 800 ms processor/reader budget; 1500 ms shutdown; no durable trace retry |
| Host relay | Docker 192 MiB, 0.5 CPU, 128 PIDs; memory limiter 96 MiB / 24 MiB spike | 16 MiB serialized queue per signal; 2 consumers; batches capped at 256 items | 2 s attempt; backoff 1–5 s; 300 s retry budget per dequeued batch; 5 s Docker stop |
| Monitoring collector | Docker 256 MiB, 1 CPU, 128 PIDs; memory limiter 192 MiB / 48 MiB spike | 16 MiB serialized queue per exporter/signal; 2 consumers; batches capped at 256 items | 2 s attempt; backoff 1–5 s; 30 s retry budget per dequeued batch; 5 s Docker stop |
| Gateway | Docker 192 MiB, 1 CPU, 128 PIDs | 32 authenticated ingests, each at most 2 MiB; body chunks and concatenation temporarily overlap | 3 s upload, 1.5 s Collector exchange; overflow rejects immediately; 2 s SIGTERM |
| Persistent collector (optional) | **Dedicated 128 MiB filesystem quota**, separate from application and inventory storage | Same 16 MiB queues; bbolt metadata, mmap and compaction need headroom beyond serialized bytes | fsync; 1 s storage lock; same finite retry limits; process restart resumes saved queues |
| Host inventory | Protected atomic desired/ack state; versioned snapshots at most 1 MiB | Latest desired inventory replaces prior state, rather than appending every lifecycle event | Independent worker on boot (30 s) / every 60 s; network attempts bounded; no monitoring HTTP on lifecycle path |

Queue capacity measures serialized payload bytes, **not resident heap or on-disk
file size**. Docker memory limits and a real filesystem quota supply the hard
bounds. Collector memory refusal and OOM termination shed telemetry; they must
not share the Capsule process or its storage. No queue blocks on overflow.
SDK metrics are cumulative: later samples can recover totals within the same
process, but gaps in gauges/histograms and process restarts remain lossy.
Retry budgets start when a consumer dequeues a batch, not when it enters the
queue. These are not wall-clock retention guarantees, and restarting a consumer
can reset retries. The default SDK, relay and collector telemetry queues are
volatile and are lost on restart. Inventory is always durable.
Prometheus accepts samples out of order within a finite 10-minute window to
allow concurrent consumers to replay short outages. Older backlog and conflicting
duplicate samples can be rejected and lost. This window uses additional TSDB
head memory/WAL disk within the existing Docker limit; tune it from measured
rates. It does not extend queue retry budgets or guarantee historical delivery.
See the [Prometheus TSDB configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#tsdb).

## Pipeline visibility

The provisioned **Sporades Telemetry Pipeline** dashboard uses private gateway
and Collector scrapes; relay self-observation travels through its existing OTLP
path. It shows queues/capacity, admission failures, failed sends, SDK saturation
loss, collection age and last successful acceptance. SDK component sequence
names and exporter error details are removed from labels. Source collection time
detects stale replay; a sample timestamp alone cannot prove fresh collection.
`last_success` is absent until the first success. No panel fills missing data
with zero. Compare missing Capsules/Hosts against lifecycle inventory; discovery
cannot determine whether a never-seen sender should exist. Relay/SDK diagnostic
samples can themselves be lost in the outage. Local logs and Host status remain
useful when central metrics are unreachable.

`pipeline-rules.yaml` provisions warning rules for missing private scrapes,
queue pressure, admission loss and failed sends. Notification routing belongs
to the existing alerting setup; these rules do not add a new receiver. Neither
rules nor dashboards can notify while the entire Monitoring server is down.
The public `/health` keeps its exact `{ "ok": true|false }` contract and verifies
fresh readable traces and metrics. Private diagnostic ports are never published.
Backend pressure includes Collector RSS, failed sends, queue pressure and
Prometheus block storage; use Host filesystem free-space metrics for total disk
headroom. The 8 GB Prometheus retained-block target does not cap WAL/head disk.

## Optional persistent Collector queues

Use this only when restart survival is required. Provision a **dedicated,
local filesystem or project quota capped at 128 MiB**, owned by `10001:10001`,
mode `0700`, and set `PIPELINE_QUEUE_DIR` to its absolute directory. Do not point
it at the Host outbox, Capsule data, backend storage or a general unbounded
directory. Compose cannot enforce a directory quota; verify the quota on the
Monitoring machine before enabling this override. Example invocation:

```sh
PIPELINE_QUEUE_DIR=/srv/sporades-queue docker compose --env-file .compose.env \
  -f compose.yaml -f compose.queue.yaml up -d
```

Both the override and persistent Collector config are shipped. Preserve operator
configuration when upgrading schema 2 to schema 3; stack init reports differences
and does not replace edited files. Add the private scrape/rules/dashboard mounts
and finite queue settings after reviewing your local changes.

Full queues reject new batches; retries expire and discard dequeued batches;
full disk/failed writes reject admissions and can prevent Collector startup.
Accepted but unfinished writes, corrupt databases, lost/quota storage and forced
shutdown can lose data. bbolt compaction needs spare quota; if it cannot compact,
the Collector can fail and remain unavailable until space is recovered. Do not
delete a queue to make the health endpoint green without recording the loss.
Stop only this Collector, back up its queue if safe, restore storage space, then
restart. Restart the backend and wait for queues to drain, fresh samples and a
successful `/health`; acceptance alone is insufficient. Do not claim exactly-once
delivery, indefinite buffering or a precise lost-item total.

## Reproducible disposable drills

From a checkout, set `SPORADES_CONFIG_DIR` inside that checkout. The Docker
acceptance fixture generates its own stack, credentials, network and project;
it tears down only those resources. It never uses a saved Host or Telemetry
profile, SSH, cloud infrastructure or a live endpoint.

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/outage-config" \
  node --test test/telemetry-outage.test.js test/monitoring-pipeline.test.js \
  test/lifecycle-inventory.test.js test/host-inventory-reconnect.test.js
SPORADES_CONFIG_DIR="$PWD/.sporades/outage-config" \
  SPORADES_REAL_TELEMETRY_OUTAGE=1 node --test test/telemetry-outage.acceptance.test.js
SPORADES_CONFIG_DIR="$PWD/.sporades/outage-config" node scripts/verify-host-inventory.mjs
```

The Docker drill records a resource report under `.sporades/outage-drills/`:
image versions, phase durations, serialized queue occupancy/capacity, RSS,
memory limit, disk usage and recovery. The finite drill accelerates retry and
queue sizes in disposable copies to make overflow/expiry deterministic. Its
quota simulation uses a 128 MiB tmpfs volume held by a separate fixture container
so it survives Collector restarts. It proves process/container restart recovery,
**not machine reboot durability**; production requires a durable quota filesystem.
For a longer soak, repeat bounded traffic while disconnected and retain the
reports; compare idle and loaded RSS and disk high-water marks. Measurements
are workload-specific, not a fleet sizing or overhead promise.

Separate-VM link interruption, power loss, actual filesystem quota exhaustion
and a 48-hour canary are operator acceptance drills on disposable infrastructure.
Do not induce faults on Live or production applications. Preserve Host desired
inventory throughout an outage; after reconnect run the normal periodic worker
or `host telemetry inventory-reconcile`, check pending/ack revisions and verify
the latest central state. Replay an older revision must return conflict and
must never resurrect a stopped/deleted Capsule.
