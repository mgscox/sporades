# Telemetry 118 lifecycle inventory verification

This slice adds Host-owned desired inventory, exact Host-scoped gateway authority,
durable central acknowledgements, periodic outage/restart recovery and validated
manual recovery. It does not schedule probes, send absence alerts or add a remote
Capsule administration API. The native blocker #117 was closed when work began.

## Local evidence

Validation uses Sporades 0.9.31, Node 24.19.0 and local Docker Engine 29.8.0.
All Sporades commands use a worktree-local `SPORADES_CONFIG_DIR`. Real Host smoke
and optional real-provider test settings are disabled. No cloud, SSH-to-Host,
production, npm publication, Git tag or GitHub release operation was performed.

- `npm run build` regenerates dist/bin and the gateway inventory module from the
  shared TypeScript contract; public JSON declarations are shipped in
  `src/types/telemetry-inventory.d.ts`.
- `npm run typecheck` passes.
- Final full `npm test` passes: 2,883 tests, 2,679 passed, zero failed,
  204 skipped, zero cancelled. Duration: 1,204.6 seconds. The isolated fixture
  environment is described below; optional external/root acceptance remains skipped.
- Focused gateway/Host/profile checks pass: versioned stored snapshots, identical
  retry acknowledgement, stale/conflicting revisions, exact authority denial,
  sanitized targets, concurrent separate writers, HTTPS sender process restarts,
  outages/reconnect, deletion tombstones, manual recovery and protected state.
- Host-helper checks drive actual supported registration, deploy, start, restart,
  rollback, stop, opt-out, unregister, delete and alias-change paths with local
  Docker/Caddy fakes. They inspect the durable desired journal, without importing
  ordinary lifecycle inventory or requiring monitoring network availability.
- `node scripts/verify-host-inventory.mjs` passes against a disposable Linux
  gateway container built from the distribution Dockerfile, with verified TLS and
  its own persistent volume. It verifies acknowledgement/replay, stale and
  conflicting revisions, denied cross-Host/ingestion authority, lifecycle state,
  gateway restart retention, opt-out and deletion. It removes only its own
  container, volume and image, and publishes no Host port.
- `npm run monitoring:release-asset -- <worktree-local-tar-path>` generates a local
  archive containing inventory code/recovery, Compose wiring and Dockerfile assets.
  This command does not publish a release.
- `npm run docs:check` passes. The operations reference renders at the reserved
  local development port 5218. Playwright desktop and 390px phone captures show
  the inventory guidance; the final console has one existing favicon 404 and no
  inventory-page errors. The server and
  browser session were stopped.

Full-suite validation keeps temporary configuration inside the worktree. Its
fixture-only preload shortens `mkdtemp` names created by tests to fit macOS Unix
socket limits, and gives the standalone ESM-artifact fixture its module boundary.
Application-created temporary paths and deployed runtime code are not altered.
CommonJS and neutral TypeScript boundaries in the temporary root prevent fixtures
from inheriting the repository's package/strict compiler settings and preserve
existing executable fakes;
`COPYFILE_DISABLE=1` prevents macOS metadata in fixture archives. These environment
accommodations are local validation setup, not a product feature or a waiver of
behavior checks. The unadapted worktree-local run exposed those fixture environment
failures; the adapted full run is the final validation record in the PR.

## Manager verification still required

Real separate-VM acceptance is not claimed by local fakes or Docker. On disposable
VM A (Host) and VM B (Monitoring), using the packaged CLI/generated stack:

1. Review/install the inventory assets, protected authority map and inventory volume
   on B. Use separate independent tokens for two Hosts and verified public/private
   CA TLS. Check readiness depends on writable protected inventory storage.
2. Upgrade/bootstrap A, reconnect using the inventory credential reference, and
   verify the inventory timer is installed/enabled. Disconnect the workstation.
   Connect with zero Capsules and confirm a durable expected Host exists on B.
3. Register and deploy Capsules, start/restart/rollback, stop, unregister/delete,
   opt out/in, and change supported aliases/addresses. Read centrally acknowledged
   snapshots after each operation; ordinary lifecycle commands need no import.
4. Replay/reorder saved revisions and conflicting duplicates. Attempt another
   Host's URL/body with A's token, and use ingestion/UI credentials. Expect denial
   without changing either central record. Rotate/revoke only A's token and ensure
   B retains A's acknowledged expectations.
5. Interrupt the A-to-B link, change lifecycle state while disconnected, restart
   the sender/Host and B, then reconnect. Check Capsule operations remained
   available, the timer sent the latest authoritative state, acknowledgement and
   pending/stale status are accurate, and old revisions cannot reverse it.
6. Test Host-journal and central-volume backup/restore and the recovery-only
   export/import tools. Preserve Host identity and revisions. Remove no central
   expectations merely because a Host disappears. Restore/revoke test authorities
   and dispose of only the created infrastructure after evidence capture.

The approved scope leaves independent probes and absence-alert delivery to ticket
13. The inventory namespace is the authenticated Host installation/remote root;
all its Hosted domains are scanned, including when the timer belongs to one domain.
Existing ingestion-only connections require the documented inventory migration.
Non-systemd Hosts require explicit scheduling of the same helper entry point.
