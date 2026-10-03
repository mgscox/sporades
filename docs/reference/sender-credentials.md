# Sender credential lifecycle

Run `sporades monitoring sender` locally in the **Monitoring server's generated
stack directory**. This manages one operator's sender connections; it supplies no
remote administration API. Each named sender gets a unique ingestion credential.
A Host sender also gets a separate inventory credential for one exact Host identity.
A workstation sender has ingestion only. Neither role grants dashboard, query,
Grafana administration, Capsule runtime or another Host's inventory authority.
Telemetry labels are not tenant isolation.

## Issue and connect

First generate the stack using `sporades monitoring stack init --dir ./monitoring`,
review its `.env`, and run `node setup.mjs` as documented in the stack README.
On the Monitoring server:

```sh
sporades monitoring sender issue --dir ./monitoring --sender host-a \
  --host capsules.example --json
sporades monitoring sender export --dir ./monitoring --sender host-a \
  --out ./host-a.env --json
```

Omit `--host` to issue ingestion-only workstation credentials. Use a different
name and inventory identity for each independent Host remote root. Issue retries
with the same name and scope preserve the existing credentials; changing a scope
or reusing a revoked name is rejected. Only one non-revoked named sender may own
an inventory identity.

The export creates a **new mode-0600 file** with `TRACE_INGEST_TOKEN`, optional
`HOST_INVENTORY_TOKEN`, and non-secret `SPORADES_SENDER_GENERATION`. It refuses to
overwrite a file or symlink and cannot write inside the credential registry.
Secrets never appear in human or JSON CLI output. Transfer the file through an
operator-controlled secure channel to the workstation configuring that Host.
Keep it out of Git, terminal transcripts, screenshots and Capsule Server env.
Load it into the configuring process without copying values onto a command line:

```sh
set -a
. ./host-a.env
set +a
sporades telemetry profile add host-a --endpoint https://monitor.example \
  --credential-env TRACE_INGEST_TOKEN --inventory-credential-env HOST_INVENTORY_TOKEN \
  --inventory-host capsules.example
sporades host telemetry connect --host personal --profile host-a --json
sporades host telemetry status --host personal --json
```

Use `--ca-file` when the Monitoring server uses a private certificate authority.
The Host's protected complete connection and relay configuration persist independently
of the workstation. Reconnect changes relay/export and inventory credentials; it
does not edit Capsule Sealed Server env, reset inventory revisions, restart
Capsules, or put the Monitoring credentials in their Bundles. Workstation Dev
sessions select the profile using `--telemetry host-a`; local Containers need a
redeploy to replace their saved launch credential. Restart Dev to read new process
environment values. Local sessions ignore the inventory reference.

## Rotate, verify, commit

```sh
sporades monitoring sender rotate --dir ./monitoring --sender host-a --json
sporades monitoring sender export --dir ./monitoring --sender host-a \
  --out ./host-a-next.env --json
```

Rotation reports `state: pending` and `pendingGeneration`. Both old and pending
credentials work during this bounded operator-controlled overlap. Repeated rotate
or export commands use the same pending generation. Export chooses pending when
present, otherwise active. An interruption before atomic publication keeps the
old configuration; an interruption afterward leaves the saved pending state.
Restarting the gateway or repeating stack setup preserves this state.

Securely transfer and load the new file, then reconnect the Host with the same
profile and inventory identity. Verify real traffic appears in stored metrics and
traces, run `sporades host telemetry check --host personal --json`, and confirm
`inventory.pending: false` with a current acknowledgement using Host telemetry
status. Use the existing inventory reconciliation workflow after an outage.
Only after verification, commit the **pending generation from status/export**:

```sh
sporades monitoring sender commit --dir ./monitoring --sender host-a \
  --generation 2 --json
sporades monitoring sender status --dir ./monitoring --sender host-a --json
```

Commit retires both old ingestion and inventory credentials on subsequent
requests. Repeating commit for that applied generation is a no-op; a stale
commit cannot finalize a later pending generation. Cancelled generation numbers
are never reused. To abandon a pending generation, run `sender cancel --sender
host-a --dir ./monitoring --json` and reconnect the sender using its old protected
handoff file. Cancel invalidates the pending tokens; retain the old file until
rotation completes. Other senders remain functional throughout.

## Revoke and migrate legacy connections

```sh
sporades monitoring sender revoke --dir ./monitoring --sender host-a --json
```

Revoke invalidates that named sender's active and pending ingestion and inventory
credentials. Repeated revocation is a no-op. Restart/setup cannot restore revoked
tokens. The name remains a tombstone; reconnecting requires issuing a new name.
Central acknowledged inventory and retained telemetry history remain intact;
revocation does not declare expected Capsules stopped/deleted or erase alerts.
Disable or disconnect the sender separately using existing Host controls if desired.

Existing `.env` values `TRACE_INGEST_TOKEN` and `INVENTORY_HOSTS` remain compatible
while migrating. They are **separate legacy credentials**, not aliases of a named
sender. After verifying a Host's new named connection, disable its old inventory
capability:

```sh
sporades monitoring sender legacy-revoke --dir ./monitoring \
  --host capsules.example --json
```

Once **all** senders sharing the old ingestion token have migrated, disable it:

```sh
sporades monitoring sender legacy-revoke --dir ./monitoring --ingest --json
```

This explicit final step affects every remaining user of the shared token; there
is no safe way to revoke just one user of a shared secret. These disable decisions
persist across setup/restart while leaving the operator `.env` byte-for-byte intact.
They do not disable named senders or unrelated legacy Host inventory mappings.

## Persistence, reload and recovery

The protected directory `.private/senders` contains `registry.json`, schema 1.
It is bounded to 1 MiB and 1,000 sender records; writes that would exceed these
limits fail before replacing working state. It stores named scopes, monotonic generation numbers, active/pending secrets,
revocation tombstones and legacy disable decisions. Back it up securely with
`.env`, `.private/credentials.json`, the inventory volume and Host connection/outbox.
Restore the latest registry: restoring an older backup can resurrect retired
credentials. Do not delete or regenerate the registry during an upgrade.

Writers hold `.private/senders/.lock`, write a mode-0600 temporary file, fsync,
atomically replace the registry, and fsync the directory. Live writers are never
evicted by a timeout. A killed writer may leave the lock: inspect `owner.json`'s
PID on that machine, confirm it has exited and no credential command is running,
then remove that lock directory and retry. Do not remove a lock belonging to a
live writer. Unpublished `.registry-*.tmp` files may be removed under the same
exclusive maintenance conditions; they never affect authorization.

The gateway mounts the **directory** read-only, so atomic replacement is visible
without recreating the container. It reads a validated protected snapshot for
requests and rechecks credentials after receiving uploads. Malformed, missing,
symlinked or publicly readable registries fail closed with an opaque 503 for
ingestion, inventory and health; fixing the file restores service. Already
forwarded requests cannot be withdrawn. UI authentication remains independent.
The host directory is mode 0700 and registry mode 0600; Linux root setup assigns
container-readable ownership to the existing gateway run identity.

An older generated stack needs a reviewed upgrade of `gateway.mjs`,
`sender-credentials.mjs`, `setup.mjs`, `Dockerfile.gateway`, `.dockerignore` and
`compose.yaml`, followed by setup and one gateway rebuild/recreation. `stack init`
preserves existing assets and overrides and does not silently perform this upgrade.
Stack schema 3 includes the sender module and directory mount. Normal rotations
then need no gateway restart. The container receives only the sender registry,
not exported handoff files or the Grafana admin password.

CLI JSON uses `{ ok, data, error }`. Data contains `schemaVersion`, `revision`,
`changed`, `legacyIngestEnabled`, `legacyInventoryDisabled`, and `senders` with
`name`, exact `host` or null, `state`, active `generation`, and nullable
`pendingGeneration`. `applied` describes the saved gateway-authorized generation;
it is not proof that a sender has adopted it. Check sender export and inventory
acknowledgements before commit. No credential hashes or values appear in status.

## Local acceptance

After building the repository, generate and start a disposable stack with a unique
Compose project and a free loopback port, then run:

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/acceptance-config" \
  node scripts/verify-sender-credentials.mjs ./disposable-stack \
  http://127.0.0.1:5280 sporades-acceptance-unique
```

The opt-in script accepts only a clean loopback origin. It issues two unique
acceptance senders, verifies real runtime traces in Jaeger and metrics in
Prometheus before/during/after rotation, inventory acknowledgements, gateway
restart, cross-scope/query denial, revocation and unrelated-sender continuity.
It revokes only its own senders and removes only its own handoff files on exit.
The operator owns stack startup/cleanup; the script restarts only the supplied
project's gateway. `SPORADES_ACCEPTANCE_CLI` can select an extracted npm package's
CLI for installed-package validation. Separate-VM verified-HTTPS Host relay and
workstation-disconnect validation remain the operator's deployment acceptance.
