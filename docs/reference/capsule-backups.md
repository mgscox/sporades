# Capsule data backups and restore rehearsals

`sporades host backup` is an opt-in Host operation for standard Hosted Capsule
SQLite data and local `files/` bytes. Existing Capsules and Host profiles keep
their current behavior until backups are configured. This ships within the
Sporades 0.9.x line and requires no Capsule API changes.

Backups use [restic](https://restic.readthedocs.io/en/stable/) for authenticated
encryption, repository locking, local-directory and S3-compatible storage, and
retention. Install restic on the Host server first (0.19.1 was verified). The
CLI never installs packages, initializes repositories, creates buckets, or
creates encryption keys implicitly. Restic exit failures, including incomplete
backups, fail the command and do not advance backup freshness.

## Configure a target

The operator first initializes an encrypted restic repository on the Host server.
Keep its password in a helper-user-owned `0600` file, outside Capsule data, and
keep an independent offline copy of the password. Losing every repository key
makes restore impossible. Ancestor directories must be owned by root or the
helper user and must not be group/other writable; symlinks are rejected.

For a local target, initialize a directory outside `hosts/`:

```sh
# On the Host server, using an existing protected password file:
restic --repo /srv/capsule-backups --password-file /root/backup-password init
```

Create a local policy JSON file containing **Host-server paths**, then apply it
through your selected Host profile:

```json
{
  "repository": "/srv/capsule-backups",
  "passwordFile": "/root/backup-password",
  "schedule": "daily",
  "retention": 14,
  "maxAgeHours": 26
}
```

```sh
sporades host backup configure --host production --file backups.json --json
```

The applied policy is stored as `backups` in the local Host profile and atomically
under `<remote-root>/hosts/<domain>/backups/policy.json`. Secret file contents
stay on the Host server. The helper must be able to read those files unattended.
Policy fields are closed and validated: `schedule` is `hourly`, `daily`, `weekly`,
or `null`; `retention` is 1–10000 snapshots **per Capsule**; optional
`retentionDays` is an integer 1–3650; `maxAgeHours` is 1–87600. `null` disables
an existing timer and keeps manual backups available.
Choose a stale threshold longer than the schedule plus normal upload time.

### Retention by count and by age

`retention` alone keeps the newest *n* snapshots of each Capsule (restic
`--keep-last <n>`). Every snapshot uses a slot, so manual `host backup create`
runs, restore-rehearsal preparation and `Persistent=true` catch-up runs shorten
the period a daily timer covers. To express "keep 30 days of backups", add
`retentionDays`:

```json
{
  "repository": "/srv/capsule-backups",
  "passwordFile": "/root/backup-password",
  "schedule": "daily",
  "retention": 14,
  "retentionDays": 30,
  "maxAgeHours": 26
}
```

Prune then runs `restic forget --keep-last <retention> --keep-within <retentionDays>d`
for that Capsule's tag. restic keeps a snapshot when **either** rule keeps it, so
the policy never retains less than the count rule alone. Every snapshot within
`retentionDays` days of the Capsule's **newest** snapshot is retained, however
many manual or catch-up snapshots exist; older snapshots are removed once they
also fall outside the newest `retention` snapshots. Because the window is
measured from the newest snapshot rather than the current time, pruning a
Capsule whose backups have stopped (for example, after it was deleted or while
its backups fail) keeps its last window instead of pruning towards nothing. Use `"retention": 1` when only the day window
should apply; the newest snapshot is always kept.

`retentionDays` is optional and policies without it prune exactly as before.
`host backup status --json` reports the effective rule as
`retention: { "keepLast": <n>, "keepWithinDays": <days> | null }` and prune
results include `retentionDays` when it is configured. Upgrade the Host helper
before applying a policy with `retentionDays`; an older helper refuses the
unknown field and keeps its existing policy. Remove the field and reconfigure to
return to count-only retention. Repository storage grows with the number of
snapshots in the window, deduplicated by restic.
Reapplying configuration is safe and reconciles the timer. Retry a failed timer
installation; its persisted policy is retained for recovery.

For Hetzner Object Storage or another S3-compatible service, use
`"repository": "s3:https://<endpoint>/<bucket>/<prefix>"` and add
`"credentialsFile": "/root/backup-s3.json"`. Initialize that exact repository
with restic first. The protected `0600` JSON credential file accepts only
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`
and `AWS_DEFAULT_REGION`, all nonempty strings. Use a dedicated bucket/prefix and
credentials scoped to it. Repository URLs cannot contain credentials, query
parameters or fragments. HTTP targets are rejected. Ambient AWS/restic settings
and metadata-service credential discovery are disabled for helper operations.
Local repositories can also be copied off-host with an operator-owned process.
SFTP/Storage Box transport is deferred; the CLI accepts only local and HTTPS S3
repositories in this patch.

## Create, inspect and prune

```sh
sporades host backup create --host production --subname tickets --json
sporades host backup list --host production --subname tickets --json
sporades host backup status --host production --json
sporades host backup prune --host production --subname tickets --json
```

Create holds the Capsule lifecycle lock, checks Docker ownership labels and the
exact container/release ID, and gracefully stops a running container. A running
or interrupted runtime must match the current release; otherwise create fails
before stopping or resuming it. Restart that Capsule deliberately on the intended
release first. This prevents a scheduled backup from activating a release that
was pushed without restart. Release pointers must agree with registry state;
reconcile any interrupted deployment before backing up. With the writer
stopped it uses SQLite `VACUUM INTO`, copies uploaded files, checks SQLite
integrity, and builds a versioned manifest containing the source domain/subname,
release ID, creation time, schema hash (SHA-256 of ordered SQLite schema
statements), every regular-file SHA-256 and the directory inventory. Symlinks,
hard links and special files are rejected. The original container resumes before
the encrypted repository upload. Expect a write outage during the snapshot and
file copy; Caddy may return an unavailable response during that interval.

Stopped Capsules remain stopped. An interrupted create retains a protected
resume journal; retrying create resumes only that exact container before retrying.
If Docker cannot resume it, inspect Docker and run `host start` explicitly. Normal
start/stop clears obsolete backup resume evidence. A successful backup has a full
64-character restic snapshot ID; list returns IDs and times scoped to the source
Capsule. Create and restore return a compact manifest summary with file/directory
counts; the encrypted snapshot retains the complete checksum inventory. Prune
keeps the latest `retention` snapshots for that Capsule, plus every snapshot
within `retentionDays` of its newest snapshot when configured, and reclaims
unreferenced repository bytes. Listing and pruning retained backups also work
after the source Capsule has been deleted. Restic owns repository concurrency locking.

The systemd timer runs each registered Capsule with a deployed release in
sequence. Each successful create is followed by retention pruning; a failed
create never triggers pruning for that Capsule. Other Capsules still run.
Inspect `journalctl -u sporades-backups-<identity>.service`; configure reports the
exact timer name. `Persistent=true` catches a missed invocation after downtime.
Backup execution orders after Capsule boot recovery so a catch-up snapshot cannot
hold a lifecycle lock ahead of autostart.
The timer calls the installed helper, so helper upgrades automatically carry the
backup implementation forward. Bootstrap does not enable backups by default.

## Restore-rehearsal runbook

1. Record `host backup list --subname tickets --json`, the full chosen snapshot
   ID, its expected release and recovery point. Keep repository access and the
   encryption password available independently of the lost Host server.
2. From the intended Capsule project, register a new staging subname, push the
   matching source release/configuration, and leave it stopped. For example:
   `sporades host register tickets-rehearsal --host production`, then
   `sporades host push --host production --subname tickets-rehearsal` without
   `--restart`. Review staging Server env, public access and external integrations
   before starting restored Jobs or webhook handlers.
3. Stop the destination explicitly if it has run before:
   `sporades host stop tickets-rehearsal --host production`.
4. Restore with the source identity, full snapshot ID and exact destination
   confirmation:

   ```sh
   sporades host backup restore --host production --subname tickets \
     --to-subname tickets-rehearsal --id <64-character-snapshot-id> \
     --confirm tickets-rehearsal --json
   ```

5. Check the returned manifest/release ID/schema hash, then start the staging
   Capsule deliberately: `sporades host start tickets-rehearsal --host production`.
   Run `host health tickets-rehearsal --json`, inspect representative records and
   download representative files. Record the recovery point and elapsed restore
   time; rehearse with every significant schema or storage change.
6. Stop/delete the rehearsal Capsule when finished, retaining the original
   backup. For an in-place restore, omit `--to-subname`, stop the source first,
   and pass `--confirm tickets`. Create a new backup of the destination before
   replacing existing data when it must remain recoverable.

Restore verifies restic authentication, exact Capsule scope, every manifest
checksum, the directory inventory, SQLite integrity and schema hash **before**
replacing destination data. It never starts the target automatically. The target
must already be registered with an intended deployed release; releases are not
selected or migrated by the backup command. The manifest schema hash describes
the restored database; the operator must choose compatible release code.

Only `data.db` and `files/` are replaced; old SQLite WAL, SHM and rollback journals
are discarded. Target-owned Sealed Server env keys and
other runtime state are retained; source Host credentials and release files are
not imported. A protected journal and same-filesystem directory renames make
interruption recovery idempotent: an uncommitted swap rolls back, a committed
swap finishes cleanup. Retrying restore, creating the next backup or starting the
Capsule settles its journal while the runtime is stopped. Temporary plaintext
snapshots are private Host-owned directories removed after settlement; an
interrupted create is cleaned up by its next attempt.
When no restore journal exists, start and restart retain the ordinary Host path
policy, including root-owned sticky ancestors such as `/tmp`. An existing
journal still requires the strict backup ownership, permissions and no-symlink checks.

This is Capsule data recovery, not full Host disaster recovery. Preserve release
bundles, registry state, Host profiles, sealed environment key material, backup
passwords and monitoring sender state independently. External database/storage
services and custom file storage paths are rejected rather than producing partial
backups. A restore preserves database auth/session and Job state as part of the
data; staging must use appropriate operator-owned configuration.

## Freshness diagnostics and alerts

`host health <subname> --json` and Hosted `doctor` expose `backups.lastBackupAt`,
`ageSeconds`, `maxAgeSeconds` and `stale`. Host-wide health includes Capsule ages
when its local profile has backups configured. `host backup status --json` works
without a healthy Capsule route. Missing backups are stale immediately;
changing repositories invalidates previous local freshness evidence. Freshness
records the last completed backup, not a continuously verified off-host copy;
use restore rehearsals and restic repository checks to verify ongoing storage.

With Host resource telemetry enabled, run `host telemetry reconcile` after
upgrading the helper to activate the node_exporter textfile collector. It reads
only numeric backup freshness samples from `<remote-root>/backup-metrics` and
exports `sporades_backup_last_success_seconds` and
`sporades_backup_max_age_seconds` with Capsule identity labels. The helper
explicitly sets that directory to `0755` and completed metric files to `0644`
before atomic publication so the unprivileged exporter can read scheduled
updates. Exporter setup and reconciliation also enforce `0755`, even under
`UMask=0077` on Hosts without configured backups. The backup service retains
`UMask=0077`; backup policy, credentials and
staging data stay private. The monitoring
stack's `SporadesCapsuleBackupStale` alert fires when the threshold is exceeded
for five minutes. Upgrade the monitoring stack's rule assets too. Existing Host
telemetry absence alerts cover lost transport. Unconfigured Hosts emit no backup
samples or stale-backup alerts.

Local verification uses real encrypted restic repositories and fake Docker/SSH.
Before trusting a new provider, perform this rehearsal on disposable infrastructure,
verify timer execution across a reboot, S3 credential failure/recovery, and real
monitoring notification delivery. No production canary is required to install the
opt-in CLI feature.
