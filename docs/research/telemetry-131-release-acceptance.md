# Packaged monitoring release acceptance — #131

Status: **incomplete; rollout gates have not passed** (2026-10-08). This record
and local verifier accompany a draft PR. Production canary execution is #132.

## Prerequisites and candidate

The live native dependency audit found all eleven blockers closed (#113, #115,
#121–#126, #128–#130); separately named #118/#120 are also closed. The
[#128 real separate-VM acceptance](https://github.com/mgscox/sporades/issues/128#issuecomment-6066627099)
supersedes its pending handoff. It tested repair #224 at
`c3a6e6e65fad0e58af339ac80ddb40f3fcd98777`, including controller-off recovery,
applied migration/rollback, fresh stored production delivery and retained history.
That prerequisite result does **not** establish assembled release acceptance.

Runtime sources and shipped files are from main at
`ffa5eb6d517bdaa95a9f1542b9b6dcbb7811517a`. Parked [PR #225](https://github.com/mgscox/sporades/pull/225)
was closed unmerged; its branch was fetched and merged to preserve its history.
This change adds acceptance tooling/docs, with no runtime, public/configuration
contract or packaged-payload change. [Local evidence](./telemetry-131-local-evidence.json)
identifies exact archives, installed CLI/helper/manifest and generated Capsule.
Preserve these archives for deployment: a new pack can have a different archive
hash even when every shipped file matches. Record actual deployed image digests.

## Reproduce local verification

Run in an isolated candidate worktree with dependencies installed. The verifier
uses ports 5218/5219 and a unique worktree evidence directory. It installs the
supplied archive with npm lifecycle scripts disabled, stops only its own child
and receiver, and preserves reports. It never invokes Docker or a real Host.

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/issue-131-config"
mkdir -p "$SPORADES_CONFIG_DIR" .sporades/issue-131-release
npm run build
npm run typecheck
COPYFILE_DISABLE=1 npm test
node scripts/check-generated-bin.mjs
COPYFILE_DISABLE=1 npm pack --ignore-scripts --json \
  --pack-destination "$PWD/.sporades/issue-131-release"
COPYFILE_DISABLE=1 TMPDIR="$PWD/.sporades/issue-131-release" \
  node scripts/monitoring-stack-release.mjs \
  "$PWD/.sporades/issue-131-release/sporades-monitoring-trace-0.9.31.tar.gz"
node scripts/verify-monitoring-release.mjs \
  "$PWD/.sporades/issue-131-release/sporades-0.9.31.tgz" \
  "$PWD/.sporades/issue-131-release/sporades-monitoring-trace-0.9.31.tar.gz"
COPYFILE_DISABLE=1 node --test --test-concurrency=1 \
  test/generated-source-manifest.test.js test/monitoring-stack-cli.test.js \
  test/telemetry-fetch-bundle.test.js
COPYFILE_DISABLE=1 node --test --test-concurrency=1 \
  test/monitoring-release-verifier.test.js
npm run docs:check
```

Do not run `npm run package`: it publishes and tags. The verifier checks all
installed shipped bytes and monitoring-archive parity, invokes the installed
CLI, scaffolds a Vanilla Capsule without app `node_modules`, and drives
concurrent successful requests and a translated failure. It asserts authenticated
OTLP trace/metric receipt, a known failure SERVER span before exception privacy
credit, distinct trace/request identities through existing
CLI log inspection and absence of its synthetic privacy seeds in OTLP. This
loopback receiver is a fixture. It waits up to 20 seconds for all required
request SERVER spans and metric names, and validates physical runtime/evidence
parents before writes and the actual configuration path before CLI calls. Receipt
does not establish stored traces, backend
queries, Compose, exhaustive privacy, performance or operator alert delivery.

With a healthy **local** Docker engine, additionally run:

```sh
SPORADES_FETCH_DOCKER=1 node --test --test-concurrency=1 test/telemetry-fetch-bundle.test.js
SPORADES_MAINTENANCE_DOCKER=1 node --test --test-concurrency=1 test/monitoring-maintenance.acceptance.test.js
SPORADES_REAL_TELEMETRY_OUTAGE=1 node --test --test-concurrency=1 test/telemetry-outage.acceptance.test.js
SPORADES_REAL_TELEMETRY_CA_CONTAINER=1 node --test --test-concurrency=1 test/telemetry-container-ca.acceptance.test.js
```

These harnesses use owned resources and teardown. Maintenance uses a packed CLI;
outage uses the checkout CLI, accelerated queue limits and a tmpfs fixture; CA
uses a receiver fixture. None alone fills final deployment gates. On this desk
`docker info` timed out after ten seconds; no Compose/Container drill started.

## Runtime and storage matrix

| Surface | Declared contract | Fresh evidence |
| --- | --- | --- |
| CLI/runtime | Node `>=22.13.0 <23 || >=24` | macOS arm64, Node 24.19.0/npm 11.17.0 only |
| Base | `node:22.14-alpine`, `0.2.0-node22-alpine` | Not run; digest/Node 22 evidence pending |
| Monitoring | Linux amd64/arm64, Docker 29.x, Compose >=2.40.3 | Asset parity only; engine unavailable |
| Gateway | `node:24.13.0-alpine3.23` | Packaged Dockerfile only |
| Backends | Collector 0.138.0, Jaeger 2.21.0, Prometheus 3.13.3, Grafana 13.2.2 | Packaged declarations only |
| Probes/alerts | Blackbox 0.28.0, Alertmanager 0.34.1, BusyBox 1.37.0 | Packaged declarations only; delivery pending |

Defaults: 72-hour traces, 14-day metrics and 8 GB retained metric blocks. The
stack README requires at least 10 GB for metrics plus separate room for traces,
WAL/head/compaction, other volumes, logs and OS. Compose limits total roughly
3 GiB; these limits are not measured consumption or accepted capacity. No new
capacity, retention safety, disk-headroom or memory-growth result is claimed.
See packaged `monitoring/trace/README.md`, `OUTAGES.md` and `MAINTENANCE.md`.

## Fresh local outcome

Poirot round 1 reproduced a false pass when failure spans were discarded, an
early rejection of valid delayed request spans, and writes through a symlinked
evidence parent. These verifier defects are fixed. Nine external process/HTTP
regressions pass against an installed CLI and actual generated Capsule: missing
failure spans, seven-second delays of request spans and a required metric, both
runtime/evidence symlink parents, normal failure evidence, both tampered archive
types, and SIGTERM listener cleanup. No SDK or CLI implementation is mocked.
The full-suite environment also exposed npm 11 rejecting inherited
`npm_config_allow_scripts` during isolated installation. The verifier removes
that root-project setting while retaining `--ignore-scripts`; the normal-path
regression explicitly seeds it, and all nine pass with it inherited. The earlier
full run is preserved as failed (3,217 tests: 2,982 passed, seven verifier-install
failures, 228 skipped); isolated passes do not replace that failed run.
The corrected verifier also passes against the same retained archives listed in
the JSON record. This supersedes the earlier verifier result only; it establishes
no additional deployment, recovery, alerting, performance or capacity gate.

Build/typecheck and generated freshness passed. The subsequent fresh full suite passed (3,217
tests: 2,989 passed, 228 skipped, zero failures/cancellations). Focused parity
passed (8 passed, 3 Docker-matrix skips). Installed parity checked 494 files and
36 monitoring assets. Altered-archive, outside-worktree configuration and SIGTERM
cleanup checks passed. Documentation checks passed all 53 tests and the site
build; desktop/phone rendering and the diagnostics link passed. The refreshed
browser check recorded no console errors or warnings on the correct `/sporades/` routes (an
initial navigation omitted that base and returned 404). Owned browser/server
processes were stopped. Logs and screenshots remain under ignored
`logs/issue-131/` and `logs/issue-131-round-2/`; the JSON record contains public
hashes and outcomes.

## Remaining authorized operator work

This desk prohibits real Host commands, SSH and cloud operations. The manager
must execute all rows against the **same pinned candidate** on disposable
infrastructure. Preserve failed attempts separately; prerequisite closures,
fixture receipt and historical QA do not establish these release passes.

| Gate | Required evidence |
| --- | --- |
| Modes/topologies | Installed CLI, actual generated Capsule and monitoring Compose in Dev/Container/Hosted, same-VM and real separate-VM; no app `node_modules`; exact versions/digests, VM roles, TLS topology, UTC exits and unsupported combinations. |
| Signals/logs | Independently query fresh stored HTTP/database/fetch/auth/file/WebSocket/Job traces and request/runtime/Host/Caddy metrics; locate success/failure logs by exact trace ID; supported SQLite/PostgreSQL coverage and explicit unsupported PSI. |
| Coverage/inventory | Default existing/new Hosted coverage, opt-out, local opt-in; register/deploy/start/restart/rollback/stop/delete/address changes without manual import; acknowledged current inventory and stale/pending state. |
| Transport/readiness/alerts | Verified TLS, ingestion/inventory/query authority separation, revoked/wrong/cross-Host denial, minimal readiness failure/recovery, probes during blocked app, actual firing delivery within two minutes and resolved notification. |
| Privacy/concurrency | Seed headers/bodies/queries/exceptions/env/SQL/incoming metadata; inspect stored signals, logs, browser artifacts, descriptors and diagnostics; overlap contexts and prove deny/revocation boundaries. |
| Quotas/recovery | Units/denominators/reset-safe rates, bounded CPU/heap/Buffer/I/O, pipeline saturation/outage, credential migration/rollback and interrupted lifecycle/workstation-off recovery; preserved business responses/Jobs/data/history, bounded memory/disk and fresh stored recovery. |
| Overhead/capacity | Identical off/on load: p95 regression <=5%, throughput loss <=5%, measured fixed/load-dependent memory budget and no sustained growth; active series, samples/s, request rate, volume usage, peak RSS, retention projection/headroom. Resolve failures before rollout. |
| Final parity | Green build/typecheck/full suite, generated freshness and installed-package parity on final artifacts. Record skips as pending/unsupported, never passes. |

For overhead, predeclare app/data fixture, request mix, concurrency/offered load,
sampling/collection settings, warmup and measurement durations. Use paired
alternating off/on trials with equivalent warm caches. Retain raw latency,
errors, completed requests and variability; compare successful p95 and achieved
throughput at equal offered load. Measure idle and increasing-load memory and
sustained fixed-load growth after warmup. Publish repeats and a time series, not
a single RSS snapshot; this record relaxes no threshold.

The #128 report also found a pre-existing Caddy route permission defect under
`UMask=0077`, temporarily repaired on its disposable Host without a product fix.
Check route readability after boot/publication as release preflight. A failure
blocks acceptance; track its repair independently rather than silently correcting
permissions in the final run or treating telemetry migration as its fix.

Use [diagnostics](../reference/telemetry-diagnostics.md),
[maintenance](../reference/monitoring-maintenance.md),
[performance policy](../reference/monitoring-performance.md) and
[Host provisioning](../agents/host-provisioning.md). Protect credentials/raw seeded
output; publish redacted hashes, commands, attempts and stored observations.
Complete #131 only after every gate passes; #132 remains separate.

## Historical draft results

PR #225's author suite failed with 2 failures and its QA suite with 4 failures
(both 3,192 tests). Isolated retries passed without replacing failed full runs.
QA also reported package parity and a To Do smoke on its earlier head. Those
results remain in the closed PR and are not credited as fresh release evidence.
