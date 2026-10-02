# Lifecycle inventory verification — #118

Local verification on 2026-10-02 used the regenerated Sporades 0.9.31 CLI/helper,
Node 24.19.0 and Docker Desktop. No real Host, SSH, cloud account, production
canary, npm publication or release was used. All workstation CLI invocations
used a worktree-local `SPORADES_CONFIG_DIR`.

## Automated checks

```sh
npm run build
npm run typecheck
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" npm test
npm run docs:check
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" \
  node --test test/lifecycle-inventory.test.js test/monitoring-smoke-origin.test.js
SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" \
  node scripts/verify-host-inventory.mjs
node scripts/monitoring-stack-release.mjs .sporades/monitoring.tar.gz
```

Build, typecheck and docs checks passed. The focused inventory/recovery and
origin tests passed all eight checks. The integrated full suite completed with
2,898 tests: 2,693 passed, 205 optional skips, zero failures or cancellations.
`COPYFILE_DISABLE=1` prevents macOS
AppleDouble entries from contaminating existing archive fixtures.

The external-behavior tests cover exact Host authorization (including denial
for other scopes, UI and ingestion tokens), schema/target validation, duplicate
scope-token rejection, concurrent reordered revisions, logically identical
reordered JSON retries, stale/conflicting updates, explicit tombstones and
durable central restarts. Host helper processes verify outage catch-up,
concurrent queuing, acknowledgement interruption, address changes, opt-out,
stopped/deleted state, retained neighboring Hosted domains and fail-closed
corrupt/missing registries. Corrupt registry contents and credentials are not
exposed in errors or inventory. Recovery export/import follows the same
authority/revision rules, protects files and refuses export overwrites.

## Docker transport and stack readiness

`verify-host-inventory.mjs` builds the shipped gateway image and runs two
isolated Linux containers with independent named state volumes and verified
private-CA HTTPS. It publishes no ports and removes only its unique containers,
network, volumes and image. This verifies delivery from the bundled Host
helper, central persistence, released/running/stopped registry transitions,
release rollback, opt-out, deletion, stale/conflicting and cross-Host denial,
gateway outage retention and Host/gateway process/container restart catch-up.
The registry transitions are local authoritative-state fixtures; this is not
actual Capsule lifecycle acceptance on separate VMs.

A separate disposable Linux container checks generated systemd unit contents
with a `systemctl` fixture: repeated installation is idempotent, the timer declares
a boot start and a 60-second interval, the service has no Docker dependency,
and an operator-owned unit cannot be overwritten. It does not exercise a real
systemd boot.

A complete generated monitoring Compose stack also started with its pinned
services, protected configuration and inventory volume initialization. On a
task-owned loopback port, `/health` returned 200, returned 503 when the inventory
directory was made unsafe, and returned 200 after restoring mode 0700. The
gateway ran Node 24.13.0. The stack and its task-owned resources were removed.

The standalone schema-2 archive includes the inventory validator, durable store
and recovery utility; their bytes matched source. Generated CLI/helper/source
parity was checked by the build/test pipeline. The documentation server ran
on reserved port 5218; a real browser navigated from the Operations reference
to the new lifecycle inventory page and captured a full-page screenshot. The
server was stopped afterward.

## Remaining separate-VM acceptance

The manager must run these steps on two disposable VMs, with a third scoped
sender or local request fixture for authorization denial. Do not substitute a
production Host for the disposable sender.

1. Generate/install the Monitoring stack with a unique `INVENTORY_HOSTS` mapping
   and verified TLS. Install the upgraded CLI/helper on the Host and connect a
   profile with its exact inventory token/identity. Verify the inventory timer
   is enabled and that initial connection acknowledges the Host snapshot.
2. Register/deploy a real Capsule, then start, restart, roll back, stop,
   unregister/delete, opt out/in and change registered aliases. After each
   operation inspect stored central state and the Host acknowledgement. Repeat
   operations to prove unchanged snapshots do not create conflicting revisions.
3. Disconnect the workstation and change authoritative lifecycle state on the
   Host. Verify the timer reconciles without workstation imports and without
   making Capsule operations depend on Monitoring availability.
4. Stop Monitoring, change Host state and restart/reboot the Host. Confirm
   persisted pending state and retained central expectations; restore Monitoring
   and verify automatic catch-up and a fresh acknowledgement after both reboots.
5. Deliver reordered snapshots, a conflicting duplicate and a higher revision
   omitting an existing identity. Expect 409 with unchanged stored state. Use a
   different Host's token/path/body and UI/ingestion-only credentials; expect
   denial without changing either Host's inventory.
6. Reconnect/rotate the scoped credential while retaining the immutable Host
   identity. Back up and restore Host registry/outbox and central inventory,
   then verify idempotent retry, durable expectations and pending/stale status.

Probe scheduling and absence-alert delivery remain #120. No probe or alert
acceptance is claimed by this verification.
