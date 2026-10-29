# Host route recovery verification (#316)

**Hosted follow-up (#318), 2026-10-29:** the disposable-provider matrix is now
complete for follow-up source `2206b681`. The merged #317 helper failed automatic
recovery because its emitted readiness probe received fractional milliseconds;
the follow-up fixes that defect and passes every hosted row, including reboot
and cleanup. See [the acceptance report](./host-route-recovery-318.md) and its
redacted evidence. The round 1 record below is historical. Package publication
and upgrades of existing Hosts remain separate from this test run.

**Merge acceptance remains incomplete after Barbara round 1.** Local QA passed
for `53503d2023c0b0fa51fcda215db403b7fe786526`; the required disposable-provider
Docker/Caddy acceptance has not run. The matrix below is a pending evidence
record, not a hosted pass. This session prohibits cloud creation and real Host
contact, and no manager-provided disposable Host is identified in the handoff.

Local verification date: 2026-10-29. Base revision:
`02920387d85e882af633c627139c597339d26fe9`. Candidate source is the PR head;
no candidate helper was installed on an existing Host. Package version during
local verification: 0.9.41, Node 24.22.0. Generated helper parity was built
locally; generated `dist/` and `bin/` changes are excluded from the PR.

## Deterministic reproduction

The same new `backup capture returns only after its actual changed route and
protected runtime settle` test was run against the unchanged base helper and
against the candidate built helper. It uses a disposable Host registry, real
SQLite capture, stateful fake Docker/Caddy/restic, synthetic data, and no
operator health command. Docker stop/start changes the publication from
`127.0.0.1:49153` to `127.0.0.1:49154`.

The base helper returned successful backup completion and removed its journal,
but the route observed at upload still contained:

```caddy
reverse_proxy 127.0.0.1:49153 {
```

The regression failed its expected `49154` assertion. The candidate passes:
Caddy targets `49154`, readiness and the authenticated routed probe complete,
and the journal survives upload until final settlement before return. A second
external Docker port change during upload is also reconciled before success;
failed final settlement reports the completed snapshot and retains the journal.
This proves the local
coordination defect and repair, independently of the original incident's
unknown triggering operations.

## Focused coverage

The focused invocation passed 45 tests with no failures or skips. The tests in
`test/host.test.js` cover:

| Scenario | Local result |
| --- | --- |
| Successful capture; changed publication before returning success | Pass |
| Capture failure with successful resume; original error retained | Pass |
| Interrupted capture; exact retained instance settled before next capture | Pass |
| Missing, non-loopback and out-of-range publication | Pass; journal retained |
| Readiness failure and later automatic retry | Pass; no early route publication |
| Caddy reload failure | Pass; previous valid route restored; journal retained |
| Snapshot completed but application resume failed | Pass; distinct diagnostics and retained journal |
| Capture failure plus resume failure | Pass; original error remains primary |
| External restart during upload; failed final routed verification | Pass; recheck before return, retain evidence on failure |
| Timer startup, repeat scans, Docker outage and missed changes | Pass |
| Stopped/failed/unregistered/unmanaged instances and stale release/ID | Pass; no lifecycle commands |
| Deployment/restore journals, release-link mismatch and unavailable routes | Pass; unchanged routes |
| Concurrent backup stop and automatic recovery | Pass; shared lifecycle lock excludes repair |
| Separate sibling Capsules | Pass; both upstreams converge independently |
| Matching disk route with a missed active Caddy reload | Pass; validate/reload/reprobe |
| Missing route during interrupted publication | Pass; rebuild only for exact eligible running identity |
| Real loopback HTTP probe: ready, redirect, malformed/oversized and unready bodies | Pass; bounded opaque errors, no redirected credential |
| Timer renderer and generated helper flags/actions | Pass |

These are local deterministic tests. The fake-proxy route checks and real
loopback HTTP checks do not establish cloud TLS, genuine WebSocket proxying,
Docker dynamic allocation, systemd activation, or VM reboot behavior.

Reproduce with configuration isolated inside the checkout:

```sh
export SPORADES_CONFIG_DIR="$PWD/.tmp/issue-316-config"
npm run typecheck
npm run build
node --test --test-name-pattern='backup (capture|settlement|resume|completion)|interrupted backup resumes|automatic route|route worker|Host route timer|concurrent sibling route|routed settlement|cold runtime|recovery (reloads matching|rebuilds a missing)|boot recovery settles|boot backup recovery' test/host.test.js
npm test
```

Final `npm run typecheck` and `npm run build` passed. Final `npm test` completed
6,837 tests: 6,535 passed, 302 skipped, zero failures or cancellations. Optional
Postgres, Compose, real Docker, root ownership, restic, VM/Host, promtool, opt-in Chromium and live
SMTP checks were not configured/available. The focused 45 recovery tests had no skips.
The exploratory Host-suite run exposed call-sequence expectations and a legacy
registry-without-release fixture; those were corrected. Exploratory full runs
were deliberately interrupted to add missed-active-reload, upload-window and interrupted-publication
recovery coverage, then restarted against the final candidate. Those runs are
not claimed as successful final full-suite results.

The operator docs were also rendered with VitePress on reserved local port
5203 and checked with Playwright navigation, snapshots, link clicks and a
screenshot. The backup-to-route-recovery anchor works. The docs server was
stopped afterward; this browser check is unrelated to hosted runtime acceptance.

## Hosted acceptance and isolation record

**Not run:** the disposable Hetzner/DigitalOcean acceptance requested in #316.
This agent session prohibits creating cloud servers and contacting real Host
servers. No VM, cloud Capsule, DNS, live backup repository, Docker container or
shared Caddy service was created or changed for acceptance. No installed
production helper was inspected or replaced. The TallyTray operator workaround
was untouched. Local synthetic fixture directories are removed by test cleanup;
there are no cloud resources to tear down.

The manager/QA still needs a dedicated disposable Host containing only issue-owned
fixtures. Follow the issue's complete acceptance matrix: record candidate commit,
installed helper version/hash, UTC timestamps, initial HTTPS/token/WebSocket
runtime exchange, forced old/new Docker mappings and Caddy upstreams, and the
unfixed 502 reproduction. Then cover start/restart, replacement/rollback, each
backup resume outcome, direct Docker restart, worker downtime/missed changes,
and Docker-daemon restart or reboot. Measure convergence after readiness with
no manual `host health` or operator refresh workaround. Preserve a separate
sibling route/data fixture and an explicitly stopped fixture throughout.

Capture redacted logs and pass/fail/skip results for each operation and every
HTTP/token/WebSocket recheck. Record an empty pre-existing-resource inventory
before provisioning fixtures, then an explicit resource-ID cleanup list for the
VM, volumes, hostnames and synthetic backups. No zero-downtime or hosted
acceptance claim follows from the local tests in this document.

### Barbara round 1: independently verified local results

[QA report](https://github.com/mgscox/sporades/pull/317#issuecomment-6505300993),
2026-10-29, candidate `53503d2023c0b0fa51fcda215db403b7fe786526`:

- No actionable code regression or contract gap found.
- Build, typecheck and full suite passed: 6,535 passed, 302 skipped, no failures.
- All 45 focused recovery tests passed. The new backup regression independently
  failed against rebuilt base `02920387d85e882af633c627139c597339d26fe9`.
- All 56 documentation tests and the VitePress build passed. Browser checks
  covered the operator docs and a generated local Todo Capsule.
- Disposable user systemd units retried every five to six seconds with an
  inactive dependency, then executed repeatedly after activation. This does not
  verify the installed Host worker or the 30-second hosted convergence target.
- Telemetry Docker acceptance failed at `pipeline dashboard was not provisioned`
  on both candidate and rebuilt main, after stack readiness and stored Job
  metrics succeeded. Later outage/alert drills were not reached. QA identified
  this as a baseline failure; no telemetry fix is requested for #317.

### Round 1 follow-up local rerun

This follow-up changes only this verification document. Runtime source remains
the source independently reviewed by Barbara at `53503d2`. With
`SPORADES_CONFIG_DIR="$PWD/.tmp/issue-316-config"`, the rerun passed:

- `npm run typecheck`.
- `npm test`, including its build and generated-manifest precheck: 6,837 total,
  6,535 passed, 302 skipped, zero failures or cancellations.
- The focused recovery command above: 45 passed, zero failures or skips.
- `npm run docs:check`: 56 tests passed and the VitePress build succeeded.
- Playwright navigation, snapshot, pending-evidence anchor click and screenshot
  inspection of this document on port 5203. The docs server was stopped afterward.

Generated `dist/` and `bin/` outputs are restored from `origin/main` before
commit. Hosted acceptance and the separate telemetry Docker drill were not run.

### Required hosted evidence: pending

Execution requires a manager-provided, dedicated disposable Hetzner or
DigitalOcean Host and an executor permitted to operate it. Supplying a hostname
alone does not lift this session's prohibition on real Host contact. Do not use
an existing production Host to fill these gaps.

Before running the matrix, attach provider/VM identity, approved test scope,
UTC start time, an empty pre-existing-container/service inventory, test-owned
resource IDs and hostnames, synthetic fixture/backup locations, candidate commit,
package version, and the installed helper SHA-256. Keep credentials, connection
tokens and protected probe headers out of the evidence.

Every recovery row requires UTC timestamps, the exact command or injected fault,
container/release IDs, actual old/new Docker loopback mappings, Caddy upstreams
before/after, redacted diagnostics, and HTTPS root 200, marked connection-token
200, genuine WebSocket 101 plus a read-only runtime exchange after recovery.
Record convergence from runtime readiness to successful routed recovery. Do not
run `host health` or an operator refresh workaround during these measurements.

| Required scenario | Status after round 1 | Evidence still required |
| --- | --- | --- |
| Initial candidate baseline | Not run | Identity/inventory above; HTTPS, token and WebSocket baseline |
| Unfixed reproduction with a forced dynamic port change | Not run | Base/helper identity, real old/new mappings, stale upstream and observed 502 |
| Candidate start and restart | Not run | Force changed publication; settle and recheck all three protocols after each operation |
| Deployment replacement and rollback | Not run | Exact old/new release and container identity; mapping/upstream and protocol results for both paths |
| Successful backup capture/resume | Not run | Synthetic snapshot result, journal lifetime, changed mapping and protocol results before command success |
| Failed capture with resume | Not run | Injected capture fault, preserved primary error, settled route and protocol results |
| Interrupted-backup recovery | Not run | Exact retained instance/journal before retry; journal cleared only after verified settlement |
| Resume/route failure followed by recovery | Not run | Snapshot versus resume status, retained journal, failed/retried Caddy publication and subsequent protocol results |
| Out-of-band Docker restart | Not run | Forced changed mapping; readiness and automatic recovery timestamps; measured convergence against 30 seconds |
| Worker restart and missed changes | Not run | Worker stop/start times, port change while inactive, startup reconciliation and protocol results |
| Disposable Docker-daemon restart or VM reboot | Not run | Boot/daemon and worker activation evidence; recovered mappings/upstreams and protocol results |
| Sibling and intentionally stopped fixture isolation | Not run | Sibling route/data and stopped-state/container identity before/after every disruptive scenario |
| Cleanup | No hosted resources created in this session | Future run must identify and remove only its own VM, containers, volumes, DNS and backups, with final inventory |

Attach actual results and redacted artifacts to this document before treating
#316 as complete. Local deterministic tests, QA's local browser/systemd checks,
and the unrelated telemetry baseline result do not satisfy these hosted rows.
