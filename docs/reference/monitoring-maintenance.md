# Monitoring stack maintenance

The Monitoring stack has a separate lifecycle from Host servers and Capsules.
Use a trusted installed Sporades package to maintain its generated files and
protected storage. These commands do not migrate backend product data or Capsule
data.

## Commands

Run every operation against the generated stack directory:

```sh
sporades monitoring stack upgrade --dir /srv/sporades-monitoring
sporades monitoring stack rollback --dir /srv/sporades-monitoring
sporades monitoring stack backup --dir /srv/sporades-monitoring \
  --backup /srv/secure-backups/monitoring-2026-10-04
sporades monitoring stack restore --dir /srv/monitoring-restore-drill \
  --backup /srv/secure-backups/monitoring-2026-10-04
```

For a stack manifest created before generated asset hashes were recorded,
`upgrade` requires `--baseline <path>` to the exact prior trusted schema-3
release directory. The baseline manifest's package version and schema must
match. Do not substitute a similar or untrusted directory.

Upgrade and rollback retain a snapshot of replacement assets and effective
configuration before validation. Edits made during validation cause maintenance
to fail before publication, preserving the operator's changes. Finish those
edits, then retry so the updated configuration is planned and validated together.

Backend validation uses the effective Compose bind sources for Collector,
Jaeger, Prometheus and Prometheus rules, plus Jaeger's effective
`TRACE_RETENTION` environment. Configuration bind files must be read-only regular
files inside the stack directory. Custom configuration filenames in that tree
are supported. Command or entrypoint overrides, additional backend environment
keys, Compose secrets/configs, and unsupported configuration mounts are rejected
before publication; retain the shipped invocation and edit supported files or
`.env` settings instead.

Maintenance requires stopped services. Use the same unique
`COMPOSE_PROJECT_NAME` for `backup`, `restore`, `up`, `stop`, restart, and any
`down` operation; the project name selects the persistent volumes. For example:

```sh
COMPOSE_PROJECT_NAME=sporades-monitoring-prod docker compose --env-file .compose.env stop --timeout 30
COMPOSE_PROJECT_NAME=sporades-monitoring-prod sporades monitoring stack backup \
  --dir /srv/sporades-monitoring --backup /srv/secure-backups/monitoring-2026-10-04
```

Never use `down -v` on production. Keep backups outside the stack directory.
Backup paths must not overlap the stack directory or its parent tree. Backups
are secret-bearing: directories use mode `0700`, archives and `.env` use
`0600`, and metadata records original numeric UID, GID, and mode. Encrypt
backups with a trusted offline method before retaining or transferring them.
SHA-256 checksums establish integrity only, not authenticity.
Archive files are created by the invoking operator with mode `0600` before the
root container writes tar bytes. Linux non-root operators retain file ownership;
archived backend numeric UID/GID and modes are preserved independently.

## What is preserved

The backup contains the named `traces` (Jaeger Badger), `metrics`, `grafana`,
and `inventory` volumes, along with stack configuration and private files,
including `.env`, `.compose.env`, `.private/senders`, credentials, certificates,
and overrides. It does not contain application/backend product data migrations.
Only the default named backend volumes are supported; external volumes and
custom backend bind mounts are rejected. Optional Collector persistent queue
files are separate quota-limited delivery state, not trace or metric history;
drain or preserve that directory separately if needed.

Upgrade and rollback apply generated files only. They preserve operator-edited
overrides and validate the candidate Compose configuration before publication.
Rollback checks recorded hashes before restoring the previous generated files.
It cannot reverse backend data-schema changes. Take a cold backup before a
potentially incompatible backend update; restore with the same backend image
versions as the snapshot first, then plan any image change separately.

Maintenance holds an OS-owned SQLite writer lock in `.maintenance/lock.sqlite`.
It releases automatically on process exit, including an interrupted operation.
A concurrent maintenance process fails closed. The next upgrade or rollback
recovers the durable file journal before applying a new change. The journal
records original bytes and the original/intended hashes, permissions and owners
before publication. Recovery checks every journalled file before restoring any:
an operator edit, deletion or permission/owner change refuses recovery and
preserves all files and the journal. Keep services stopped, save overrides
separately, and reconcile journalled files with their recorded original generation
before retrying; reapply saved overrides after recovery. Older journals without
intended hashes can only be retired when every file already matches its original
bytes; otherwise recovery refuses with the same preservation guidance. Do not
remove lock databases or journals by hand. Backup never overwrites
an existing destination. Failed work cleans its unpublished `.partial-*` path;
a crash can leave a protected partial path to inspect and remove only after
confirming it is task-owned and inactive.

Restore also acquires one atomic Docker container-name guard per backend volume,
shared across target directories and workstations on the selected daemon.
Competing restores fail closed. These helpers release on owner exit, including
SIGKILL. Restore rechecks the exact snapshot label after volume creation and
immediately before extraction; Docker creation success alone never grants
ownership. Stop unrelated writers and avoid manual volume changes during restore.

A restore reinstates authentication and expected-target state from backup time.
Keep the restored gateway private until you reapply any later credential
revocations, reconcile current Host desired state, and verify both allowed and
denied credentials. Snapshot checksums do not authenticate an untrusted archive.

## Restore procedure

Restore needs a fresh empty target. It validates checksums and archive members,
refuses unrelated existing volumes, and resumes only the same snapshot into
snapshot-labelled volumes. It does not start services. Do not edit the restored
configuration before restore completes. On the first restore, retain the
snapshot's backend image versions.

```sh
install -d -m 700 /srv/monitoring-restore-drill
COMPOSE_PROJECT_NAME=sporades-restore-drill sporades monitoring stack restore \
  --dir /srv/monitoring-restore-drill \
  --backup /srv/secure-backups/monitoring-2026-10-04
cd /srv/monitoring-restore-drill
COMPOSE_PROJECT_NAME=sporades-restore-drill docker compose --env-file .compose.env up -d
```

Check health, query a known trace, verify a known metric series and historical
range, and compare expected inventory identities and acknowledgement revisions.
Restart Collector, Jaeger, Prometheus, Grafana, and gateway using the same
project name, then repeat those history checks. Verify a deliberately invalid or
revoked ingestion credential is denied and a valid credential is accepted.
Finish with the authenticated smoke `send` and `query` steps in the
[Monitoring stack README](https://github.com/mgscox/sporades/blob/main/monitoring/trace/README.md). Record the
operator, package version, pinned image versions, project name, known query
identities, and observed results.

Local Docker or automated test evidence is not a real Host, reboot, or
separate-VM acceptance drill. Leave those checks marked pending until run and
recorded on their actual target.

## Host Telemetry opt-out and removal

Disable exports centrally before removing Host agents:

```sh
sporades host telemetry exports-disable --host personal --json
sporades host telemetry status --host personal --json
sporades host telemetry remove-agents --host personal --json
```

`exports-disable` persists `exportsDisabled`, stops the relay, and opts all
current and future Hosted Capsules out of telemetry/resource exports. It does
not replace per-Capsule opt-out state. Existing running Capsules reflect the
disabled instrumentation after their normal restart.

If shutdown fails or is interrupted, the disabled intent remains durable.
Retry `sporades host telemetry reconcile` to stop the owned relay and resource
exporter; repair any reported Caddy or Docker failure and retry again. Credentials
and the inventory reconciler remain available for acknowledgement. A failed
reconnect preserves the previous connection's disabled export policy.

`remove-agents` requires a fresh exact inventory acknowledgement for the
disabled snapshot. Inventory outage, stale state, or rejected acknowledgement
keeps the worker and credentials in place. A successful removal deletes the
Host-owned relay, node_exporter, and generated inventory timer, while retaining
protected Telemetry connection state, credentials and outbox, central history,
and Capsule data. Reconnecting with `sporades host telemetry connect` is a
deliberate re-enable; earlier per-Capsule opt-outs remain in effect.

## Platform

Supported maintenance systems are Linux `amd64`/`arm64`, Docker Engine 29.x,
Docker Compose 2.40.3 or newer, and Node.js 22.13 or newer for setup and smoke
scripts. macOS Docker Desktop is for local validation only.
