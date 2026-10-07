# PR #224 pipeline-only rollback verification

Monitoring implementation and Docker-tested revision:
`95b5e054e07ac051849d335feb0c84c04980c964`. Main integration:
`24cdc908` (upstream connection-lost UI). Monitoring source, shipped monitoring
modules and stack assets remained byte-identical across that merge; the CLI and
source manifest were regenerated. [Docker diagnostics and hashes](telemetry-223-local/rollback.json).

## Correction and regression

Round two unconditionally required availability/performance mounts when
validating rollback. Older supported pipeline-only schema-4 stacks lack those
mounts, so upgrade succeeded but rollback failed.

Only absent availability/performance mounts are now optional. Present mounts
retain the same exact-target, read-only bind, regular-file, safe-parent and
in-tree path checks. Pipeline rules and main configuration remain required.
Real promtool checks the effective configuration and rejects references to
unmounted rule files, even when init has filled newer assets on the host.
No public API/type shape changed. Source, generated artifacts and canonical and
distributed documentation ship together.

The gzip fixture contains all 28 public assets byte-identical to `6542368d`,
with its schema/version metadata and no operator secrets. SHA-256:
`1454ebdbda9574d22b020f128177f7b41835e70df2c307a884341890091f486e`.
Tests require no Git history at runtime. Current init fills newer assets while
retaining the old Compose/Prometheus generation, then upgrade and rollback
restore every historical asset byte. Repeated rollback is idempotent. The new
CLI regression failed before the correction (upgrade 0, rollback 1) and passed
afterward, including in the integrated full suite.

## Validation

- Final sequential maintenance, packed-CLI and client-runtime tests: 123 passed,
  zero failures/skips, exit 0, 103.603 seconds. Initial focused monitoring run:
  38 passed. Build, typecheck and generated-artifact parity passed after merging
  main.
- Full `npm test` on `24cdc908`: exit 1; 3,200 tests, 2,971 passed, one failed,
  228 default opt-in/adapter skips, zero cancellations, 2,230.441 seconds.
  PostgreSQL fixtures were not configured. Its build/parity pretest passed.
  The unchanged Facebook loopback test's 30 ms token exchange deadline expired
  before Graph, producing `FACEBOOK_EXCHANGE_TIMEOUT` rather than its expected
  `FACEBOOK_GRAPH_TIMEOUT`. The case subsequently passed three isolated runs,
  and its complete ten-test file passed. The test and auth implementation are
  unchanged from main. The broad failure is retained, not relabeled as a pass.
- Under umask 0077, `npm run test:real-monitoring-maintenance`: five passed,
  zero failures/skips, exit 0, 153.850 seconds. Genuine pipeline-only upgrade and
  rollback exited 0. Missing availability/performance references produced
  expected rollback exit 1 without publishing. Installed-CLI cold backup/restore,
  exact inventory and sender checks passed. Trace
  `2446998bf47001559e88f6b7fe129080` and `maintenance_history=130` survived
  backend/gateway restart.
- Documentation: 53 tests and VitePress build passed. Canonical guidance rendered
  at desktop and 390px phone widths without overflow; only the existing favicon
  404 appeared. Browser and the port 5688 docs server were stopped.

Commands used worktree-local `SPORADES_CONFIG_DIR`, `env -u NODE_OPTIONS` and
`COPYFILE_DISABLE=1`. Docker additionally used the task runner's `DOCKER_HOST`
and isolated `DOCKER_CONFIG`:

```sh
(umask 0077; COMPOSE_PROJECT_NAME=barbara224-round3-retry-20261007 \
  npm run test:real-monitoring-maintenance)
```

Fresh unique projects were generated internally. Docker reported zero
containers/volumes before the temporary runner was stopped and deleted.
Prior live alert firing/recovery acceptance remains recorded in the
[earlier evidence](telemetry-223-local/availability.json); availability/runtime
assets were unchanged by this repair and main integration.

## Boundaries and retained failures

The successful runner was local Lima 2.2.0, Ubuntu 26.04 arm64, Docker 29.8.2,
Compose 5.5.1, with only this worktree mounted. Docker configuration contained
only Compose plugin discovery, with no manager credentials. Docker Desktop was
not restarted. No real Host or monitoring endpoint, cloud server, publication,
tag or release was used.

Failed runner starts remain failed: the first path exceeded the Unix socket
limit; Lima 2.2.1 produced repeated vsock errors, and 2.1.2 failed to reach SSH
readiness. Both task-created instances were stopped/deleted. First Docker
acceptance passed legacy/missing-reference cases but failed on an initial
Grafana 502 before maintenance. The subsequent unchanged command passed.
The pre-integration full suite was interrupted for main's merge conflict.
A post-merge pretest hit transient EPERM reading a map; rechecking parity passed.
An overlapping focused run had one upgrade refusal and one fixture-mkdtemp
EPERM; the final sequential run passed all 123 tests. None of those failed or
interrupted attempts is credited. Logs/screenshots remain in ignored
`logs/pr224-round3/`.

Real systemd/separate-VM scenario 3 remains manager-only and unverified. Its
[checklist](telemetry-223-scenario3.md) and issue #128 acceptance are unchanged;
local Docker evidence does not replace that scenario.
