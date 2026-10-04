# Resource and API warning policy

These thresholds are configurable **starting policy**, not SLO promises. Prometheus
owns all evaluation; Alertmanager retains the established grouping, silencing,
firing and resolved webhook delivery. No rule restarts or modifies a Capsule.

The September 28 revision of parent #107 supersedes copied container CPU-quota,
memory-limit and Docker OOM/restart-loop requirements in #121. This slice uses
Host capacity/pressure and existing process telemetry. It does not install a
Docker socket collector or claim container resource attribution. Process CPU is
measured in CPU cores: one busy core is not total Host saturation. RSS and the V8
heap limit cannot be used as a container memory denominator. Lifecycle inventory
cannot establish a Docker OOM cause or crash-loop count.

| Warning | Initial condition | Sustained window |
| --- | --- | --- |
| Host CPU contention | busy CPU >90% **and** CPU PSI waiting >10% | 5 minutes |
| Host RAM | available / total <15%, or critical <5% | 10 minutes / 2 minutes |
| Host swap | >1 page swapped out/second and available RAM <15% | 10 minutes |
| Host I/O contention | full I/O PSI stalls >20% | 10 minutes |
| Writable Host filesystem | available bytes <10% or <1 GiB; free inodes <10% | 5 minutes |
| Monitoring backend filesystem | available bytes <10% or <1 GiB | 5 minutes |
| Unknown backend disk | filesystem stat unavailable | 1 minute |
| API failures | 5xx >5%, at least 100 completed/aborted requests in trailing 5 minutes across all routes in one Capsule/environment | trailing 5-minute evidence; no extra delay |
| API route latency | independent histogram p95 >1 second, at least 100 non-aborted samples in each trailing 5 minutes | 10 minutes |
| Process pressure candidate | >0.9 CPU cores, p99 event-loop delay >100 ms, and API 5xx | 5 minutes |

High Host utilization alone does not page. Unsupported PSI is unavailable, never
healthy zero. Host disks exclude pseudo/overlay filesystems and read-only mounts;
verify your real Docker and Sporades data mounts are included by node_exporter.
Monitoring disk values come from `statfs` on read-only mounts of the actual
Prometheus and Jaeger named volumes. These describe backing filesystem capacity,
not volume quotas, retention guarantees or additive totals on a shared disk.
Inode capacity is measured for Host filesystems. The pipeline dashboard links to
these backend capacity measurements. Disks must be provisioned separately when
independent failure boundaries matter.

Performance rules for Capsules require acknowledged running/failed inventory.
A stopped, deleted or opted-out Capsule stops paging once acknowledged; pending
or stale acknowledgement remains visible. A canonical Hosted service identity
must be unique within this operator trust domain. Dev/Container telemetry with
other identities remains visible on dashboards but does not silently become a
paging target. Quiet services use the existing independent public probe and
protected local readiness warnings; tiny error ratios do not page. CPU candidates
are warnings for investigation, not proof of a runaway. Expected Job services can
be exempted from that candidate rule; API errors, probes and Host pressure remain
active. This does not depend on future deep traces or job scheduling changes.

## Configure and apply

In the operator-owned `.env`, set one optional `ALERT_POLICY_JSON` object. Missing
fields retain the starting policy. Setup preserves the original line and unknown
environment keys. Invalid/unknown keys, malformed JSON, unbounded arrays,
nonpositive values and ambiguous duplicate budgets fail with a value-free error
before replacing provisioned files. All scalar fields below are numeric; ratios
must be in (0,1], sustained windows must be integral 15–86400 seconds, request
sample minimum must be a positive integer. Other positive thresholds are bounded
at 1e12; per-route latency budgets are at most 86400 seconds.

```dotenv
ALERT_POLICY_JSON='{"apiErrorRatio":0.05,"apiMinRequests":100,"apiBudgetSeconds":1,"apiLatencyForSeconds":600,"routeBudgets":[{"service":"apps.example/reports","route":"/report","seconds":3}],"streamRoutes":["/events","/download"],"expectedJobServices":["apps.example/batch"]}'
```

Budget selectors are exact canonical service and declared route templates,
including built-in templates, not arbitrary request URLs. Each of the three
lists is limited to 64 entries and JSON is limited to 16 KiB. Never include query
strings, user IDs, credentials or request-derived paths. Declare **all deliberate
long streams** in `streamRoutes` before enabling latency pages. They remain in
request/error counts and overview graphs, but are excluded from latency rules.
There is no heuristic that assumes every chunked download or slow request is a
stream. Unknown routes share `/__unknown`; budget/exclude that identity only when
all work in that category justifies it. Do not hide interactive slow work by
excluding a mixed route.

Other scalar keys and defaults:

```json
{
  "hostCpuBusyRatio": 0.9, "hostCpuWaitRatio": 0.1, "hostCpuForSeconds": 300,
  "memoryAvailableRatio": 0.15, "memoryForSeconds": 600,
  "memoryCriticalRatio": 0.05, "memoryCriticalForSeconds": 120,
  "swapPagesPerSecond": 1, "ioPressureRatio": 0.2, "pressureForSeconds": 600,
  "diskFreeRatio": 0.1, "diskFreeBytes": 1073741824,
  "inodeFreeRatio": 0.1, "diskForSeconds": 300,
  "processCpuCores": 0.9, "eventLoopDelayMs": 100, "processForSeconds": 300
}
```

The critical RAM ratio must be below the warning ratio. Run `node setup.mjs`,
validate `.private/performance-rules.yaml` with the pinned `promtool check rules`,
then recreate Prometheus with your existing unique Compose project name to apply.
Prometheus reads this generated rule file; do not add duplicate Grafana rules or
edit private output instead of policy. `performance-rules.yaml` is the shipped
starting-policy fixture and is parity-tested against the generator. Alertmanager
notification configuration continues to use `ALERT_WEBHOOK_URL`, optional
`ALERT_WEBHOOK_TOKEN`, and `MONITORING_PUBLIC_URL`. Policy contains no channel
credentials and is not forwarded to Capsule runtime/profile descriptors.

## Navigate and verify

Every warning includes an action, evidence window and Capsule/Host/pipeline plus
fleet dashboard links. Fleet inventory rows link to Capsule API/resources and
Host pressure. Dashboards retain selected variables/time while switching views.
Acknowledged inventory `changedAt` values annotate lifecycle/deployment changes
using Prometheus series values as Unix timestamps, following the [Grafana
annotation contract](https://grafana.com/docs/grafana/latest/datasources/prometheus/annotations/).
Annotation queries restrict observations to the first two minutes after the
Host timestamp, with a 30-second minimum step; the repeated gauge does not
produce markers throughout an idle day. Changes first acknowledged after that
window remain visible as the latest fleet timestamp but have no event marker.
Historical observations remain in Prometheus retention; intermediate changes
between acknowledgements/scrapes are not an event journal. An unchanged release
may accompany a start/stop; release IDs are not multiplied across metric series.
Existing runtime process-instance/uptime graphs help investigate restarts without
claiming an OOM event. Latency percentiles always use independent request
histograms, never sampled traces or Caddy counts added to Capsule counts.

Use `SPORADES_PROMTOOL_BIN` for pinned local promtool, or
`SPORADES_REAL_PROMTOOL=1` for disposable pinned Docker rule tests. Run
`node --test test/telemetry-performance*.test.js`. The local delivery drill is
`SPORADES_CONFIG_DIR="$PWD/.sporades/issue-121/config" SPORADES_PROMETHEUS_BIN=... SPORADES_ALERTMANAGER_BIN=... node scripts/verify-performance.mjs`.
It creates local temporary state, drives a generated Bundle through controlled
5xx/recovery traffic, and records real Prometheus/Alertmanager firing/resolved
webhook payloads. It uses shortened configurable sustained windows only where
appropriate; the default policy windows are independently tested by promtool.
Docker availability acceptance remains `node scripts/verify-availability.mjs`,
with a worktree-local config directory and a unique project. Neither local drill
certifies a real Host/Monitoring VM or the operator's real notification channel.
