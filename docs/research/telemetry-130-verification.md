# Monitoring maintenance verification — #130

## PR #213 round 3 journal recovery fix

Reverified locally on 2026-10-04 at runtime commit `3256f830`, with main through
`7753267c`. Both main changes were retained; generated map/manifest conflicts
were resolved by rebuilding. The earlier pre-integration full-suite run was
cancelled and is not counted as a pass.

Publication now durably records original bytes and original/intended hashes,
permissions and numeric owners before replacing generated files. Recovery checks
every journalled file before restoring any. Post-interruption operator edits,
deletions or permission/owner changes refuse recovery with redacted preservation
and reconciliation guidance. Files and journal remain intact across repeated
refusals. Restoration publishes original metadata atomically, allowing another
interruption during recovery to be retried. Legacy journals without intended
hashes only retire when every file already matches the original bytes; otherwise
recovery refuses instead of inferring ownership of a replacement.

The shipped-CLI SIGKILL regressions interrupt immediately after collector.yaml
publication, then edit collector.yaml or README.md, change permissions or delete
the file. Retry refuses and preserves every journalled file and the exact journal.
An unmodified retry and a second SIGKILL during restoration also recover. Against
QA's original `236d4969` CLI, all four preservation subcases failed as expected,
while ordinary recovery passed. The separate legacy-journal override regression
also failed against the original CLI.

Validation:

- Build, generated-bin verification and combined-head typecheck passed.
- Focused maintenance tests: 33 passed, zero failures/skips.
- Docker-enabled maintenance, installed-package CLI and Host regressions:
  58 passed, zero failures/skips/cancellations on the unmodified rerun. An earlier
  run had 57 passes and a rollback status-1 failure in cold-restore acceptance;
  an isolated diagnostic rerun passed, followed by the complete clean rerun.
  The initial rollback failure was not reproduced or attributed to a code cause;
  no source/test changes were made between those Docker runs.
- Full combined-head `npm test`: 3,104 tests, 2,880 passed, 224 optional skips,
  zero failures/cancellations, exit 0 (1,401.72 seconds).
- Documentation checks: 53 passed plus successful documentation build.
  Playwright followed the guide navigation and checked recovery text at 1280px
  and 390px; no horizontal overflow or application console errors (favicon 404
  only). Browser and port-5218 preview server stopped.
- Release archive: schema 4, all 28 asset hashes matched, updated maintenance
  guide present, private/env files excluded. Whitespace checks passed.

All Sporades commands used worktree-local configuration. Docker Desktop used
Engine 29.8.1, Compose 5.5.1 and Node 24.19.0 on macOS arm64; task-owned resources
were removed. No real Host, SSH, cloud provisioning, live provider, publication,
tag or release operation was performed. Prior VM evidence was not repeated;
the disposable-Host shutdown/reconnect/removal, worker cleanup and reboot drills
remain manager acceptance steps. Operators must keep services stopped, save
conflicting overrides separately, reconcile the original generation before retry,
and reapply saved overrides after recovery; journals must not be deleted to bypass
refusal. Validation logs and browser captures remain in the ignored worktree-local
`.sporades/pr213-round3/` evidence directory.

## PR #213 round 2 fixes

Reverified locally on 2026-10-04 after fixing concurrent restore volume ownership,
non-root Linux archive ownership, and effective backend configuration validation.
Restore holds daemon-wide per-volume container-name guards, rechecks the exact
snapshot owner after creation and immediately before extraction, and releases
guards on process exit. Root tar writes pre-created operator-owned mode-0600
files while retaining numeric backend metadata. Upgrade/rollback validate
Compose-selected configuration bind files and Jaeger environment; unsupported
invocation overrides fail before generated-file publication.

The foreign-volume regression failed against the pre-fix installed CLI, which
reported success. Effective mount/command/environment/entrypoint probes likewise
failed before the fix, and the pre-created private archive regression failed.
Fixed real-Docker probes preserve unrelated sentinel bytes after races both
following volume listing and immediately before extraction. Competing restores
from different target directories are rejected, including when both use the
same snapshot, and SIGKILL releases their guards for retry. Real Compose selects
malformed operator Jaeger/Prometheus files and maintenance refuses publication.

Linux acceptance runs the installed CLI as UID 10001 against a Linux named-volume
filesystem, avoiding macOS bind-mount identity translation. All backup archives
remain operator-owned and mode 0600, can be chmodded by that UID, and retain
archived UID/GID 23456:34567. The task-owned runner, image and volumes are removed.
This is Linux container filesystem/identity evidence, not a new clean-VM drill.
Docker Desktop used Engine 29.8.1, Compose 5.5.1 and Node 24.19.0 on macOS arm64.
Workstation and Linux runner commands used isolated `SPORADES_CONFIG_DIR` paths.

The branch integrates current main; its generated-manifest conflict was resolved
by regenerating artifacts. The pre-integration full-suite run was intentionally
cancelled and is not counted as a passing run. Integrated build/generated-bin checks, typecheck and documentation checks
passed (53 documentation tests plus the build). The combined Docker-enabled
maintenance, installed-CLI and Host regression run passed 48 tests with zero
skips, failures or cancellations. The full integrated `npm test` exited 0: 3,085 tests, 2,863 passed, 222
optional skips, zero failures or cancellations (1,373.65s). The wrapper cleanup
was then verified to kill its task-owned process only once; the real-Docker
competing-restore/SIGKILL test passed separately again.

Playwright followed Operations to the updated guide at 1440x1000 and 390x844,
opened the mobile page menu and followed Restore. Both widths had no horizontal
overflow; the correct maintenance route had zero console errors/warnings. The
preview server and browser were stopped. Release archive inspection matched all
28 schema-4 hashes, included the updated guide and excluded private/env files.
No real Host, cloud provisioning, live provider, publication, tag or release
operation was performed; prior VM and operator-drill limits still apply.

## PR #213 round 1 fixes

Reverified locally on 2026-10-04 after fixing disabled export recovery, failed
reconnect recovery and concurrent operator edits during upgrade/rollback.
Disabled reconciliation now retries owned relay/exporter shutdown without
removing credentials or the acknowledgement-gated inventory worker. Failed
reconnect restores a previously disabled connection's stopped state.
Maintenance snapshots planning inputs and checks them again before publication.

The focused run passed 35 tests, including simulated interruption after durable
disable intent, forced Caddy/relay/exporter shutdown failures, failed reconnect,
and validation-time edits to README, environment files, Collector configuration,
Compose overrides and private configuration during both upgrade and rollback.
The opt-in maintenance Docker run passed 20 tests with no skips, including one
installed-package cold backup/restore acceptance test with retained history and
credentials. Docker Desktop used Engine 29.8.1 and Compose 5.5.1 on macOS arm64,
with Node 24.19.0. All Sporades commands used worktree-local configuration.

Build, generated-bin verification, typecheck and documentation checks passed
(53 documentation tests plus the documentation build). The full `npm test`
passed: 3,039 tests, 2,824 passed, 215 optional skips, zero failures/cancellations,
exit 0. The previously reported Todo WebSocket timeout passed in this full run.
Optional PostgreSQL checks remained skipped. Release archive inspection matched
all 28 schema-4 asset hashes, excluded private files, and confirmed the updated
maintenance guide. Playwright verified the updated guide at 1440px and 390px,
with no horizontal overflow or page console errors; the preview server stopped.

This follow-up used local Docker and fake Host Docker/Caddy/systemd seams with
verified local HTTPS inventory. It did not repeat the earlier supported-VM drill
below or contact a real Host. An operator should still verify interrupted
shutdown and failed reconnect on a disposable supported Host, including stopped
owned agents, retained credentials, inventory acknowledgement and reboot.

## Original implementation verification

Verified on 2026-10-04 using the installed Sporades 0.9.31 package, a disposable
Monitoring Compose stack, and a clean Ubuntu VM on the existing Tower LAN
hypervisor. No production Host, Capsule data, cloud account, provider operation,
npm publication, tag or release was used. Workstation commands used a
worktree-local `SPORADES_CONFIG_DIR`; guest commands used a task-local directory.
Native blockers #112 and #118 were closed at implementation and final review.

## Supported-VM drill

The disposable amd64 guest used Ubuntu 24.04.5 LTS (Noble cloud image), Node
24.19.0, Docker Engine 29.5.0 and Compose 5.6.0. The downloaded image matched
Ubuntu's published SHA-256:

```text
6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2
```

Pinned stack images were Collector Contrib 0.138.0, Jaeger 2.21.0, Prometheus
3.13.3, Grafana 13.2.2, BusyBox 1.37.0 and gateway Node
24.13.0-alpine3.23. Linux amd64 was exercised on the clean VM; macOS arm64
Docker Desktop was exercised separately. Linux arm64 is a documented supported
image architecture, but was not separately exercised by this drill. Restore
preserves numeric UID/GID and modes: retain the snapshot's backend versions and
compatible Linux identities before attempting an image upgrade.

On the VM, the package was unpacked into an otherwise clean task directory,
then both maintenance test files were run against the shipped CLI:

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" \
  SPORADES_MAINTENANCE_DOCKER=1 node --test --test-concurrency=1 \
  test/monitoring-maintenance*.test.js
```

All seven tests passed, with no skips, failures or cancellations (113.85s).
The real Compose drill wrote a known trace, a metric with value 130 and an exact
Host inventory revision, stopped writers, upgraded and rolled back generated
files, and made a protected cold snapshot. A fresh target restored all four
volumes and literal environment bytes. Trace, metric and inventory queries
passed after restore; the trace query passed again after restarting Jaeger,
Prometheus and the gateway. Active and pending rotated sender credentials
remained accepted, a revoked sender remained denied, and inventory credentials
could not cross Host scopes.

The drill deliberately interrupted metrics extraction, retried the same
snapshot successfully, and confirmed repeated completed restore was unchanged.
A configuration edit during backup prevented publication. Focused tests also
covered live SQLite maintenance exclusion, SIGKILL recovery, interrupted file
publication, rollback refusal after later operator edits, schema-3 baseline
validation, unsafe paths and archives larger than 2 GiB. Whole-file checksum
reading first failed the large-archive regression; streaming checksums passed
against an independently calculated digest.

Each Compose test removed only its own projects and volumes. The guest had no
remaining containers or volumes before its task-owned VM and disks were removed.

## Other checks and boundaries

The real installed-package Docker Desktop acceptance test passed separately
(one test, no skips). Host removal tests used real private-CA HTTPS central
inventory acknowledgements with a fake Docker/systemd seam. They proved opt-out
publication, revoked-authority denial, retained credentials and non-resurrection
of disabled exports. This is not evidence of removal from a production Host or
a Host reboot drill; no production Host was contacted.

Build, typecheck, focused package/Host/maintenance tests, and the generated-source
checks passed. The final integrated `npm test` exited zero: 3,020 tests,
2,805 passed, 215 optional skips, and no failures or cancellations (1,319.93s).
The final focused run of maintenance, installed stack CLI, Host relay and Host
inventory/reconnect tests passed 16 tests without skips. The full suite's
optional Docker acceptance skip was exercised separately on both environments
above; other optional integrations were not claimed as passes.

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run build
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run typecheck
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm test
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" node --test --test-concurrency=1 \
  test/host-inventory-reconnect.test.js test/host-telemetry-relay.test.js \
  test/monitoring-maintenance.test.js test/monitoring-stack-cli.test.js
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run docs:check
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run monitoring:release-asset \
  -- .sporades/issue130-release-final.tar.gz
```

`npm run docs:check` passed all 53 documentation tests and the
VitePress build. The monitoring release archive used schema 4, all generated
asset hashes matched, the maintenance guide was included, and environment and
private files were excluded.

Playwright followed the Operations link to the maintenance reference on local
port 5203 at desktop 1440×1000 and mobile 390×844. There was no horizontal
overflow or application console error; a favicon 404 was observed. The local
documentation server and browser session were stopped. Evidence:
[desktop](./telemetry-130-desktop.png), [mobile](./telemetry-130-mobile.png).

Supported backup scope is the default cold named-volume stack. External/custom
backend storage and cross-product historical-data migration are rejected.
Optional Collector queue files are separate delivery state. Snapshots contain
secrets and backup-time authentication state: protect and encrypt them offline,
keep restored gateways private, reapply later revocations and reconcile current
Host expectations before exposing them. SHA-256 verifies integrity, not origin.
