# PR #224 local Docker verification

Verified on 2026-10-07. Runtime and CLI implementation:
`b11eb871f967555f1d5232618502bdea70d3d3fe`.

Round-one QA could not reach Docker Desktop. A temporary local Lima runner
(Ubuntu 26.04 arm64, Docker Engine 29.8.2, Compose 5.5.1, 2 CPUs, 4 GiB RAM)
provided a healthy isolated Docker socket and mounted only this worktree.
Node.js was 24.19.0. Docker configuration contained only the installed Compose
plugin directory; no manager Docker credentials or Sporades profiles were used.

## Corrections discovered by the real run

- Package extraction under umask 0077 narrowed public assets to 0600. Stack
  initialization copied that mode into the gateway image, which could not read
  `/app/gateway.mjs`. Newly copied public stack assets now explicitly use 0644.
  Existing operator file modes remain unchanged.
- Candidate copies narrowed unchanged public configuration to 0600 before
  validation. Candidate and backup copies now explicitly retain each source
  file's mode, including private 0600 files. Staging directories remain 0700.
- Backend validation rejected the availability and performance rule mounts in
  the shipped Prometheus Compose configuration. It now accepts and validates
  those exact effective in-tree read-only rule mounts alongside pipeline rules.
  Malformed rule overrides still refuse publication with redacted errors.

The packed CLI and version-only upgrade regressions failed before these
corrections and passed afterward. The effective-mount fixtures now include all
three shipped rule files and cover malformed availability/performance overrides.
Source, generated CLI/dist artifacts and canonical/distributed documentation
ship together. No public API or type shape changed.

## Docker history and alert evidence

With worktree-local configuration and a fresh Compose project, this passed:

```sh
(umask 0077; COMPOSE_PROJECT_NAME=barbara224-20261007-complete \
  npm run test:real-monitoring-maintenance)
```

The command used the isolated runner's `DOCKER_HOST` and `DOCKER_CONFIG`.
The test independently generated the two unique project names recorded in
[maintenance evidence](telemetry-223-local/maintenance.json). Result: 1 passed,
0 failed, 0 skipped, exit 0, 165.290 seconds. It exercised installed CLI
initialization, authenticated trace/metric delivery, stopped-writer enforcement,
upgrade/rollback, cold backup, concurrent-edit refusal, interrupted restore and
retry, exact inventory restoration, retained sender generations, cross-Host
credential denial and revoked-sender rejection. Trace
`732e062f7543f460ab575c87234df1fc` and `maintenance_history=130` remained queryable
after backend/gateway restart. The test printed only non-secret query evidence.

The existing availability drill also passed under umask 0077:

```sh
(umask 0077; COMPOSE_PROJECT_NAME=barbara224-alerts \
  node scripts/verify-availability.mjs)
```

[Alert evidence](telemetry-223-local/availability.json) and its
[webhook timestamps](telemetry-223-local/availability-notification-timeline.json)
record a firing notification after 97,012.853 ms, recovery delivery, telemetry
absence and acknowledged-stop removal. This drill preceded the final maintenance
rule-mount correction; the unchanged availability/runtime surfaces and their
SHA-256 values are recorded explicitly. It did not invoke maintenance.

Both drills removed only their own uniquely named stacks, volumes and local
images. Docker reported zero containers and volumes before the temporary runner
was stopped and deleted. The existing Docker Desktop engine was not restarted.
No real Host, real monitoring endpoint, cloud provisioning, publication, tag or
release action occurred.

## Validation

The final `npm test` run on the implementation above exited 0: 3,197 tests,
2,970 passed, 227 default opt-in or adapter skips, zero failures/cancellations,
2,627.721 seconds. It used `env -u NODE_OPTIONS`, worktree-local
`SPORADES_CONFIG_DIR` and `COPYFILE_DISABLE=1`; PostgreSQL fixtures were not
configured. Its pretest build and generated-artifact check passed.
`npm run typecheck`, the focused permission/mount regressions, and
`npm run docs:check` also passed (53 documentation tests and VitePress build). Documentation rendered at 1280px
and 390px without overflow; only the existing favicon 404 appeared. Port 5688,
browser tabs and the temporary Docker runner were stopped.

Earlier failed attempts remain failed evidence: isolated Docker configuration
initially omitted Compose discovery; readable-public-asset and supported-rule
failures exposed the defects above; one intermediate run returned a Grafana 502
before dashboard readiness. Earlier full-suite runs were interrupted when Docker
revealed further source changes and are not counted as passes. Local logs and
browser captures are retained under ignored `logs/pr224-round2/`.

Real systemd/separate-VM scenario 3 remains manager-only. Its existing
[checklist](telemetry-223-scenario3.md) and issue #128 acceptance remain pending;
local Docker evidence does not replace that drill.
