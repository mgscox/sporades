# Host pressure and Caddy telemetry — #119

Verified 2026-09-29 using the installed Sporades 0.9.30 package built from this change. No npm release was made. Independent review was explicitly deferred by the operator.

## Delivered paths

- Host OS: node_exporter `v1.12.1`, image digest `sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0`.
- Caddy `2.6.2`: native Prometheus metrics; one top-level `subroute` observation per edge request. The private metrics listener's own HTTP observations are dropped.
- Host relay: Collector `0.138.0`; private bridge scrapes and authenticated outbound OTLP/HTTPS. No public scrape ports, Docker socket or Capsule resource collector.
- Backend: Prometheus `3.13.3`, Grafana `13.2.2`, Jaeger `2.21.0`.
- Shipped and Live helper SHA-256: `7e6ebb021197b462ae8496b74b6be4cec8a78b0144074972a47207f1a76f4e3a`.

## Disposable acceptance

A real Ubuntu 24.04 VM (`sporades-119-test`, 4 logical CPUs, 4 GB RAM) ran the installed CLI/helper, Caddy, Docker and a real generated Capsule. This was not a Docker Desktop Host-resource measurement.

- Fresh bootstrap did not export until explicitly connected. Repeated bootstrap/reconcile preserved Caddy bytes and agent start times.
- Stored RAM was 4,104,339,456 bytes, matching `/proc/meminfo`; a separate 128 MiB mounted data filesystem was present as its own capacity series (108,974,080 usable bytes).
- CPU, memory and disk load ran for 30 seconds with the Capsule event loop blocked. Independent Host collection continued. Observed CPU PSI rate was 0.215, peak 1-minute load 4.1, available-RAM range 1,247,289,344 bytes; disk writes were recorded. Controlled requests produced HTTP 200, three HTTP 503 observations, and a 30.23-second blocked request.
- Invalid Caddy configuration was rejected without replacing the operator file. Nested operator server timeouts survived enablement. Unsupported PSI was reported explicitly. Stopping the exporter produced `up=0`; reconciliation restored it. Remove/bootstrap preserved the disabled policy until explicit enablement.
- Separate-machine monitoring ran on the Mac; same-VM monitoring ran in a second Compose stack on the Linux Host. Both used verified private-CA HTTPS and stored healthy node/Caddy sources with stable Host labels.
- A monitoring gateway outage left Capsule requests at HTTP 200 and the relay running with its 192 MiB memory bound; data resumed after recovery.
- Reboot restored Caddy, node_exporter and the Host relay without the configuring workstation. Stored samples resumed. The existing Capsule `on-failure:3` policy does not restart a cleanly stopped Capsule after a Host reboot; the test Capsule was restarted with `sporades host start`. This pre-existing Capsule lifecycle behavior was not changed by #119.
- All 45 dashboard PromQL expressions executed successfully against stored metrics. Host/Caddy dashboards were visually inspected.

The opt-in `test/host-metrics.acceptance.test.js` runs `scripts/verify-host-metrics.mjs`. Prepare a disposable VM named exactly `sporades-119-test`, an installed CLI wrapper and SSH alias, a registered `acceptance` Host (`acceptance119.example`), a separate `/srv/119-data` mount, and a configured TLS monitoring stack. The harness directory supplies `cli`, `ssh_config`, `certs/cert.pem` and `monitoring/.private/credentials.json`. Set `SPORADES_HOST_METRICS_TEST_ROOT` and `SPORADES_HOST_METRICS_TEST_URL`; optionally set `SPORADES_HOST_METRICS_TEST_EVIDENCE`. It refuses a different VM hostname before mutating anything. Reboot, workload and same-VM drills were additionally executed manually on that disposable VM.

## Live retrofit

Live Host `mattgscox.co.uk` (`168.119.161.21`) was upgraded through the installed CLI and reconciled. A protected recovery point is retained at `/root/telemetry-rollout-backup/host-metrics-119-20260929`.

- Private source endpoints: `172.20.0.1:9100` and `172.20.0.1:20190`; Caddy administration remains `127.0.0.1:2019`.
- Existing Capsule-to-relay network/alias was retained. Both sources were stored with `sporades_host="mattgscox.co.uk"`, distinct `telemetry_source` labels and `up=1`.
- At 18:12 UTC, source samples were 6–15 seconds old. Stored total RAM was 8,122,343,424 bytes, exactly matching the Host.
- [Host pressure dashboard](https://telemetry.mattgscox.co.uk/grafana/d/sporades-hosts) and [Caddy dashboard](https://telemetry.mattgscox.co.uk/grafana/d/sporades-caddy) rendered live graphs. All 45 expressions executed successfully. Existing monitoring UI authentication is still required.
- CIC and Tickets continued returning HTTP 200. Their container start times remained `2026-09-28T16:58:20.367351009Z` and `2026-09-28T17:00:18.308002791Z`. Both retained fresh process metrics (14–17 seconds old), with 119/120 stored series at the check.
- Monitoring `.env` remained byte-identical (`33b7f187acf3b745d932f1ee665604e6a9fa1bcd9a41e1de9e7b49392bf5899a`). Only Grafana was recreated to mount the new dashboards; backend data was retained. Caddy was gracefully reloaded, not restarted.
- No disruptive workload, source outage or reboot was performed on Live.

Grafana's existing anonymous-viewer stars API returns 401 and the gateway does not proxy Grafana Live WebSockets (400). Ordinary dashboard polling and graph rendering work; these existing optional UI features were not changed.

## Automated validation

Build, TypeScript checks, generated CLI/helper parity and `git diff --check` passed. The full suite ran 2,831 tests: 2,580 passed, 202 skipped and 49 Host archive-fixture failures caused by macOS AppleDouble metadata. Rerunning the entire affected Host/relay/monitoring suite with `COPYFILE_DISABLE=1` passed 302 tests, with 9 skips and no failures. The installed-CLI disposable acceptance test also passed. The raw-bundle helper upgrade regression was demonstrated red, then green; a real installed-CLI upgrade succeeded on the disposable VM and Live.

Follow-up: the clean-reboot Capsule limitation above was addressed by the shared
Host autostart installation; see [autostart verification](host-autostart-verification.md).
