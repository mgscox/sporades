# Monitoring stack maintenance

Use the installed Sporades CLI from a trusted package release to upgrade,
roll back generated stack files, and make cold backups or restores. These
commands operate on the standalone Monitoring stack; they do not migrate
Capsule product databases or Capsule data.

## Requirements and protection

Run maintenance with all stack services stopped. Stop them with the same
Compose project name and environment file used to start them:

```sh
cd /srv/sporades-monitoring
COMPOSE_PROJECT_NAME=sporades-monitoring-prod docker compose --env-file .compose.env stop --timeout 30
```

Use one unique `COMPOSE_PROJECT_NAME` consistently for Sporades maintenance,
Compose `up`, `stop`, `restart`, and any `down` command. It selects the named
volumes that contain the history. Do not run `down -v` on a production stack.
The package commands use `.compose.env` and inherit `COMPOSE_PROJECT_NAME` from
their environment.

Keep the stack directory and all private state owned by the invoking user, with
no group/world write permission. `.maintenance/` and backup directories must be
mode `0700`; archive files and `.env` must be `0600`. The backup contains
credentials and should be encrypted with a trusted offline method for retention
or transfer. SHA-256 checks detect accidental damage or mismatch; they do not
prove who created a backup or make an untrusted backup safe.

The default named storage volumes are `traces` (Jaeger Badger), `metrics`
(Prometheus), `grafana`, and `inventory`. Backups also include the stack
configuration and private files, including `.env`, `.compose.env`,
`.private/senders`, credentials, certificates, and overrides. They preserve
numeric UID/GID and mode metadata. Restore with the same Linux identity mapping and backend image versions; macOS Docker Desktop drills do not establish cross-platform storage migration. The maintenance path supports only these
default named backend volumes. It rejects external/custom volumes and custom
backend bind mounts. An optional Collector persistent queue lives in a separate
quota-limited directory and is excluded: it is a delivery queue, not retained
trace or metric history. Drain it or preserve that quota directory separately
when its queued data matters.

## Upgrade and rollback

Use a package release whose contents you trust. The command updates generated
stack files only, validates the resulting Compose configuration before
publishing, and reports operator-edited overrides it preserves. It does not
start services.

Upgrade and rollback retain the replacement assets and effective configuration
used for planning. An operator edit during validation causes maintenance to
fail before publication, preserving the edit. Finish editing and retry so the
updated configuration is planned and validated together.

Backend validation uses the effective Compose bind sources for Collector,
Jaeger, Prometheus and its pipeline rules, plus availability/performance rule
mounts when present and Jaeger's effective
`TRACE_RETENTION` environment. Configuration bind files must be read-only regular
files inside the stack directory. Custom configuration filenames in that tree
are supported. Command or entrypoint overrides, additional backend environment
keys, Compose secrets/configs, and unsupported configuration mounts are rejected
before publication; retain the shipped invocation and edit supported files or
`.env` settings instead. Older supported pipeline-only generations can roll back
without availability/performance mounts. Referenced rules must still exist in
the validator's mounted configuration; Prometheus rejects missing references.

```sh
COMPOSE_PROJECT_NAME=sporades-monitoring-prod sporades monitoring stack upgrade --dir /srv/sporades-monitoring
```

A schema-4 manifest with asset hashes provides the baseline. For an older
manifest without hashes, pass `--baseline` pointing to the exact prior trusted
schema-3 release directory; the package version and schema must match the
installed manifest. Do not use an approximate copy or an untrusted baseline.

```sh
COMPOSE_PROJECT_NAME=sporades-monitoring-prod sporades monitoring stack upgrade \
  --dir /srv/sporades-monitoring --baseline /srv/releases/sporades-previous/monitoring/trace
```

Rollback restores the prior generated files only when they still match the
recorded post-upgrade hashes. This cannot undo a backend image's data-schema
change. Before an upgrade that could change backend storage, make a cold backup.
If backend rollback requires an incompatible older schema, restore that
pre-upgrade backup and use the same backend image versions captured by that
backup on the first restore.

```sh
COMPOSE_PROJECT_NAME=sporades-monitoring-prod sporades monitoring stack rollback --dir /srv/sporades-monitoring
```

Generated stack assets and `stack-manifest.json` are published with explicit
mode `0644`, including under systemd `UMask=0077`. Stack initialization also
sets newly copied public assets to `0644` when package extraction narrowed their
source permissions. Existing operator files keep their permissions. Candidate
and backup copies preserve each source file mode independently of umask,
including private modes. The publication journal records that same intended
mode; interrupted recovery preserves the original recorded
mode and ownership. `.env`, `.compose.env`, credentials, maintenance journals and
backup archives remain private (`0600`); protected state directories use `0700`.
Operator overrides are preserved. Restores use the snapshot's recorded modes.

Maintenance holds an OS-owned SQLite writer lock in `.maintenance/lock.sqlite`.
It releases on process exit, including SIGKILL; a concurrent invocation fails
closed. The next upgrade or rollback restores the durable generated-file journal
before planning new changes. Original bytes and original/intended hashes,
permissions and owners are recorded before publication. Recovery checks every
journalled file before restoring any. Operator edits, deletions or permission/
owner changes refuse recovery, preserving all files and the journal. Keep services
stopped, save overrides separately, and reconcile journalled files with their
recorded original generation before retrying; reapply saved overrides afterward.
Legacy journals without intended hashes require every file to already match its
original bytes; otherwise recovery refuses and preserves the files and journal.
Repeated rollback remains at the restored version.
Do not remove lock databases, journals or other maintenance state by hand.

Restore also acquires one atomic Docker container-name guard per backend volume,
shared across target directories and workstations on the selected daemon.
Competing restores fail closed. These helpers release on owner exit, including
SIGKILL. Restore rechecks the exact snapshot label after volume creation and
immediately before extraction; Docker creation success alone never grants
ownership. Stop unrelated writers and avoid manual volume changes during restore.

## Cold backup

Stop the services as above and choose a new backup path outside the stack
directory and its parent tree. The command never overwrites an existing backup.
Archive files are created by the invoking operator with mode `0600` before the
root container writes tar bytes. Linux non-root operators retain file ownership;
archived backend numeric UID/GID and modes are preserved independently.
It stages the archive in a protected `.partial-*` directory, validates it, and
publishes only after completion. A handled failure cleans its own staging path;
a crash may leave a protected `.partial-*`. Inspect it and remove it only when
you have confirmed it belongs to this task and no helper still owns it.

```sh
COMPOSE_PROJECT_NAME=sporades-monitoring-prod sporades monitoring stack backup \
  --dir /srv/sporades-monitoring --backup /srv/secure-backups/monitoring-2026-10-04
```

Copy or encrypt the completed backup using your normal protected backup
procedure. Never put the backup under the stack directory. Its checksums provide
integrity checking, not authenticity.

A restore reinstates authentication and expected-target state from backup time.
Keep the restored gateway private until you reapply any later credential
revocations, reconcile current Host desired state, and verify both allowed and
denied credentials. Snapshot checksums do not authenticate an untrusted archive.

## Restore drill

Restore requires a fresh, empty target directory. Choose a unique Compose
project name for the restored instance and keep it identical for restore and
every later Compose command. The restore creates snapshot-labelled volumes,
refuses pre-existing unrelated volumes, verifies the snapshot and archive
members, and resumes only the same snapshot after interruption. It does not
start services. Do not edit restored configuration until restore completes.

```sh
install -d -m 700 /srv/monitoring-restore-drill
COMPOSE_PROJECT_NAME=sporades-restore-drill sporades monitoring stack restore \
  --dir /srv/monitoring-restore-drill \
  --backup /srv/secure-backups/monitoring-2026-10-04
```

Use the package's pinned image tags from the restored Compose files for the
first restore. After completion, bring the stack up with the same project name
and env file:

```sh
cd /srv/monitoring-restore-drill
COMPOSE_PROJECT_NAME=sporades-restore-drill docker compose --env-file .compose.env up -d
```

Verify readiness, then query a trace ID known to exist before backup, a known
Prometheus metric series and its expected historical range, and the expected
Host/Capsule inventory identities and acknowledged revisions. Restart the
Collector, Jaeger, Prometheus, Grafana, and gateway with that same project name;
repeat the known-history queries. Confirm that a deliberately invalid or
revoked ingestion credential is denied and that valid credentials still work.
Use the normal authenticated smoke flow from [README.md](README.md) for a new
trace and metric write. Record the operator, package version, image tags,
project name, test identities, query results, and any gaps. This is a local
restore drill; it does not establish separate-VM or production Host acceptance.

## Host export opt-out and agent removal

`exports-disable` persists `exportsDisabled` on the Host and stops the relay.
This central policy opts all current and future Hosted Capsules out of resource
and trace export without overwriting each Capsule's own opt-out. Existing
Capsules need their normal restart before already-running SDK instrumentation
reflects the disabled setting.

Failed or interrupted shutdown retains the disabled intent. Retry
`sporades host telemetry reconcile` to stop the owned relay and resource
exporter, repairing any reported Caddy or Docker failure first. Credentials and
the inventory reconciler remain available for acknowledgement. Failed reconnect
preserves the previous connection's disabled export policy.

```sh
sporades host telemetry exports-disable --host personal --json
sporades host telemetry status --host personal --json
```

`remove-agents` is a separate, acknowledgement-gated action. It first requires
a fresh exact inventory acknowledgement of the disabled state. If inventory
delivery is unavailable, stale, or rejected, removal fails and the worker and
credentials remain in place. On success it removes the Host-owned relay,
node_exporter, and generated inventory timer. It retains protected Telemetry
connection state, credentials and inventory outbox, plus central trace, metric,
inventory, and Capsule data.

```sh
sporades host telemetry remove-agents --host personal --json
```

Reconnect deliberately re-enables export and retains prior per-Capsule opt-outs:

```sh
sporades host telemetry connect --host personal --profile monitoring-prod --json
```

## Acceptance boundary

The stack's supported maintenance platform is Linux `amd64`/`arm64`, Docker
Engine 29.x, Docker Compose 2.40.3 or later, and Node.js 22.13 or later for
setup and smoke scripts. macOS with Docker Desktop is for local validation only.
A successful local Docker restore or automated test does not claim a real Host,
reboot, or separate-VM drill. Record those as pending until their evidence is
captured.
