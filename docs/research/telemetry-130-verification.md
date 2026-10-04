# Monitoring maintenance verification — #130

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
