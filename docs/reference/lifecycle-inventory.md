# Automatic lifecycle inventory

Connected Hosts automatically queue monitoring inventory after registration,
deploy, start/restart/rollback, stop, unregister/delete, opt-out and registered
address changes. The authoritative Host registry supplies each snapshot;
Capsule operations make no monitoring HTTP request. A separate systemd timer
reconciles every 60 seconds after outages/reboots without the workstation.
Probe scheduling and absence-alert delivery remain ticket #120.

## Authority and installation

The identity is the Telemetry profile's optional `--inventory-host <id>`, defaulting
to the first Hosted domain used to connect a Host remote root. It is persisted as `telemetry/connection.json.inventoryHost`. Workstation aliases and
later Hosted domains do not change it. All Hosted domains under that root belong
to the inventory. Use distinct scopes for separate Host roots and never share
one scope between senders. Hosts sharing a Hosted domain must select distinct
`--inventory-host` values; reconnect cannot change an established identity. Capsule identity is `(host, domain/subname)`.

On the Monitoring server, add an exact scope map to the operator-owned `.env`:

```dotenv
INVENTORY_HOSTS='{"capsules.example":"REPLACE_WITH_UNIQUE_HOST_TOKEN"}'
```

Replace the placeholder with a unique random token of at least 16 characters,
without whitespace/control characters. Duplicate tokens across Hosts are
rejected. Run `node setup.mjs` and recreate the gateway with
`docker compose --env-file .compose.env up -d --build gateway`. The map is stored
in protected `.private/credentials.json`, never `.compose.env` or Capsules.
Setup preserves existing settings and never generates/rotates Host authority.
Removing a mapping revokes access without deleting acknowledged expectations.
Changing one mapping rotates only that Host's inventory credential.

On the workstation, supply that token through an environment reference:

```sh
sporades telemetry profile add fleet --endpoint https://monitor.example \
  --credential-env TRACE_INGEST_TOKEN --inventory-credential-env HOST_INVENTORY_TOKEN
sporades host telemetry connect --host personal --profile fleet --json
sporades host telemetry status --host personal --json
```

Inventory and ingestion credentials grant separate roles. If the inventory
reference is omitted, connect uses the ingestion token for inventory too;
it still has no inventory authority unless explicitly mapped to that exact Host.
Prefer a dedicated inventory token, especially when sharing an ingestion token
between Hosts. The Host stores the inventory credential, CA and generation in
mode-0600 `telemetry/connection.json`, alongside the exact destination and scope.
Reconnect atomically publishes this complete connection under the same OS lock
used to capture inventory deliveries. Legacy split credential/CA files remain
readable under that lock until reconnect upgrades them. Secrets are omitted from
status, export and public connection metadata.
Local Dev/Container telemetry ignores the inventory reference.

Upgrade CLI and helper together, then reconnect existing Hosts whose connection
descriptor lacks `inventoryHost`. Bootstrap and telemetry connect/reconcile
install the same `sporades-inventory-<remote-root-hash>.timer`. It requires Node,
Linux `/usr/bin/flock`, outbound verified HTTPS and protected Host state;
Docker/Caddy/application health is not a dependency. Non-systemd local fakes
report `reconcilerInstalled: false`; use `inventory-reconcile` for local checks.

## Wire contract and expectations

`PUT /v1/inventory/<exact-host>` accepts JSON with that Host's bearer token.
`GET` on the same path exports only that scope for recovery. UI and ingestion
credentials do not grant inventory access unless explicitly mapped. No wildcard
scope, deletion endpoint, probe execution or remote-admin action exists.

```json
{
  "schemaVersion": 1,
  "host": "capsules.example",
  "revision": 1,
  "capsules": [{
    "id": "capsules.example/notes",
    "state": "running",
    "changedAt": "2026-10-02T00:00:00.000Z",
    "release": "release-1",
    "targets": ["https://notes.capsules.example/"]
  }]
}
```

States: `registered`, `released`, `running`, `stopped`, `failed`, `deleted`,
`opted-out`. Stopped/deleted/opted-out targets are empty and change active probe
expectations. Lost contact never removes the expected Host or its Capsules.
Deleted identities remain tombstones; omission cannot erase acknowledged
identities. Each Capsule permits its canonical origin plus all 20 supported
registered aliases (21 targets total). Targets are bare HTTP(S) application origins and registered aliases:
no explicit ports, userinfo, queries, fragments, readiness paths/tokens, headers
or response content. Unknown fields, invalid/duplicate identities and oversized
snapshots (1 MiB, 2,000 Capsules) are rejected. No target is fetched here.

Scope identities, Hosted domains and target hostnames use lowercase DNS labels
of 1–63 characters (253 characters total), with letters or digits at each end.
Consecutive internal hyphens and ASCII punycode are supported, including
`a--b.apps.example` and `xn--bcher-kva.example`. Capsule subnames use the same
single-label rule. Every valid Hosted domain under the connected root is included,
even when the exact inventory scope is an independent name such as `host-one`.

Revisions increase on authoritative lifecycle/release/address changes. Matching
retries are idempotent and renew acknowledgement time. Stale updates or changed
content at the same revision return 409; cross-Host writes return 403. Success
is `{ "ok": true, "data": { "revision": 1, "acknowledgedAt": "..." } }`
only after durable persistence. One gateway writer serializes concurrent
per-Host updates, atomically replaces/fsyncs mode-0600 records and owns the
mode-0700 `inventory` volume. Do not share this volume between gateway writers.
Writable inventory storage is a stack `/health` dependency alongside ingestion
and configured trace/metric storage; sender availability is not a dependency.

The Host atomically replaces/fsyncs `telemetry/inventory.json` under an OS lock,
then captures the matching destination, scope, credential and CA before releasing
the lock for HTTPS delivery. Every successful reconnect, including token rotation
at the same endpoint, starts a new generation and invalidates the prior
acknowledgement. Responses from superseded generations are discarded. The outbox stores desired state,
destination, connection generation, acknowledgement, attempt time and bounded failure category.
Incomplete/corrupt registry directories fail closed without erasing expectations.
Periodic reconciliation refreshes from the registry even if a command crashes
before queuing. `host telemetry status --json` reports `inventory.host`,
`desiredRevision`, `acknowledgedRevision`, `acknowledgedAt`, `lastAttemptAt`,
`pending`, `stale`, `failure` and `reconcilerInstalled`. Pending means the latest
revision or connection generation is unacknowledged; stale means no acknowledgement within three minutes.
These fields do not claim probe coverage or alert delivery.

## Recovery and backup

Ordinary operations require no manual import/export. For recovery only:

```sh
sporades host telemetry inventory-export --host personal --json > desired.json
sporades host telemetry inventory-reconcile --host personal --json
# In the Monitoring stack directory; optional final argument is a private CA PEM:
node inventory.mjs export https://monitor.example capsules.example acknowledged.json
node inventory.mjs import https://monitor.example capsules.example desired.json
```

The script reads `.env` locally and uses identical scope, validation and revision
rules. It accepts a Host export envelope, central export envelope or raw snapshot.
Exports use mode 0600 and refuse overwrites. An import cannot roll back later
state. Restore a Host outbox with its registry from the same backup. An older
outbox against newer central state remains visibly conflicting: recover the
newer outbox rather than resetting revisions.

Back up the central `inventory` volume alongside traces, metrics, Grafana,
protected `.env`/`.private`, certificates and config. Metric/trace retention never
expires inventory. Back up the Host registry, connection, credential and outbox
together. Stop the gateway/timer for consistent backups. After restore, run
setup, recreate the gateway, restart the timer and verify a new acknowledgement
and stored lifecycle states. To remove the worker, disable its timer/service;
retain outbox/central history until deliberate removal is appropriate. Sender
revocation or disappearance is never intentional Host deletion.
