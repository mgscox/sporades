# Telemetry #121 isolated verification

Branch: `swarm/issue-121-barbara`, based on `803ca606`. Native blockers #119 and
#120 were closed when checked. Parent #107 explicitly supersedes copied external
container-quota/memory-limit/OOM/restart-loop criteria with Host capacity and
pressure. This change follows that approved revision and uses the existing
Prometheus/Alertmanager owner and channel. No real Host, monitoring endpoint,
profile, production Capsule or operator notification channel was used.

## Behavioral evidence

Test-first Node fixtures verified invalid policy rejection before replacement,
operator `.env` preservation, exact route budgets, independent-histogram sample
guards, expected Job exemptions, shipped/public parity, backend stat failure,
and inventory lifecycle timestamp exports. Pinned Prometheus **3.13.3** promtool
verified CPU contention (including busy-without-contention suppression), RAM,
swap, I/O, writable Host bytes/inodes, backend disk low/unknown, API errors and
latency, explicit stream-route exclusions, a higher operator route budget,
intentional lifecycle suppression, Capsule-wide 5xx aggregation across routes,
and firing/resolved boundaries. Annotation queries preserve inventory timestamps and cease producing idle markers after
the two-minute observation window.

A generated Capsule Bundle ran with real Prometheus **3.13.3** and Alertmanager
**0.34.1** in disposable native processes on loopback. The actual starting API
rule (5xx >5%, trailing five minutes, at least 100 requests) fired after controlled
503 traffic; 4,000 successful responses drove the rolling ratio under threshold.
Alertmanager delivered both real webhook states with Capsule and fleet dashboard
links. The final run delivered firing at `2026-10-04T17:27:03.542Z` and resolved at
`2026-10-04T17:27:18.543Z`. See [payload evidence](telemetry-121/delivery-evidence.json).
The native tools' incidental machine hostname is redacted to loopback in public
payload URLs; alert labels, conditions and timestamps are unchanged.
The drill did not inject Alertmanager alerts or rewrite rule windows. Trace
payloads were deliberately discarded, demonstrating independence from trace
sampling/storage. All drill processes were stopped.

Native Grafana **13.2.2** ran on reserved port **5688**, using worktree-local data
and provisioning with the isolated Prometheus history. Playwright verified Fleet
inventory Capsule links (percent-encoded service identity), API-to-Resources
navigation retaining Capsule/time selection, rendered independent-histogram API
and process graphs, and the Fleet layout at 390×844. Annotation queries returned
successful Prometheus data. The only browser error while services were running
was Grafana's anonymous `/api/user/stars` 401. All three UI fixture processes were
stopped; later failed refreshes after shutdown are cleanup effects.

- [Fleet desktop](telemetry-121/fleet-desktop.png)
- [Fleet phone](telemetry-121/fleet-mobile.png)
- [API desktop](telemetry-121/api-desktop.png)
- [Resources desktop](telemetry-121/resources-desktop.png)

## Commands and boundaries

All CLI/tests inherited a worktree-local `SPORADES_CONFIG_DIR`; source changes do
not add per-request allocations or instrumentation. Locally downloaded binaries
were stored only under ignored `.sporades/issue-121/`.

```sh
export SPORADES_CONFIG_DIR="$PWD/.sporades/issue-121/config"
npm run build
npm run typecheck
SPORADES_PROMTOOL_BIN="$PWD/.sporades/issue-121/prometheus-3.13.3.darwin-arm64/promtool" node --test test/telemetry-performance*.test.js test/telemetry-availability.test.js test/monitoring-trace-stack.test.js test/monitoring-stack-cli.test.js test/lifecycle-inventory.test.js test/monitoring-smoke-origin.test.js
npm run docs:check
SPORADES_PROMETHEUS_BIN="$PWD/.sporades/issue-121/prometheus-3.13.3.darwin-arm64/prometheus" SPORADES_ALERTMANAGER_BIN="$PWD/.sporades/issue-121/alertmanager-0.34.1.darwin-arm64/alertmanager" node scripts/verify-performance.mjs
COPYFILE_DISABLE=1 SPORADES_PROMTOOL_BIN="$PWD/.sporades/issue-121/prometheus-3.13.3.darwin-arm64/promtool" npm test
```

Build, typecheck, docs tests/build and all 40 focused checks passed. The final
full `npm test` completed with exit 0: 3,173 tests, 2,950 passes, zero failures,
223 configured optional skips (1,515,681 ms). The earlier full run exposed five
standalone-fixture import failures, fixed by copying the new transitive policy
module, and one unchanged Dev JSON-migration WebSocket timeout. That Dev test
passed alone and again in this fresh full run. Docker `desktop-linux` daemon probes
with a five-second timeout returned `ETIMEDOUT` twice. Therefore the existing
Docker availability acceptance was unavailable; it was extended to check the new
provisioned performance rules when it can run. Native delivery and promtool
results do not certify Docker topology, read-only backend mounts on Linux, a
real Host/Monitoring VM, or the real operator-selected notification channel.
Those acceptance boundaries remain explicit for QA/operator validation.
