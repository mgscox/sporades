# QA regression lanes

The local PR regression gate is `npm run test:qa`, followed by focused tests for
changed behavior. Run `npm run typecheck` too. A missing optional integration is
reported as a skip, not as evidence that that integration passed. Keep the final
`QA_SUMMARY` line in the QA report, including its skipped lanes. A failing or
unfinished local regression gate is not a passing gate.

## Desk setup and commands

Use Node 24 LTS (the runner is also tested on the package's Node 22.13 minimum).
Install the lockfile dependencies before testing. Keep the registry reachable
while installing; do not put the entire suite in an offline custom runner.

```sh
export SPORADES_CONFIG_DIR="$PWD/.qa-config"
export TMPDIR="$CUBEFARM_JOB_SCRATCH"
npm ci
npm run build
# Packed Capsule smoke tests install offline from the npm cache. Seed it once
# when this desk has a cold cache; it includes scaffold-only dependencies.
node scripts/prepare-offline-test-cache.mjs
# Confirm that the actual runner environment permits a dependency install.
node --test --test-name-pattern='^a packed credential-free blank Capsule installs' test/dev-part-3.test.js
npm run typecheck
npm run test:qa -- --report="$CUBEFARM_JOB_SCRATCH/qa-times.json"
```

The QA command builds and verifies generated CLI parity inside its overall
**two-hour safety deadline**. QA starts **up to four file harnesses**, bounded by available CPUs, each using
`node --test --test-concurrency=1`. The custom progress reporter is passed to
`node --test` as a `file://` URL, not a bare path, so the same gate runs on
Windows desks too: Node's ESM loader rejects a `C:\...` reporter path with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`. Positional test file arguments remain plain
paths on every platform. The pool sets the file concurrency;
compiler-heavy
files run in a separate memory lane, **two at a time** by default
(`SPORADES_TEST_HEAVY_CONCURRENCY=1` restores one-at-a-time). `GOMAXPROCS`,
`UV_THREADPOOL_SIZE` and `RAYON_NUM_THREADS` are clamped to at most two in QA (or the smaller worker cap).
This limits esbuild's Go pool, Tailwind/Lightning CSS's Rayon pool and native
asynchronous work inherited by child
Capsules and Vite builds. Tests retain their explicit concurrency assertions.
QA never selects real Docker containers or Postgres services; loopback libSQL
emulators remain isolated within their file harness. Explicit real-service lanes
in `npm test` still run serially. CI's default file concurrency remains unchanged.

The desk budget assumes about 8 GiB is available for one session. QA watches a
**6,144 MiB process-tree RSS ceiling** and a **1,536 MiB available-memory floor**,
leaving margin above the required 1 GiB. On Linux it samples `/proc` every 100 ms,
including observed detached descendants, and uses `MemAvailable` plus readable
cgroup v2 limits and OOM counters. RSS sums conservatively include shared pages;
these are sampled watchdog limits, not kernel reservations. A burst can overshoot
between samples, so retain the margin and do not launch multiple gates per desk.
Other desks can consume the remaining memory; the runner stops its own work when
the floor is crossed and never stops another desk's processes.

Separate harnesses prevent Node 22’s ordered reporting from hiding completed
sibling-file results behind an earlier hang. The Dev suite keeps all 215 original registration blocks and 68 helper
declarations across `dev.test.js`, `dev-part-2.test.js` through
`dev-part-6.test.js`, and `support/dev-fixture.js`. The split gives separate processes independent temporary Capsules.
Host retains 277 registration blocks across four files and Deploy retains 85
across two (duplicate and tautological blocks were removed in the 2026-11 test
review); their shared helpers and Host before/after hooks run in
each isolated process. The explicit real-Host entry points remain in
`host.test.js`. The shared Dev fixture recognizes already-closed sockets and arms schema-rebuild
observers before writes. It buffers WebSocket frames so sequential reads retain mutation
results and query updates delivered in the same event-loop turn. Compiler/CLI
startup waits allow 60 seconds for cold compilers; WebSocket budgets remain unchanged. Host
readiness compatibility cases allow five seconds for their process-based
emulator. Malformed-response classification advances a controlled monotonic
clock after one actual emulator reply, so a final short probe cannot replace
that result with a startup timeout. Host process observations allow 15 seconds;
dedicated timeout cases retain their short budgets.

The measured profile placed every file at or above **512 MiB** in the memory
lane, alongside the existing full Capsule/compiler and parser fixtures. That
selects 44 files in this tree. Two of them run at a time, measured rather than
assumed: the six largest (`deploy`, `dev-part-2`, `host-part-2`, `dev`,
`monitoring-release-verifier`, `file-ingress`) peak at **3,314 MiB together**
and finish in 233 s against 930 s one-at-a-time, with the RSS watchdog and the
available-memory floor still armed. Width two leaves about 2.8 GiB of the
6,144 MiB ceiling free, so the watchdog rather than a fixed lane width is what
bounds this lane: do not raise the width on a desk with a smaller budget, and
`SPORADES_TEST_HEAVY_CONCURRENCY=1` restores strict isolation. The per-file
table and CSV below record the original calibration. The worker cap stays four
even on this 18-CPU desk.

Seven files run serially because concurrent compiler/watch activity exposes
fixture timing races: `dev-watch.test.js`, `container-services-dev.test.js`,
`oauth-provider-deadline.test.js`, `facebook-oauth.test.js`,
`host-locks.test.js`, `telemetry-websocket-bundle.test.js` and
`file-ingress-deadline.test.js`. The ingress test's 500 ms rejection deadline
moves unchanged into its own file; its multipart helpers are shared with the
parallel ingress cases. Strict transport deadline assertions remain active.

Shared Bundle readiness helpers permit 30 seconds under parallel compiler startup
contention; HTTP/status and behavior assertions are unchanged. Dev installs signal
handlers before announcing `started`, so an immediate SIGHUP cleans up its owned
action bundle and session; a deterministic regression test covers that boundary.
PDF loader probes use private runtime copies, keeping `dist/` immutable while
parallel tests pack the package. The collection privacy fixture drains its bounded
observability queue before sending the next asserted burst; capacity tests remain
separate. The shared-service lane runs
with native concurrency 1: files using a selected PostgreSQL database (some reset
common tables), and explicitly selected real-service acceptance files (which may
share image names, ports or external state). It runs after the independent lane.
No real-service lane is selected by QA, even if acceptance flags or provider
credentials were inherited from the workstation.

`npm test` retains its existing build/parity pretest and runs the same scheduler.
It honors existing acceptance flags and configured PostgreSQL databases. Real SSH smoke tests additionally require `SPORADES_REAL_HOST=1` before
reading either environment or checkout `.env` selections; QA rejects them even
with that flag. Existing
automatic local restic tests still run when restic is installed. Its runner has a
60-minute safety deadline for deliberately enabled service matrices. A targeted
run can use `node scripts/run-tests.mjs --no-build test/example.test.js`; build
first. The environment variable `SPORADES_TEST_MAX_WORKERS` provides a hard ceiling for
`--concurrency=N`, including inherited nested gate invocations. An inherited larger
ceiling does not raise QA's four-file default, and children receive the effective
file limit. It also works for
`npm test` on desks without changing CI's defaults. Use
`SPORADES_TEST_MEMORY_LIMIT_MB` and `SPORADES_TEST_FREE_MEMORY_FLOOR_MB` to select
another documented desk budget. `--memory-limit-mb=N` and
`--free-memory-floor-mb=N` are equivalent diagnostic overrides. Keep QA's default
limits for the PR gate; use `--timeout-ms=N` only for watchdog fixtures or a
recorded diagnostic run. `--report=PATH` records every file's sampled peak tree
RSS, wall time, lane and cleaned surviving PIDs, plus per-lane peaks and duration.
With a report selected, `QA_FILE` lines retain per-file measurements as they
finish even if the overall run is interrupted.

Both runners preserve test diagnostics and stdout/stderr, print per-file results, and emit a final machine-readable line (`npm test` retains its separate pretest build; `test:qa` also summarizes build failure):

```text
QA_SUMMARY {"pass":123,"fail":0,"skip":12,"todo":0,"unfinishedFiles":0,"timedOut":false,"interrupted":false,"durationSeconds":42,"skippedLanes":["..."]}
```

Allow the command its full safety deadline; do not wrap this gate in a
600-second or 15-minute tool timeout. #345 corrects the earlier diagnosis:
raising concurrency to satisfy a time budget exhausted the VM's memory.
Memory headroom takes precedence over the earlier 15-minute target.

Counts are tests, including Node's parent tests, rather than files. Cancelled
tests without memory-pressure evidence count as failures; build, runner, timeout
and interruption failures also make the command fail. Missing Python skips each affected file as one file-level
skip, with its name and reason. An interrupted file retains completed-test
counts and is listed in `unfinishedFiles`. On timeout or SIGINT/SIGTERM the
watchdog kills its own test/build process groups, prints totals, and exits
nonzero. The regression test checks that a hung fixture's child cannot survive.

### Resource exhaustion and exit codes

Exit **0** means the selected regression gate passed; **1** means a test,
build, timeout, interruption or runner error. Exit **75** means
`failureKind: environment`: the RSS ceiling or free-memory floor was crossed,
a cgroup OOM kill was observed, or a child reported SIGKILL, ENOMEM, a worker-thread
heap limit (`ERR_WORKER_OUT_OF_MEMORY`) or V8 heap exhaustion. SIGKILL alone cannot prove an OOM kill, so the reason records that
signal as environment evidence rather than blaming a test assertion.

Before killing owned work, the runner prints `RESOURCE PRESSURE` with the active
filenames (or build/probe command), reason, peak RSS, available memory and swap.
It retains `QA_SUMMARY`, then prints a final **`RESOURCE EXHAUSTION`** JSON line
with `failureKind`, `cancelled`, `runningAtExhaustion`, peak/free memory and swap.
The summary records initial, minimum and final free memory. Pending registered
tests in interrupted files count as cancelled; an interrupted file with no test
registrations counts as one cancelled file. Queued files remain unfinished and
do not inflate the cancelled test count. Resource cancellation is excluded from
`fail` and `timedOut`; assertions completed before pressure retain their evidence.
QA must record this check as `failureKind: environment`, retain the resource
line and active file list, and rerun when the desk has headroom. It is not a pass.

A deliberately low-cap diagnostic is safe and quick:

```sh
npm run test:qa -- --no-build --memory-limit-mb=1 test/qa-runner.test.js
# Exit 75, RESOURCE EXHAUSTION; no test assertions run.
```

The runner's focused tests additionally allocate bounded memory in a disposable
child, exhaust an 8 MiB worker-thread heap, simulate SIGKILL and ENOMEM, cross an
impossible free-memory floor, and
prove that ordinary assertion/cancellation failures keep exit 1. Cleanup tracks
PID birth times and removes observed detached survivors between files, recording
`CLEANUP` and `cleanedProcesses` for leak investigation. Open servers or DB handles
that prevent a file exiting remain subject to the overall watchdog.

Docker readiness probes have a five-second bound; selected PostgreSQL endpoints
have a three-second connection bound. Unavailable selections are removed with a
named skip reason. Local restic detection has a five-second bound. QA requires
no Docker daemon, PostgreSQL server, provider credentials or browser download.
Loopback sockets, subprocess execution, SQLite and the installed build toolchain
remain required. See [native and offline install prerequisites](runtime-flake-testing.md#native-capabilities-and-offline-package-installs).

## Which GitHub checks cover regression?

Inspected on 2026-11-07, including the exact heads of PRs
[#336](https://github.com/mgscox/sporades/pull/336),
[#338](https://github.com/mgscox/sporades/pull/338),
[#341](https://github.com/mgscox/sporades/pull/341) and
[#342](https://github.com/mgscox/sporades/pull/342).
**No current PR workflow runs full `npm test`.**

| Workflow / job | What it runs on PRs | Full runtime regression? |
| --- | --- | --- |
| `generated-artifacts.yml` / `check-pr` | Trusted-base generated-file policy checker | No |
| `deploy-docs.yml` / `build` | `npm ci`, `npm run docs:check` on matching paths | No; the job name “build” refers to docs |
| `publish.yml` / `check-release-automation` | `package-script.test.js`, `npm-release.test.js` on matching release paths | No |
| `generated-artifacts.yml` / `regenerate` | Main pushes only: generates `dist/` and `bin/` | No PR test run |
| `publish.yml` / `publish` | Release only: build, cache seed, typecheck, `npm test`, docs | Full suite with the runner's available tools and explicit flags |

For example, [#342's green build](https://github.com/mgscox/sporades/actions/runs/42318764624)
is a documentation run; its [green check-pr](https://github.com/mgscox/sporades/actions/runs/42318764614)
only rejects generated-artifact changes. QA must cite its local `test:qa`
result for PR runtime regression. Do not describe those green CI jobs as a full
regression result. This change does not alter GitHub branch protection or add
execution of PR code to the trusted-base self-hosted checker.

## Optional tools and external integrations

“Network” below means access beyond disposable local loopback emulators. Default
OAuth, SMTP, Stripe, libSQL, S3 and OTel tests use synthetic local providers; their
provider names do not imply live credentials. npm cache seeding needs registry
access, while the default packed-install tests themselves use `--offline`.

All filenames are relative to `test/`. A row can describe an optional subset of a mixed file. This inventory includes imported conformance surfaces, not just literal tool names in entry files.

| Required capability | Files | Selection / missing-tool behavior |
| --- | --- | --- |
| Docker / Compose daemon | `access-key-release-acceptance.test.js`, `admission-lifecycle.acceptance.test.js`, `admission-policy-container.acceptance.test.js`, `base-image.acceptance.test.js`, `clamav-dev.acceptance.test.js`, `clamav-docker.acceptance.test.js`, `host-observability.test.js`, `monitoring-maintenance-guards.acceptance.test.js`, `monitoring-maintenance.acceptance.test.js`, `monitoring-pipeline-rules.test.js`, `real-vite-container.test.js`, `telemetry-container-ca.acceptance.test.js`, `telemetry-fetch-bundle.test.js`, `telemetry-outage.acceptance.test.js`, `telemetry-performance-rules.test.js`, `websocket-admission-container.acceptance.test.js` | Existing `SPORADES_REAL_*`, `SPORADES_MAINTENANCE_DOCKER`, `SPORADES_FETCH_DOCKER` or `SPORADES_ACCESS_KEY_ACCEPTANCE` flags; CA compatibility also accepts `SPORADES_LEGACY_CLI_PATH`. Named opt-in skips by default; runner skips unavailable daemon selections. Images may require registry access. |
| Running monitoring stack | `telemetry-websocket-bundle.test.js` | `SPORADES_WEBSOCKET_STACK_DIRECTORY`; otherwise uses an in-process loopback collector. |
| PostgreSQL server | `acl-postgres-contention.test.js`, `database-adapter-conformance-app-tables.test.js`, `database-adapter-conformance-auth-storage.test.js`, `database-adapter-conformance-coverage.test.js`, `database-adapter-conformance-file-ingress-audit.test.js`, `database-adapter-conformance-file-metadata.test.js`, `database-adapter-conformance-human-identity-termination.test.js`, `database-adapter-conformance-live-queries.test.js`, `database-adapter-conformance-live-query-transport.test.js`, `database-adapter-conformance-password-change-revocation.test.js`, `database-adapter-conformance-team-billing-import.test.js`, `database-adapter-conformance-team-storage.test.js`, `database-adapter-conformance.test.js`, `database-adapter-engine-seam.test.js`, `database-adapter.test.js`, `database-transaction-serialization.test.js`, `email-signup-transition.test.js`, `file-ingress-refusal.test.js`, `human-identity-termination.test.js`, `human-security-transition.test.js`, `job-lease-recovery.test.js`, `job-operator-inspection.test.js`, `job-queue.test.js`, `job-retry-cancel.test.js`, `job-scheduling.test.js`, `job-time-domain.test.js`, `log-index-additive-migration.test.js`, `log-index-sequence.test.js`, `password-change-lifecycle.test.js`, `password-signin-postgres-race.test.js`, `postgres-runtime-column-names.test.js`, `reauthentication-proof.test.js`, `registration-admission.test.js`, `resource-postgres-process.test.js`, `resource-postgres-publication.test.js`, `resource-transactions.test.js`, `server-bundle-module-graph.test.js`, `service-users.test.js`, `stripe-job-retention.test.js`, `stripe-payment-transaction.test.js`, `stripe-webhook.test.js`, `table-insert-or-ignore.test.js`, `team-billing-checkout-concurrency.test.js`, `team-billing-convergence.test.js`, `team-billing-erasure.test.js`, `team-billing-management.test.js`, `team-create-admission.test.js`, `team-destructive-policy.test.js`, `teams-runtime.test.js`, `teams.test.js`, `telemetry-database.test.js`, `trusted-read.test.js` | `SPORADES_POSTGRES_TEST_URL`; telemetry-specific cases use `SPORADES_TELEMETRY_POSTGRES_TEST_URL` or `SPORADES_TELEMETRY_POSTGRES_BUNDLE_URL`. SQLite/libSQL cases still run without it. Resetting helpers enforce the disposable database identity in `test/support/database-adapter-engines.js`. |
| Python 3 + Unix fcntl | `host-backups.test.js`, `host-inventory-reconnect.test.js`, `host-observability-mail.test.js`, `host-observability.test.js`, `host.test.js`, `host-part-2.test.js`, `host-part-3.test.js`, `host-locks.test.js`, `lifecycle-inventory.test.js` | Exec-preserving OS-lock emulator `test/support/exec-flock.py`; the runner skips these files by name if unavailable. No Docker daemon is needed for their default fake-Host cases. |
| restic | `host-backups.test.js` | Three encrypted local-repository acceptance cases auto-detect restic; fake-restic policy/CLI tests remain active. Five-second version probe; absence produces named skips. |
| ClamAV signatures and daemon | `clamav-dev.acceptance.test.js`, `clamav-docker.acceptance.test.js` | Real ClamAV lives inside disposable Docker containers; freshclam requires network signature downloads. `file-ingress.test.js` and `dev-clamav-sidecar.test.js` use synthetic protocols and require no installed ClamAV. |
| Network beyond loopback | `access-key-release-acceptance.test.js`, `admission-lifecycle.acceptance.test.js`, `admission-policy-container.acceptance.test.js`, `base-image.acceptance.test.js`, `clamav-dev.acceptance.test.js`, `clamav-docker.acceptance.test.js`, `facebook-oauth-browser.test.js`, `host-autostart.acceptance.test.js`, `host-metrics.acceptance.test.js`, `host-observability.test.js`, `host.test.js`, `mailjet-smtp-live.test.js`, `monitoring-maintenance-guards.acceptance.test.js`, `monitoring-maintenance.acceptance.test.js`, `monitoring-pipeline-rules.test.js`, `real-vite-container.test.js`, `telemetry-container-ca.acceptance.test.js`, `telemetry-fetch-bundle.test.js`, `telemetry-outage.acceptance.test.js`, `telemetry-performance-rules.test.js`, `telemetry-websocket-bundle.test.js`, `websocket-admission-container.acceptance.test.js` | Real image pulls, signature downloads, registry installs, prepared VM harnesses or explicitly configured live SMTP. QA clears their selections. Docker tests can use preloaded images. The Mailjet test retains its named credentials-required skip; QA removes those credentials. No live provider is required by default. |
| Playwright / Chromium or Chrome binary | `dev-part-2.test.js`, `facebook-oauth-browser.test.js`, `html-document-injection.test.js`, `public-assets.test.js` | `SPORADES_REAL_BROWSER_CHROME`, `SPORADES_REAL_FACEBOOK_BROWSER` or `SPORADES_REAL_CSP_BROWSER`; HTML Docker mode also needs `SPORADES_REAL_HTML_CONTAINER`. Otherwise synthetic browser/runtime tests run. |
| Compose v2 parser (no daemon) | `container-services-compose-cli.test.js`, `container-services-compose.test.js`, `container-services-dev.test.js`, `container-services-lifecycle.test.js`, `deploy.test.js`, `deploy-part-2.test.js` | `SPORADES_COMPOSE_TEST_BINARY`; parser parity is opt-in and default lifecycle coverage uses a fake Docker executable. |
| promtool or Docker | `host-observability.test.js`, `monitoring-pipeline-rules.test.js`, `telemetry-performance-rules.test.js` | `SPORADES_PROMTOOL_BIN` or `SPORADES_REAL_PROMTOOL=1`. Named skips otherwise. |
| Explicit Node GC hook | `telemetry-pressure.test.js` | The allocation-churn case needs `node --expose-gc --test test/telemetry-pressure.test.js`; it otherwise skips with a named reason. Other pressure cases still run. |
| Caddy executable | `host.test.js` | `SPORADES_CADDY_ACCEPTANCE_BIN`; synthetic Hosted route tests remain active without it. |
| Disposable Linux Host VM / SSH harness | `host-autostart.acceptance.test.js`, `host-metrics.acceptance.test.js`, `host.test.js` | `SPORADES_REAL_HOST=1` plus the documented `SPORADES_HOST_SMOKE_*` / `SPORADES_HOST_LOGS_SMOKE_*` selections, or `SPORADES_HOST_AUTOSTART_TEST_ROOT` / `SPORADES_HOST_METRICS_TEST_ROOT` and URL. QA does not read real-Host smoke selections from checkout `.env`. |

The listed opt-in tests keep their existing activation variables. Existing npm
aliases include `test:real-monitoring-maintenance`, `test:real-vite-container`,
`test:real-clamav-container`, `test:real-clamav-dev`, `test:real-host` and
`test:access-key-release`; inspect the associated acceptance harness before
running it. Use a disposable Docker daemon/VM, unique Compose project names,
worktree-local profiles and isolated permitted ports. Real restic repositories
must be disposable; absence is reported by the existing restic skip messages.

A changed real-service boundary still needs its focused acceptance lane on a
capable desk. For example, the combined SMTP/restore scenario referenced on
#336 needs a disposable Docker daemon, the pinned observability images, a
compatible restic and a loopback TLS SMTP receiver. A successful emulator test
does not claim that combination was exercised.

## Why #342 could not establish sandbox scratch

The [security report on #342](https://github.com/mgscox/sporades/pull/342#issuecomment-6708601801)
reported a security-audit execution-policy preflight failure. Its `bwrap`
namespace probe succeeded, but it could not prove a **total-disk limit** on
persistent job-backed writable scratch. It never executed target code. This is
separate from the regular QA runtime test gate and from a test fixture defect.

On this desk, `CUBEFARM_JOB_SCRATCH` is a private directory on the shared ext4
filesystem, with mount options `rw,relatime`. Its mode `0700` prevents other
users reading it; it does not allocate a filesystem quota. `TMPDIR`, free-space
checks, a watchdog and `ulimit -f` do not enforce a cumulative disk limit.
`bwrap --size ... --tmpfs ...` supplies bounded memory-backed storage, not the
persistent job-backed scratch required by that audit policy.

To run target code under that audit policy the desk operator must provide:

1. A unique scratch filesystem below the assigned `CUBEFARM_JOB_SCRATCH` with an
   enforced hard byte **and inode** quota. A delegated ext4/XFS project quota or
   a fixed-size loopback filesystem mounted by the trusted worker launcher can
   supply this. For example, reserve 4 GiB and 100,000 inodes per audit worker;
   fail the setup if the quota or mount cannot be established. The target may
   not change that quota or expose another writable filesystem.
2. A working bubblewrap user/mount/PID/network namespace, read-only target and
   toolchain, and only that assigned scratch mounted writable. Give HOME,
   temporary directories and caches scratch-local paths and an explicit safe
   environment. Enable only an isolated loopback network if needed.
3. Enforced CPU, memory, process-count, per-file-size and wall-clock limits,
   plus supervisor cleanup of all target descendants. Capture the mount/quota
   identity, limits and a trusted over-quota rejection probe before executing
   target code. Merely observing available disk space is insufficient.
4. Already installed dependencies: the security audit policy prohibits target
   dependency downloads. A trusted parent can prepare the disposable source
   copy and dependencies before entering the sandbox. Retained audit artifacts
   stay outside writable target scratch and use the audit's parent-only bounded
   promotion procedure.

Do not weaken Host-path trust checks or audit isolation to get a green result.
Host backup fixtures also need protected user/root-owned ancestors (backup
secret paths reject writable ancestors even when sticky); see
`test/support/host-fixture-root.js`. The normal QA gate uses the ordinary trusted
checkout test workflow. A specialist audit unable to meet its extra isolation
contract should identify the missing sandbox control separately and follow its
existing desk-limit policy, without misreporting the runtime suite as executed.

## Historical #344 measurements

These measurements used sixteen harnesses and did not collect memory. They do
not establish the current memory-bounded QA budget. See the #345 measurements
below for the current gate.

Measured on 2026-11-07 in disposable desk worktrees, using Node 24.22.0, 18 available CPUs and approximately 31 GiB RAM. Other office
jobs shared the machine; these are observed wall times, not isolated CPU
benchmarks. Dependencies came from `npm ci`; the packed-Capsule dependency
install preflight passed in this same environment after cache preparation.

The original serial command at `a94ce0fb` was run after a build with a structured
per-file reporter. The revised tree includes main through `fd16c275` (including
#341’s new observability acceptance file), the independent shards and new runner
regressions. It completed **63 of 234 files in 1,821.26 seconds (30m 21s)** before
being stopped, with zero observed failures in completed files. It had reached
`dev.test.js`; its full duration and final totals are unknown. Treat that time
as a lower bound, not a successful baseline. The original command had no overall
watchdog or useful totals when interrupted.

| Command | Wall time | Files finished | Pass / fail / skip |
| --- | --- | --- | --- |
| `npm test` (including pretest build) | 733.11 s | 252/252 | 6657 / 0 / 310 |
| `npm run test:qa` (fresh worktree, including build) | 802.74 s | 252/252 | 6657 / 0 / 310 |

The seven serial fixture files took 171.47 s combined in QA. Their individual times and every independent file are in the CSV. PostgreSQL and real-service lanes were unselected. There was no `test:qa` command before this change.

The fresh QA run has an unavailable Docker executable on PATH and no selected
PostgreSQL database. It includes its own build and parity checks. Tests needing
real services remain opt-in, and installed Python supports the fake-Host lock
fixtures. Missing-tool and hung-process cases are also exercised by the runner's
focused tests with synthetic PATHs and disposable fixtures.

The full-suite command honors the same explicit integration selections as
before; available tools do not implicitly opt a desk into real Docker, Host or
provider operations. Its ordinary default run includes every test file and
reports the unselected real integrations as skips. The optional Docker acceptance
result is recorded separately below.

The optional real monitoring acceptance command used unique Compose projects and an ephemeral gateway port. One full attempt recorded **4 passed, 1 failed in 151.96 s**: its validator scenarios passed, but cold restore failed before the injected extraction marker. A focused cold-restore retry also failed (**150.66 s**) because Grafana still returned 502 during initialization after the bounded readiness wait. These are failed opt-in results, not missing-tool skips or passing restore evidence. All owned stacks and volumes were removed. No monitoring runtime implementation or restore safety check was relaxed. The local QA gate does not select this lane.

### Slowest twenty files

| File | Full wall time | QA wall time |
| --- | --- | --- |
| `file-ingress.test.js` | 487.26 s | 463.86 s |
| `job-scheduling.test.js` | 468.91 s | 446.99 s |
| `collection-tunnel.test.js` | 455.73 s | 427.25 s |
| `database-adapter-conformance-coverage.test.js` | 341.22 s | 299.36 s |
| `resource-transactions.test.js` | 307.64 s | 266.79 s |
| `database-adapter.test.js` | 282.98 s | 245.39 s |
| `dev-part-3.test.js` | 242.57 s | 204.95 s |
| `dev-part-2.test.js` | 239.37 s | 216.38 s |
| `dev.test.js` | 238.31 s | 206.47 s |
| `deploy-part-2.test.js` | 232.14 s | 208.88 s |
| `dev-part-5.test.js` | 230.46 s | 196.56 s |
| `dev-part-6.test.js` | 229.36 s | 196.08 s |
| `host-part-2.test.js` | 223.25 s | 205.46 s |
| `deploy.test.js` | 221.46 s | 202.51 s |
| `database-adapter-conformance-auth-storage.test.js` | 196.26 s | 187.80 s |
| `team-destructive-policy.test.js` | 182.57 s | 187.74 s |
| `monitoring-release-verifier.test.js` | 171.28 s | 170.69 s |
| `postgres-emitted-sql-quoting.test.js` | 167.60 s | 172.26 s |
| `stripe-webhook.test.js` | 166.73 s | 169.16 s |
| `dev-part-4.test.js` | 155.42 s | 146.87 s |

These are per-file wall times, including each file's isolated process startup.
They overlap in the parallel lane, so adding them does not give the command's
wall time. The Dev shards now distribute the original monolithic test file's
work across independent processes. The following are the slowest *completed*
files from the original serial baseline; `dev.test.js` remained unfinished.

| Original file | Serial wall time |
| --- | --- |
| `deploy.test.js` | 320.97 s |
| `collection-tunnel.test.js` | 244.14 s |
| `database-adapter.test.js` | 189.21 s |
| `database-adapter-conformance-coverage.test.js` | 186.69 s |
| `database-adapter-conformance-auth-storage.test.js` | 110.01 s |
| `dev-clamav-sidecar.test.js` | 35.54 s |
| `container-services-lifecycle.test.js` | 32.50 s |
| `create.test.js` | 28.16 s |
| `database-adapter-conformance-team-storage.test.js` | 27.54 s |
| `database-adapter-conformance-file-metadata.test.js` | 27.08 s |
| `dev-stripe-origin.test.js` | 24.32 s |
| `admission-evidence-lifecycle.test.js` | 23.72 s |
| `access-keys.test.js` | 17.88 s |
| `ai.test.js` | 17.78 s |
| `auth-provider-truth.test.js` | 17.02 s |
| `container-services-dev.test.js` | 13.39 s |
| `ai-provider-overrides.test.js` | 13.17 s |
| `client-runtime.test.js` | 12.89 s |
| `database-adapter-service-backed-spike.test.js` | 12.49 s |
| `capsule-rate-limit-runtime.test.js` | 12.11 s |

[All per-file measurements](qa-test-lanes-times.csv) records original completed
file times alongside the final full and QA runs. An empty baseline cell means
that file was not completed in the baseline, or was introduced by the split.
The baseline `dev.test.js` was the unfinished original monolith. The baseline
Host and Deploy files were also monoliths; their final rows describe the first
shard, so compare each suite’s combined workload accordingly. Both final runs retain Node's exact pass/fail/skip totals in
the table above and emit a JSON report through `--report` for future comparisons.

## Memory-bounded measurements (#345)

Measured on this shared Linux desk with Node 24.22.0 and approximately 31 GiB
of physical RAM. The per-session budget is 8 GiB; other desks shared the VM.
Values are sampled process-tree RSS, not just the test worker heap.
Machine-wide available memory and swap also reflect other desks.

The final full-suite command was `npm run test:qa -- --report=...`, including
its build/parity checks within the memory guard. No real-service acceptance
flags were selected.

| Lane | Files | File concurrency | Peak tree RSS (MiB) | Wall time (s) |
| --- | ---: | ---: | ---: | ---: |
| parallel | 201 | 4 | 1620.0 | 857.28 |
| memory lane | 44 | 2 | 3314.0 (six heaviest, width 2) | 2221.32 serial baseline |
| serial shared-service | 7 | 1 | 1161.6 | 94.52 |

| Measurement | Initial instrumented profile | Final calibrated QA |
| --- | ---: | ---: |
| Peak tree RSS (MiB) | 2381.1 | 1847.9 |
| Minimum available memory (MiB) | 4187.2 | 17226.2 |

The initial profile used four files and thirteen serial Capsule/parser fixtures.
It found two readiness-wait failures, fixed before the final gate; it is not a
passing validation result. Its measurements selected the additional serial files.
Machine-wide free-memory values are not a controlled comparison between runs.

Full command wall time (including build): **3180.86 s**.
Tests: **6698 passed, 0 failed, 0 cancelled, 310 skipped**.
Runner tree peak: **1847.9 MiB** against the **6,144 MiB** ceiling.
Available memory: **22619.4 MiB before**, **17226.2 MiB minimum**,
**28598.3 MiB after** (floor 1,536 MiB).
Swap available: **411.1 MiB before**, **411.1 MiB minimum**,
**417.1 MiB after**.

The manager-reported legacy run in #345 fell below 1 GiB available memory,
exhausted swap and left 204 tests cancelled. Its peak RSS was not recorded.
This comparison does not recreate an OOM on the shared machine.

### Twenty highest-memory files

| File (`test/`) | Peak tree RSS (MiB) | Wall time (s) | Lane |
| --- | ---: | ---: | --- |
| `dev.test.js` | 1774.5 | 104.83 | memory lane |
| `deploy.test.js` | 1706.2 | 124.90 | memory lane |
| `dev-part-6.test.js` | 1530.4 | 89.39 | memory lane |
| `dev-part-2.test.js` | 1436.7 | 128.66 | memory lane |
| `dev-part-5.test.js` | 1352.7 | 83.20 | memory lane |
| `dev-part-3.test.js` | 1260.9 | 108.52 | memory lane |
| `host-part-2.test.js` | 1221.4 | 155.62 | memory lane |
| `doctor.test.js` | 1189.8 | 23.95 | memory lane |
| `dev-part-4.test.js` | 1142.7 | 80.66 | memory lane |
| `public-assets.test.js` | 1142.4 | 47.52 | memory lane |
| `dev-watch.test.js` | 1088.0 | 24.56 | serial shared-service |
| `dev-stripe-origin.test.js` | 1039.0 | 14.39 | memory lane |
| `server-bundle-module-graph.test.js` | 1022.0 | 61.65 | memory lane |
| `host.test.js` | 1020.7 | 76.78 | memory lane |
| `telemetry-jobs-bundle.test.js` | 977.9 | 53.93 | memory lane |
| `html-document-injection.test.js` | 975.3 | 11.40 | memory lane |
| `deploy-part-2.test.js` | 939.3 | 128.53 | memory lane |
| `sealed-env.test.js` | 926.5 | 13.91 | memory lane |
| `admission-evidence-lifecycle.test.js` | 890.2 | 22.97 | memory lane |
| `telemetry-websocket-bundle.test.js` | 870.0 | 33.14 | serial shared-service |

### Twenty longest files

| File (`test/`) | Peak tree RSS (MiB) | Wall time (s) | Lane |
| --- | ---: | ---: | --- |
| `job-scheduling.test.js` | 501.6 | 238.53 | parallel |
| `file-ingress.test.js` | 435.4 | 194.05 | memory lane |
| `collection-tunnel.test.js` | 835.6 | 186.80 | memory lane |
| `host-part-2.test.js` | 1221.4 | 155.62 | memory lane |
| `database-adapter-conformance-coverage.test.js` | 286.2 | 149.21 | parallel |
| `monitoring-release-verifier.test.js` | 662.4 | 137.33 | memory lane |
| `dev-part-2.test.js` | 1436.7 | 128.66 | memory lane |
| `deploy-part-2.test.js` | 939.3 | 128.53 | memory lane |
| `resource-transactions.test.js` | 238.1 | 127.60 | parallel |
| `deploy.test.js` | 1706.2 | 124.90 | memory lane |
| `database-adapter.test.js` | 255.4 | 116.20 | parallel |
| `dev-part-3.test.js` | 1260.9 | 108.52 | memory lane |
| `dev.test.js` | 1774.5 | 104.83 | memory lane |
| `database-adapter-conformance-auth-storage.test.js` | 410.1 | 104.25 | parallel |
| `team-destructive-policy.test.js` | 320.3 | 100.28 | parallel |
| `stripe-webhook.test.js` | 417.4 | 100.03 | parallel |
| `email-events.test.js` | 172.5 | 93.68 | parallel |
| `monitoring-maintenance.test.js` | 298.3 | 92.29 | parallel |
| `postgres-emitted-sql-quoting.test.js` | 268.4 | 89.78 | parallel |
| `dev-part-6.test.js` | 1530.4 | 89.39 | memory lane |

### Cleanup observations

No completed file left an observed surviving child process. The detached-helper
regression fixture independently proves that the runner reports and reaps such
helpers before advancing to another file.

The Job wake-timer cleanup test now uses the runtime clock at its original
100 ms/110 ms boundaries and verifies no delayed handler runs after close. Its
failure path also closes the database before removing fixture storage. This
removes a real-clock race and a missed database cleanup discovered while profiling.

The packaged Mail Capsule permits 30 seconds for its startup port within the
existing 60-second case. The Checkout fixture permits 30 seconds for its four
durable attempts, retaining the exact attempt-count, failure, recovery and
revocation assertions. Short transport and rejection deadlines are unchanged.

[All per-file memory measurements](qa-test-lanes-memory.csv) include wall time,
lane, test totals and the number of surviving processes cleaned by the runner.
