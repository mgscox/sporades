# Availability and missing-target alerts

The Monitoring stack independently probes a Capsule's application process and
notifies an operator when acknowledged targets fail or stop exporting telemetry.
Prometheus alone evaluates the rules; Alertmanager groups, silences and delivers
firing and recovery messages. CPU, memory and API performance policy is a separate
slice. Monitoring `/health` remains the minimal ingestion/storage readiness
endpoint; there is no outbound watchdog or required uptime provider.

## Configure a notification channel

Generate a fresh schema-3 stack with `sporades monitoring stack init --dir <path>`.
Existing stack files and operator `.env` additions are preserved: back up the
stack, review reported overrides/version differences, and apply the new Compose,
gateway, discovery, Blackbox and Prometheus assets deliberately during an upgrade.
Never replace your `.env` with the example. After any environment edit, run
`node setup.mjs` and recreate the affected services with
`docker compose --env-file .compose.env up -d --build`.

Set these operator-owned settings in the stack's private `.env`:

```dotenv
ALERT_WEBHOOK_URL=https://notifications.example/your-channel
ALERT_WEBHOOK_TOKEN=your-optional-bearer-token
MONITORING_PUBLIC_URL=https://monitor.example
```

The receiver must understand the standard Alertmanager webhook payload and send
an operator-visible notification. HTTPS is required; loopback HTTP is permitted
for a disposable local acceptance receiver. No channel is silently selected:
without `ALERT_WEBHOOK_URL`, rules still evaluate but notification delivery is
disabled. Structured stack init/validate reports `notificationDelivery` as
`disabled` or `unverified`; it never claims that configuration proves delivery. Verify both a real
firing payload and its resolved recovery in your selected channel before relying
on paging. Each alert includes the target, evaluation window and dashboard link;
payloads also include `startsAt`/`endsAt`. Keep webhook URLs and tokens private.
Setup writes notification configuration with mode 0600 in `.private`, and keeps
notification secrets out of `.compose.env` and validation output.

Use `/alertmanager/` through the Monitoring gateway's existing operator login to
inspect groups and create a timed silence. Grouping is by alert name, Host and
Capsule, with five-second initial grouping, fifteen-second changes and a four-hour
repeat interval. Silence by `host`, `service_name` and/or `alertname`, set an expiry,
and include the maintenance reason. Silencing does not delete inventory or data.
Alertmanager state and silences persist in the `alerts` volume: include it in
backup/restore alongside metrics, traces, Grafana, inventory and the private `.env`.

## Independent probes and durable expectations

[Lifecycle inventory](./lifecycle-inventory.md) supplies authenticated, centrally
acknowledged identities and bare application origins. Running and failed Capsules
are active expectations; registered/released Capsules await start. A Host is
expected while it has at least one active Capsule. Acknowledged stopped, deleted
and opted-out states cease active expectations. Lost sender contact, removal of a
sender credential, or discovery failure never counts as an intentional stop.
Pending intent remains visible as stale inventory until acknowledged.

Prometheus discovers targets every fifteen seconds through the private gateway
listener and probes each origin once through pinned Blackbox exporter. Discovery
refreshes a nonce header for `GET /__sporades/probe` without changing the scrape URL. The running application returns
`sporades-application-probe-v1:<nonce>` with `Cache-Control: no-store`; Blackbox
requires the exact freshly issued nonce in that application marker, a no-store
response, HTTP 200 and no redirects. One bounded module pairs the request nonce header and expected body during configuration reloads; a static replay with the correct marker still fails.
Ordinary HTML, static pages and proxy health responses cannot satisfy the check.
The `Vary` nonce header and no-cache request prevent cached responses. The nonce is never a metric label. Labels
retain the bare origin only; no probe nonces, query strings, readiness tokens or payloads enter
inventory or notifications. Failed or stale nonce refresh is visible as an availability-source failure, even when Blackbox itself still scrapes successfully. Probe traffic is excluded from application traces
and request metrics. The public route reports responsiveness only, without
SQLite, File, inspection, configuration or other protected readiness details.

The Host background inventory worker also checks protected readiness inside
running containers, using the Host-owned token already in the container's
environment. It exports only a readiness boolean and Host contact sample through
the existing private relay. Tokens and readiness internals stay on the Host.
Checks run four at a time within a twenty-second budget; very large fleets may
have incomplete local readiness coverage, while independent public probes and
runtime absence checks continue. No Docker socket is mounted into the relay.
Upgrade the Host helper and reconcile its existing inventory timer to enable
this reporting. Monitoring failures cannot block Capsule lifecycle operations.

## Starting alert policy

| Alert | Trigger | Meaning |
| --- | --- | --- |
| `SporadesProbeFailure` | Probe failure for 60 seconds | Application process or public routing failed |
| `SporadesProbeScrapeFailure` | Blackbox scrape failure for 60 seconds | Probe result unavailable, rather than a known application failure |
| `SporadesCapsuleTelemetryAbsent` | No uptime sample for two minutes | Expected runtime exports missing, even if the public route works |
| `SporadesHostTelemetryAbsent` | No Host contact sample for two minutes | Host worker/relay/transport unavailable; central expectations persist |
| `SporadesLocalReadinessFailure` | Local readiness false for 60 seconds | Protected Host-local readiness failed |
| `SporadesInventoryStale` | No acknowledgement for three minutes | Stored expectations may lag pending lifecycle intent |
| `SporadesAvailabilitySourceFailure` | Component scrape or nonce refresh failure for 60 seconds | Availability monitoring pipeline needs attention |

New active expectations have a two-minute grace period for telemetry absence.
The grace starts at central acknowledgement and does not reset on ordinary
reconciliation or Monitoring restart. Scraping and rule evaluation start at
fifteen seconds. Keep runtime export intervals below two minutes, or deliberately
lengthen absence windows when using slower operator profile overrides. With a five-second probe timeout and five-second grouping, a
sustained failure should notify within two minutes; measure this in your own
acceptance environment. A missing Alertmanager cannot deliver its own alert;
the minimal Monitoring health endpoint alone cannot page on Monitoring VM loss.

Runtime metrics and traces retain the full configured `service.name`. For Hosted
Capsules this is the inventory's exact `domain/subname` identity (up to 317
characters), also used by Host readiness. IDs sharing a prefix remain distinct.
Rebuild and restart Capsules built with an older runtime that truncated this
identity to 80 characters before relying on long-ID absence alerts.

Rules are shipped in `availability-rules.yaml` and rendered into `.private` by
setup. Review and tune these starting thresholds for your installation; do not
add duplicate Grafana evaluators. Separate probe, scrape, readiness, absence and
stale-inventory alerts intentionally retain their diagnostic identities.

## Isolated acceptance

Use disposable Hosts/Capsules and a test notification channel. Never block a
production event loop or stop a production Capsule for validation. Run
`scripts/verify-availability.mjs` from the repository with a worktree-local
`SPORADES_CONFIG_DIR` for a real generated Capsule, pinned Docker stack, finite
100-second blocked-loop drill, webhook alert and recovery, out-of-band stop,
telemetry absence and acknowledged-stop removal. Two 317-character IDs sharing
the first 80 characters remain healthy past the grace window; stopping one must
alert while its sibling keeps exporting. The script uses a unique Compose
project and cleans up only its own resources. The blocked request and webhook
receiver record monotonic timestamps on the same Linux VM, with a strict
120-second delivery assertion. Probe samples, rule state and Alertmanager state
are retained in a per-run notification timeline, including on failure. For
separate-VM acceptance, place the Capsule Host and Monitoring stack
on different disposable VMs, retain verified TLS on the relay, repeat the drill,
and record delivery timestamps, topology and cleanup. After an intentional stop,
wait for its inventory acknowledgement before expecting pages to cease.
