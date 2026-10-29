# Host route recovery verification (#316)

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
Postgres, Compose, real Docker, root ownership, restic, VM/Host, promtool and live
SMTP checks were not configured/available; unsupported libSQL resource tests are
skipped by design. The focused 45 recovery tests had no skips.
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
