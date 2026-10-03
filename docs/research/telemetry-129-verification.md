# Telemetry 22 outage recovery verification

Issue #129; local disposable evidence captured 2026-10-03. Both native blockers
#112 and #118 were closed before implementation. This adds visibility and
adversarial recovery evidence while preserving finite runtime/export budgets.

## Observed behavior

- The SDK saturation test completes 1,024 business operations while trace
  exports stall beyond 600 ms. It observes queue capacity 128, actual occupancy,
  at least 864 queue-full drops, bounded failure diagnostics and automatic
  recovery. Five create/shutdown cycles leave no periodic network exporters.
- The gateway permits 32 stalled ingests, rejects the next immediately, counts
  failures/admission rejections through an independent private scrape and
  accepts traffic again after the downstream recovers. `/health` is unchanged.
- The real generated Capsule continues HTTP requests and durable Job settlement
  through disconnected backends, Collector crash/restart, queue overflow,
  expiry, stopped/paused gateway, slow relay exports and exhausted queue quota.
  It exits with the existing successful SIGTERM status in **40 ms** when relay
  and gateway are stopped. Earlier shutdown-rejection parity tests still prove
  Dev and Bundle error exit semantics and healthy multi-batch flush.
- An accepted trace survives SIGKILL of the persistent Collector and is read
  from Jaeger after restart. Overflow and finite retry expiry increment native
  failure/drop signals. Fresh stored source metrics and zero measured queue
  occupancy prove recovery after reconnection.
- A newer sample followed by a sample 20 seconds older is retained with the
  provisioned finite 10-minute Prometheus out-of-order window. The same test
  failed against the earlier zero-window configuration. This does not promise
  acceptance of arbitrarily old backlog or conflicting duplicate samples.
- Filling the quota produces actual **ENOSPC** during file-storage startup
  compaction. Private Collector diagnostics are recorded as unavailable/null,
  while Capsule work still completes. Removing the filler and restarting the
  Collector restores fresh readable telemetry. No storage failure is converted
  to a healthy measured zero.
- The inventory Docker fixture separately proves protected desired state and
  central acknowledgements survive outage/Host/gateway restart, registry
  rollback, opt-out, deletion, stale/conflicting replay and cross-Host denial.
  Native reconnect tests prevent stale generations replacing current state.

## Resource envelope

The [machine-readable report](./telemetry-129-outage-evidence.json) records exact
image IDs, budgets, phases, RSS and disk samples. Docker Desktop Engine 29.8.0
ran Linux arm64 Collector 0.138.0, Jaeger 2.21.0, Prometheus 3.13.3, Grafana
13.2.2 and the shipped Node 24.13.0 gateway. The generated Capsule used local
Node 24.19.0. The drill accelerates each queue to 64 KiB and each consumer's
retry budget to 10 seconds; production defaults remain 16 MiB and 30/300 seconds.

| Measured component | Idle/fixed baseline | Loaded/outage observations | Hard fixture budget |
| --- | --- | --- | --- |
| Collector RSS | 171.9 MiB | 171.6–180.5 MiB across sampled phases; 171.3 MiB after disk recovery | 256 MiB Docker memory |
| Gateway RSS | 69.8 MiB | 68.7–73.5 MiB across sampled phases | 192 MiB Docker memory |
| Generated SDK Capsule RSS | 107.0 MiB at startup | 61.3–71.9 MiB in sampled outage phases after GC | SDK queue 128 spans; Capsule policy unchanged |
| Slow relay RSS/queue | Self-observation measured during paused gateway | 187.1 MiB RSS; aggregate queue 64,696 bytes; 11 failed spans | 192 MiB Docker memory; 64 KiB per signal in fixture |
| Persistent queue disk | 40 KiB | 188 KiB after drains; exactly 128 MiB with filler | 128 MiB tmpfs filesystem quota |

These are sampled workload-specific RSS observations, not per-request allocation
measurements, a sustained-growth proof or an enabled/disabled overhead benchmark.
Serialized queue bounds do not equal RSS or bbolt file size. The fixture's
anchored tmpfs survives process/container restart but is **not reboot durable**.
Production persistence is opt-in and requires an operator-provisioned durable
quota filesystem separate from Capsule and inventory data. Separate-VM power
loss, real filesystem project-quota behavior and long canary/soak runs were not
performed in this worktree; these remain operator drills in the [outage runbook](https://github.com/mgscox/sporades/blob/main/monitoring/trace/OUTAGES.md).

## Provisioning and browser

Packed CLI parity verifies all new assets ship, stack schema 3, preserved operator
overrides and regenerated CLI/source parity. Private Collector/gateway scrapes,
relay self-observation, warning rules, optional queue override and the pipeline
dashboard share the existing stack provisioning path.

Playwright opened the disposable stack on reserved port 5688, inspected all 13
panels, scrolled through stored queue/failure/freshness/memory data, clicked
Refresh and captured [top panels](./telemetry-129-pipeline-top.png) and
[backend pressure panels](./telemetry-129-pipeline-pressure.png). Absent SDK
drop data rendered `No data`. Grafana's existing anonymous `/api/user/stars`
and Live WebSocket routes produced authentication errors; the dashboard's
Prometheus queries and refresh rendered correctly. The browser and every
fixture container, network, queue volume and built gateway image were stopped
or removed after verification. Real Monitoring/Host profiles and endpoints
were never used.

## Commands

All commands inherited `SPORADES_CONFIG_DIR=$PWD/.sporades/issue-129-config`.

```sh
npm run build
npm run typecheck
npm test
npm run docs:check
npm run monitoring:release-asset -- .sporades/issue-129-monitoring.tar.gz
node --test test/telemetry-outage.test.js test/telemetry-flush.test.js \
  test/monitoring-pipeline.test.js test/host-telemetry-relay.test.js \
  test/monitoring-stack-cli.test.js test/lifecycle-inventory.test.js \
  test/host-inventory-reconnect.test.js
SPORADES_REAL_TELEMETRY_OUTAGE=1 node --test test/telemetry-outage.acceptance.test.js
SPORADES_REAL_TELEMETRY_CA_CONTAINER=1 node --test test/telemetry-container-ca.acceptance.test.js
node scripts/verify-host-inventory.mjs
```

Focused tests: **19 passed, no skips**. Outage Docker: **1 passed, no skips**.
Private-CA Container: **1 passed**, legacy pre-descriptor CLI case skipped because
no legacy CLI was supplied. Inventory Docker passed its emitted contract report.
Build, typecheck, generated CLI parity, docs checks and local release-asset
generation passed. Pinned Prometheus `promtool check rules` validated all five
provisioned alert rules in a disposable container with networking disabled.

## QA freshness correction (2026-10-03)

QA reproduced a disconnected source disappearing before the 15-minute warning:
Prometheus's instant selector only retained it for five minutes. The warning now
uses `max_over_time(sporades_telemetry_collection_time_seconds[24h])`. This bounded
history keeps previously observed sources available for warning evaluation;
new collection clears the warning even when an older batch is subsequently
replayed. Never-observed sources and sources outside the history remain unknown.
The 24-hour window is an explicit finite observation limit, not retained expected
inventory or an indefinite absence alert.

The committed promtool fixtures prove fresh collection, the exact 15-minute
threshold, stopped collection at minute 21 both with and without a stale marker,
recovery, replay, never-observed sources and expiration of the historical window.
The original rule failed the minute-21 fixture before the correction. The pinned
provisioned Prometheus version then passed syntax and all fixture evaluations.
The packed CLI test also verifies the read-only rule mount and Prometheus's rule
file configuration, alongside the existing byte-for-byte shipped asset checks.

Validation used a worktree-local `SPORADES_CONFIG_DIR`, `COPYFILE_DISABLE=1`, and
a short private `TMPDIR` owned by the invoking user with gid 20 and mode 0700:

```sh
SPORADES_REAL_PROMTOOL=1 npm test
npm run typecheck
npm run docs:check
SPORADES_REAL_PROMTOOL=1 node --test --test-concurrency=1 \
  test/monitoring-pipeline-rules.test.js test/monitoring-pipeline.test.js \
  test/monitoring-stack-cli.test.js
node --test --test-concurrency=1 test/telemetry-outage.test.js \
  test/telemetry-flush.test.js test/telemetry-shutdown-failure.test.js \
  test/host-telemetry-relay.test.js test/lifecycle-inventory.test.js \
  test/host-inventory-reconnect.test.js
npm run monitoring:release-asset -- <worktree-local-output.tar.gz>
```

The first follow-up full suite, before integrating newer `main`, included its
build/generated parity pretest and the real promtool runner. It finished with
**2,730 passed, 1 failed, 208 skipped, 0 cancelled**
(2,939 tests; 2,424,418 ms). This is **not a clean full-suite pass**.
The focused monitoring/recovery groups passed **21 tests without skips**;
typecheck, documentation checks (**53 passed**), packed provisioning/parity and
release-asset byte comparisons passed. Regenerated CLI/runtime artifacts are
unchanged because this correction modifies independently shipped monitoring
assets, not an API/type or embedded runtime. Playwright checked the rendered
configuration reference on local port 5203, captured its freshness paragraph,
and the preview was stopped.

| Case | Full run and separate disposition |
| --- | --- |
| Two deployment ownership assertions | Both passed in the full run and their focused group with the private gid-20 temporary directory. QA's previous baseline ownership failures remain separate evidence. |
| Live route owner and read-only inspection timing | Both passed in this full run and the focused group. No timing/security assertion was relaxed. |
| Both trust-revalidation marker waits | Both passed in the first full run. A concurrent focused head group passed apply/rollback and failed remove/restore waiting for its marker; the `main` snapshot at `3e59f8862d2a8f39c9afd10523ea94ab0c81193c` failed both marker waits in its focused group under the same environment. These focused results are not substituted for a full run. |
| ClamAV bounded PING/managed-child cleanup | The first full run failed with `ClamAV child did not terminate after SIGKILL`; the focused head case passed, while the same focused case on that `main` snapshot failed with the same cleanup error. Its test and runtime source match `main`. This is baseline-reproduced, not a confirmed freshness correction regression; the first full run remains failed. |

### Integrated branch verification

The final PR check found a generated-manifest conflict with newer `main`.
Merged `main` at `d243884f2b2d345e052110ab868e482e3e8bfc8f` and regenerated
the shipped artifacts with `npm run build`; source and type merges were automatic.
The integrated branch (`056e6a94`) then completed a second full `npm test` in the
same isolated environment: **2,741 passed, 0 failed, 209 skipped, 0 cancelled**
(2,950 tests; 1,256,681 ms). All six QA-reported cases and the ClamAV cleanup case
passed in this full run. This is a clean full-suite pass, distinct from the
earlier failed run and its focused/baseline comparisons. The additional cases
and optional acceptance skip come from the integrated `main` changes.

The combined exact-path HTTP admission, promtool freshness and packed stack
group also passed **12 tests without skips** after integration. Final typecheck,
documentation checks and generated-source parity passed. The correction adds no
new API/type contract; regenerated artifacts also preserve the newer runtime
contracts from `main`.

Earlier Docker recovery, persistent queue and browser/dashboard acceptance is
retained as prior evidence; these unchanged drills were not repeated for
the alert-only correction. No separate-VM or real Host acceptance is inferred.

## Earlier full-suite limitations

The first complete `COPYFILE_DISABLE=1 npm test` run reported **2,727 passed,
3 failed, 208 skipped** (2,938 tests; 1,462,267 ms). Its failures were the Google
guestbook WebSocket wait and the two Host trust-revalidation marker waits. All
three passed together in an isolated recheck. Those test fixtures are unchanged
by this branch.

The second complete run reported **2,724 passed, 6 failed, 208 skipped** (2,938
tests; 2,736,840 ms), with no cancelled tests. The first run's three failed
fixtures passed in this run. The new outage tests and existing telemetry
shutdown/flush/profile/privacy/Job/WebSocket tests passed in both full runs.

| Second-run failure | Isolated recheck |
| --- | --- |
| Dev ClamAV exact newline-framed readiness (`dev-clamav-sidecar.test.js:145`) | Passed |
| PDF operator-list timeout (`file-ingress.test.js:2902`) | Failed alone; passed in the nine-test PDF group after parser initialization |
| Host malformed runtime bounds (`host.test.js:7007`) | Failed again: readiness timeout instead of expected invalid-response error |
| Host stale health repair versus removal (`host.test.js:7441`) | Passed |
| Host descriptor-fenced runtime-data preparation (`host.test.js:10363`) | Passed after the full run |
| Delayed Jobs/retry exhaustion (`job-retry-cancel.test.js:20`) | Passed after the full run |

The PDF fixture's 10 ms deadline expired before its hook was reached in the
single-test recheck. No timeout, security constraint or unrelated fixture was
changed. A pristine-baseline full run was not performed; the cause of the
changing failures is not conclusively established. An isolated recheck does
not turn a failing full suite into a pass. A clean full run and resolution or
QA disposition of these failures remain required before this draft is ready
for merge. Local logs are under `.sporades/issue-129-*.log` in this worktree.

## Poirot round-three restart and committed-drill correction

Read the full [round-three QA report](https://github.com/mgscox/sporades/pull/207#issuecomment-5971462652). Both native blockers #112/#118 remain closed.
The reported full run (2,740 passed, one failed, 209 skipped) remains a failed
historical run; its unchanged Dev rollback case passed isolated and is classified
under #208. It is not substituted for the completed runs below.

The committed new promtool restart fixture reproduced the precise defect before
the fix: at minute 21, `old-process` alerted despite continuous fresh collection
from its replacement. `restart-red.log` retains that failure. Freshness now takes
the maximum across process-lifetime `instance`/`service_instance_id` labels while
preserving every remaining target label. The 24-hour history, strict 15-minute
threshold, replay and unknown/absent-source semantics remain. Pinned Prometheus
passes healthy replacement, repeated restarts, older replay, independently stale
replicas, distinct Capsule/environment targets and all earlier fixtures.

The unchanged Docker drill also reproduced its slow-relay failure locally. A
first bounded polling attempt exposed oversized trace batches: 256-span batches
could exceed the drill's accelerated 64 KiB queue and be rejected before export.
The committed drill caps relay batches at 16 spans, asserts receipt of the fault
traffic, and polls for a **new** send-failure counter increment within a finite
45-second observation budget. Each uniquely named diagnostics probe has its own
HTTP/process deadline and cleanup; a prior outage failure cannot satisfy the
new observation. Production batching, queues and retry limits are unchanged.

Two follow-up runs reached the intended failed export but failed the old RSS-only
budget assertion (about 203 MB RSS). RSS includes shared/mapped executable pages;
it is retained as a diagnostic. The unchanged 192 MiB Docker budget is now
verified using the relay's [cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) current and whole-run peak charge, configured
limit and zero OOM events. A bounded fixture-only probe joins only this relay's
private PID namespace; SYS_PTRACE permits the cross-UID cgroup read, without a
host PID namespace or host filesystem mount. Missing evidence fails the test.
One intermediate probe-permission failure and all preceding failures are retained
as failures, not passes.

The final committed Docker drill passed before and after the main integration.
On integrated source it completed every fault phase in 67.5 seconds: a new
16-span failure was observed in 8.5 seconds; relay charged memory peaked at
70,352,896 bytes under the unchanged 201,326,592-byte limit, with zero OOM events.
RSS was separately recorded as 207,069,184 bytes. Collector restart/persistence,
saturation, expiry, full-disk recovery and continued Capsule Jobs passed.
Capsule SIGTERM completed with exit zero in 17 ms. Resource evidence is
`.sporades/outage-drills/run-XPfGLV/resource-report.json`; the integrated Docker
log SHA-256 is `cc5bbd8ea049ed3caff21aac2a2118b3a91b00fa75ed7f939b054ab7eee6a763`.
Task-owned containers, volumes and diagnostics probes were removed.

Merged main at `b274551d`, preserving pipeline shutdown idempotence and main's
fetch instrumentation, and regenerated conflicting artifacts. While the first
complete suite ran, main advanced to `789b4862` (sender credentials). Merge
`d917f629` retains both sender and pipeline/recovery provisioning assets and
parity assertions. Generated CLI/runtime artifacts were rebuilt from combined
source; release archive bytes match sender credentials, rules, dashboard,
persistent Collector configuration, queue overlay and outage runbook.

All commands used worktree-local `SPORADES_CONFIG_DIR`; the complete suites used
`COPYFILE_DISABLE=1` with a short private gid-20/mode-0700 TMPDIR. Build, typecheck,
generated parity, documentation (53 tests and VitePress), 48 integrated focused
credential/pipeline/recovery/inventory tests, real pinned promtool and the
committed Docker drill passed. Rendered freshness docs passed desktop/390px
checks with no overflow; the sole console error was the existing favicon 404.
Screenshots and all logs are retained in `.sporades/pr207-r3-evidence/`. The
task-owned browser and documentation server were closed.

The first full suite on `ac11d974` exited zero: 2,973 tests, **2,760 passed,
213 skipped, zero failures/cancellations**, in 1,265.2 seconds. After the late
main integration, the final `SPORADES_REAL_PROMTOOL=1 npm test` on `d917f629`
exited zero: 2,989 tests, **2,776 passed, 213 skipped, zero failures and zero
cancellations**, in 1,248.0 seconds. Both build/generated prechecks passed.
The known Dev rollback case passed in both complete runs. No exclusions or
isolated retries establish these gates. `integrated-full-suite.log` SHA-256 is
`f989b80aa2228a086c558bbc57c805defc72a5343a99d2705208c19722b1a481`.

Assumptions: a logical target consists of all labels other than the two process
identifiers; independently monitored replicas need distinct existing stable
labels or service names (Hosted uses domain/subname). No new Capsule API, profile
setting or invented Host identity is introduced. The Linux Docker drill requires
cgroup v2; its memory measurement is container charge, with RSS still reported.
Separate-VM power loss, real durable filesystem quotas and long canary acceptance
remain operator follow-ups. Main stayed at `789b4862` at final verification.
