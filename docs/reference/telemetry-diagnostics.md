# Diagnose and move Monitoring connections

Host diagnostics execute through the authenticated helper **on the selected Host**.
They use its protected, resolved connection, rather than the workstation's current
Telemetry profile. A saved endpoint, a running relay, and an HTTP 200 are separate
facts. None alone establishes stored telemetry.

## Sender checks

```sh
sporades host telemetry check --host personal --json
sporades host telemetry check --host personal \
  --query-credential-env MONITORING_OPERATOR --json
```

Load `MONITORING_OPERATOR` securely as the Monitoring gateway's existing operator
`user:password` credential. Its environment **name**, never its value, appears in
commands. It travels through authenticated SSH for this invocation and is not
saved in the Host connection, Telemetry profile, Collector configuration or
Capsule Sealed Server env. Ingestion and inventory bearer tokens cannot query.
The diagnostic API restricts this operation to a single exact trace identity;
it returns visibility/freshness booleans and never backend trace contents or an
arbitrary query. The existing dashboard operator authority remains independent.

The structured result has `origin: "host"` and a `checks` object. Each check uses
`state: passed | failed | unavailable | unsupported` and an optional opaque
`reason`. This additive result retains direct-delivery `accepted`, `stage`,
`statusCode`, `traceId`, `relayReady`, `relayAccepted`, and `backendStorage` fields.

| Check | Evidence |
| --- | --- |
| `configuration` | Protected saved descriptor, ingestion credential, Collector configuration and required CA are present and valid; the Collector file must match the generated configuration for the saved binding and resource policy. Drift requires reconcile. An interrupted activation needs reconciliation. |
| `agentReadiness` | The owned relay container is running and has no pending activation. This is process readiness; receiver acceptance is a separate check. |
| `dns` | Sender-side name lookup, or a literal address without DNS. |
| `tls` | Sender-side verified TLS handshake with the saved CA. Verification is never disabled. |
| `authentication` | The authenticated destination returned HTTP 2xx, independently of OTLP body acceptance, or explicitly denied the credential with 401/403. Other responses and transport failures cannot prove authentication. |
| `otlpAcceptance` | Direct diagnostic trace accepted without a partial rejection. |
| `relayAcceptance` | A different trace accepted through the Host-private relay receiver. Missing tools/images, rejection or receiver failure cannot prove acceptance. |
| `backendQuery` | An operator query finds that exact relay trace in Jaeger. |
| `recentIngestion` | That relay trace has a recent diagnostic span timestamp, within two minutes with five seconds of clock tolerance. |

An authenticated HTTP 200 with rejected spans reports `authentication: passed`
and `otlpAcceptance: failed`. A malformed OTLP response body also leaves
authentication passed while OTLP acceptance fails; neither proves stored data.

`backendStorage: "verified-relay-trace"` requires both query visibility and recent
relay ingestion. Direct and relay trace IDs differ, so direct destination success
cannot hide a broken relay exporter. This verifies the **trace** signal only;
it does not certify metrics ingestion, all Capsule traffic, historical database
completeness, or an entire Monitoring stack. Capsule coverage remains available
through `host telemetry status` and its protected runtime probes.

Without operator authority, unreadable storage or unavailable relay evidence,
storage is `verification-unavailable`. Older gateways returning 404/405 mark the
query check `unsupported` with `gateway-upgrade-required`; unexpected older
responses are explicitly unavailable. Update the generated Monitoring distribution
and Host helper together. Requests and responses have deadlines and size limits;
raw backend errors, tokens, passwords and certificate contents are omitted.

## Controlled migration

Register a destination profile using the established profile and sender workflows.
Issue distinct ingestion and exact Host inventory capabilities at the destination;
retain the persisted `inventoryHost`, even when the workstation alias differs.
Keep the old profile and protected credentials available for rollback.

```sh
sporades host telemetry status --host personal --json
sporades host telemetry migrate --host personal --profile replacement \
  --query-credential-env DESTINATION_OPERATOR --json
sporades host telemetry status --host personal --json
sporades host telemetry check --host personal \
  --query-credential-env DESTINATION_OPERATOR --json
```

Migration requires an already resolved Host inventory binding. Before changing it,
the **Host** verifies destination OTLP acceptance, a readable fresh diagnostic
trace and the exact inventory capability. Unverified/unsupported destinations
return `activation: "not-applied"`, the failed/unavailable stages and
`rollback: "working-binding-preserved"`; the CLI exits unsuccessfully. A
concurrent binding change invalidates the verification and prevents activation.

Successful activation persists the replacement connection and reports
`activation: "applied"`, the prior endpoint, a fresh
inventory reconciliation, independent post-activation relay verification and
Capsule coverage. It preserves Host inventory identity, Capsule lifecycle/data,
opt-outs, resource collection and unspecified timing/propagation settings. It
restarts the shared relay and reports `relayRestarted: true` when exports are
enabled. A Host-wide export pause remains saved at the destination and reports
`relayRestarted: false`; migration and repeated reconciliation keep the relay
and resource exporter stopped. Ordinary `host telemetry connect` deliberately
re-enables exports. Capsule restarts are **not automatic**: inspect
`coverage.capsuleCoverage.pendingRestart` and explicitly restart those Capsules
whose runtime configuration needs updating. A destination outage after preflight
can still leave verification failed or inventory pending; applied configuration
is not a delivery guarantee. Worker installation and unavailable post-activation
checks are reported without hiding the applied state.

The activation journal is helper-owned mode 0600. Failure before descriptor
publication restores previous configuration, credentials and CA and restarts the
previous relay only when exports were enabled. A deliberately disabled binding
keeps its relay and resource exporter stopped through rollback and recovery.
`host telemetry exports-disable` settles any older activation before publishing
its opt-out intent and serializes shutdown with reconnect.
If recovery fails, the protected journal remains and the error
requires reconcile. An abrupt interruption before commit is repaired by
`host telemetry reconcile` or the existing Host inventory timer; interruption
after descriptor publication completes cleanup of the committed generation.
The timer and relay restart policy operate independently of the workstation.
On a Host without systemd, automatic recovery is unavailable: the worker result
reports that limitation, and the operator must run reconcile.

A changed generation clears the previous acknowledgement and creates a fresh
inventory revision at the destination. Check `inventory.pending: false` and a
current destination acknowledgement, then confirm actual production metrics and
traces before revoking old credentials. The old Monitoring server is untouched:
its stored history is preserved, and its old expectations remain active until
explicitly retired. `oldInventory: "operator-retirement-required"` records this.
Use the old server's documented inventory recovery/import workflow with its
operator authority to publish a later revision marking migrated identities
`opted-out` (empty targets), or apply an operator silence during transition.
Do not delete history or reset revisions to hide missing-target alerts. Keep the
old expectation snapshot for rollback and restore expectations with a later
revision if returning to that server.

## Rollback and acceptance

For a rejected preflight, fix destination TLS/credentials/storage and retry; the
working binding has not changed. For a pending interrupted activation:

```sh
sporades host telemetry reconcile --host personal --json
```

For an applied migration, run the same migration command with the retained old
profile and old server's operator query authority. Verify a fresh old-server
inventory acknowledgement and recent relay trace, then retire replacement-server
expectations separately. If the old server is temporarily unreachable and an
operator deliberately needs to restore the saved binding without verified
storage, the existing `host telemetry connect --profile old` is the explicit
unverified recovery path. Its restart and coverage reports still require review.
Do not revoke either server's rollback credentials until its recovery window ends.
No historical trace database is automatically moved, no VM is provisioned, and no
general remote administration interface is added.

Release acceptance requires a real Host VM and a distinct Monitoring VM. Record
Host-origin stage results, a fresh destination inventory acknowledgement, exact
relay trace lookup and independent production metric/trace queries. Disconnect
the workstation and restart the Host; repeat verification from the saved binding.
Exercise a destination with failed TLS/auth/storage, confirm the old binding and
traffic remain working, then exercise interruption and rollback. Account for old
missing-target expectations and prove stored history survives. Local HTTPS tests
and Docker boundary fakes do not establish this separate-VM acceptance.
