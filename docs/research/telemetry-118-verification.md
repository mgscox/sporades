# Lifecycle inventory verification — #118

Round-two verification on 2026-10-03 used the regenerated Sporades 0.9.31
CLI/helper, Node 24.19.0, Docker Desktop and two disposable Ubuntu VMs. No
production Host, cloud account, production canary, npm publication or release
was used. SSH targeted only the task-owned VMs; Tower provided their hypervisor. All workstation CLI invocations
used a worktree-local `SPORADES_CONFIG_DIR`.

## DNS compatibility follow-up — 2026-10-03

The round-three regression first reproduced silent omission of both
`xn--bcher-kva.example` and `a--b.example` under the independent `host-one`
scope. Inventory validation now follows the existing Host DNS-label rules:
1–63 lowercase letters/digits/internal hyphens per label, 253 characters total,
including consecutive hyphens and ASCII punycode. Source, both shipped validators,
bundled CLI/helper, public type documentation and the generated manifest were
regenerated together. Tests cover canonical subnames, aliases, continued
neighboring Capsule updates, exact scope denial, malformed labels and sanitized
origin restrictions. The branch incorporates `main` at `d37a224f`.

On the merged branch, build, typecheck, generated-source checks and 33 focused
inventory/reconnect/relay/gateway/origin tests passed. `npm run docs:check`
passed 53 tests and the documentation build. The updated
`node scripts/verify-host-inventory.mjs` passed verified private-CA Docker
delivery, acknowledgement of supported names and 21 targets, neighboring updates,
authorization/revision denial and outage/restart recovery. Packed-CLI Container
CA acceptance passed one test; the legacy-CLI test was skipped because no legacy
CLI was supplied. Its disposable copy used ports 5689/5690 and a worktree-local
temporary directory; only port/root substitutions differed from the existing test.

A generated Monitoring Compose stack (`COMPOSE_PROJECT_NAME=barbara195-8528-1003`,
port 5691) passed trace and metric storage/query, readiness, supported-name
acknowledgements, neighboring updates, exact scope denial, sanitized-origin
rejection and inventory persistence after gateway restart. Playwright checked
the lifecycle reference on port 5688 at desktop and 390px width with no horizontal
overflow or application console errors; one favicon 404 was observed. All
task-owned servers and Docker resources were stopped/removed, including the
disposable stack credentials. Separate-VM acceptance was not rerun; the original
timestamps are preserved and the first disconnection claim is qualified below.

## Automated checks

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run build
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run typecheck
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" npm test
SPORADES_CONFIG_DIR="$PWD/.sporades/task-config" npm run docs:check
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" \
  node --test test/lifecycle-inventory.test.js test/host-inventory-reconnect.test.js \
  test/host-telemetry-relay.test.js test/monitoring-trace-stack.test.js \
  test/monitoring-smoke-origin.test.js
SPORADES_CONFIG_DIR="$PWD/.sporades/test-config" \
  node scripts/verify-host-inventory.mjs
node scripts/monitoring-stack-release.mjs .sporades/monitoring.tar.gz
```

Build, typecheck and docs checks passed. The focused checks passed 32 tests.
The complete round-two `npm test` exited zero with 2,901 tests: 2,696 passed,
205 optional skips, zero failures or cancellations. The gateway cancellation
regression now awaits separate backend response-close events with bounded
deadlines, instead of asserting an asynchronously updated flag immediately.
Reconnect tests deterministically interleave a sender with endpoint/CA/token
rotation and reject late acknowledgements, including same-endpoint rotation.
Both shared validators and a real central acknowledgement cover the canonical
origin plus all 20 aliases; 22 targets remain invalid.
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
on reserved port 5203; a real browser navigated from the Operations reference
to the lifecycle inventory page and captured desktop and 390-pixel mobile screenshots. The
server was stopped afterward.

## Disposable separate-VM acceptance

Completed on 2026-10-03 against code commit `fb3e9dc4`. Sanitized observations,
boot IDs, acknowledgement timestamps and worker evidence are recorded in
[the VM acceptance evidence](./telemetry-118-vm-acceptance.json).

Two task-owned KVM guests on Tower's existing private NAT network had independent
Ubuntu 24.04.5 disks and boot IDs: `dennis195-5cfb-host` and
`dennis195-5cfb-monitor`. Neither existing guests nor Tower services were changed.
The Host ran real Docker, Caddy, the shipped helper, bootstrap recovery units
and inventory timer. Monitoring ran the shipped inventory gateway and durable
store as a real systemd service on verified private-CA HTTPS. This exercises the
inventory subsystem on separate VMs; the complete generated Compose stack was
checked separately as described above. No probes or absence alerts are claimed.

The real todo Capsule was built locally and pushed with the actual CLI. The
unmodified repository base-image Dockerfile was built into a local archive and
loaded into the disposable Host because the default registry pull was denied.
Normal readiness deadlines, Docker lifecycle operations and Caddy route updates
were retained. The origin key used the documented Caddy group permissions.

1. Register `notes` with 20 `--alias-domain` options, connect the exact
   `apps.example` inventory profile, then `host push`, `start` and `restart`.
   Central HTTPS GET acknowledged 21 targets, including the canonical origin.
2. Push a distinct release with `--restart`, wait for that exact release in
   central state, then `host rollback notes <initial-release-id>`. Opt out/in,
   stop, unregister and register with `changed.example`, then start again.
   Every expected state/address transition reached central storage. A subsequent
   deployment and rollback explicitly verified distinct release IDs centrally.
3. PUT the acknowledged snapshot again (200); send stale, conflicting duplicate
   and higher-revision omission updates (409). Other-Host, ingestion-only and
   UI credentials were denied (403). The stored inventory remained unchanged.
4. Stop the Monitoring service. Schedule a **Host-local** systemd timer to invoke
   the actual helper's `host.telemetry.disable` operation and reboot the Host.
   The recorded mutation completed at `00:19:29.648Z`, before the recorded
   workstation disconnection at `00:19:48Z`; this interval does not establish
   that the mutation or reboot happened with management connections closed.
   The operation queued revision 15 against acknowledgement 14 and rebooted.
   Real boot recovery resumed the Capsule at the rolled-back
   release and queued revision 16. The timer remained enabled, retries reported
   opaque `network-or-tls`, and Monitoring retained revision 14 with two targets.
5. Schedule the Monitoring VM's reboot and close management connections. Its
   changed boot ID and retained disk established an actual reboot. Its enabled
   systemd gateway recovered; the Host timer automatically acknowledged revision
   16 at `00:22:21.935Z`, with no inventory import or manual reconciliation.
6. Repeat a healthy Host-local opt-in while every workstation management
   connection is closed (`00:24:08Z`–`00:24:59Z`). The mutation completed at
   `00:24:22.167Z`; the independent worker acknowledged revision 17 at
   `00:24:22.270Z`, inside that disconnected interval. Central state gained both
   expected targets.
7. Rotate the inventory token in the disposable Monitoring service and reconnect
   the Host at the same endpoint, CA and immutable scope. Its connection
   generation changed; revision 18 was acknowledged with `pending=false`.
   The revoked token and UI credentials returned 403. Stop, unregister and
   delete the task Capsule, retaining its explicit central tombstone.

The local orchestration used the normal `host` commands with `--host qa195
--json` and an isolated config; SSH reached only the disposable guests through
Tower. Delayed actions used `systemd-run --on-active=15s` and guest-local Node,
not a workstation process. Reboots used the guests' `systemctl reboot`.
No readiness limits or framework behavior were changed to make acceptance pass.
Earlier software-emulated and native macOS VM provisioning attempts were not
counted as acceptance; the successful observations above came from the KVM pair.

All task-owned VMs, disks, credentials, containers and tunnels were removed or
stopped after evidence collection. Existing LAN guests, services and unrelated
Docker containers remained untouched. Probe scheduling and absence-alert
acceptance remain #120.
