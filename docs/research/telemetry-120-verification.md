# Issue #120 availability acceptance

See the [Poirot round-1 follow-up](./telemetry-120-round-2.md) for the persistence
regression, its fix, and fresh validation. The original author evidence below
does not supersede Poirot's failed full-suite result.

Verified on 2026-10-03 using disposable resources. Native blockers #112 and #118
were closed before implementation. The branch integrates the current main
WebSocket telemetry implementation and preserves the parked #192 history.

## Observable behavior

- Acknowledged inventory drives private discovery and durable expectations.
  Sender loss, sender credential removal, and Monitoring restart cannot remove
  expectations. Explicit acknowledged stop, deletion, or opt-out does.
- Public probes require an exact freshly issued nonce and no-store application
  response. A static replay with the correct marker and an old nonce fails.
  Protected readiness remains inaccessible publicly; only its boolean leaves
  the Host through the private relay.
- Prometheus alone evaluates availability rules. Real Alertmanager webhook
  payloads include the target, failure window, timestamps, and dashboard URL;
  firing and resolved recovery were both received.
- Rule fixtures distinguish failed probes from failed scrapes, apply 60-second
  probe and two-minute telemetry absence windows, and remove stopped targets.
  CPU, memory, and API performance rules remain outside this slice.

## Separate VM drill

Two task-owned Ubuntu 24.04 KVM VMs on Tower's private NAT ran Docker 29.0.0,
Compose 2.40.3, and Node 24.13.0. One VM ran the Capsule Host, generated Capsule,
Host helper inventory timer, and private telemetry relay. The other ran the
pinned Monitoring stack and an isolated webhook test receiver. The relay used
verified private-CA TLS. No production Capsule or monitoring endpoint was used.

A finite 100-second blocked event loop produced a real probe-failure notification
in **87,262 ms**, followed by a resolved recovery. Host-owned protected readiness
was observed through its relay boolean. Stopping the Host timer, Capsule, and
relay retained the central Host/Capsule expectations and produced a missing-Host
alert. Updating the authoritative Host registry to stopped and reconciling its
HTTPS acknowledgement removed the active Capsule expectation.

[Recorded VM evidence](./telemetry-120/vm-acceptance.json) includes alert context.
Both task-owned VMs were destroyed and undefined; their task directory and disk
images were removed. Existing VMs and unrelated infrastructure were preserved.

## Repository and Docker checks

The reproducible local drill uses a worktree-local configuration directory:

```sh
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-120/config" node scripts/verify-availability.mjs
COPYFILE_DISABLE=1 SPORADES_CONFIG_DIR="$PWD/.sporades/issue-120/config" npm test
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-120/config" npm run typecheck
SPORADES_CONFIG_DIR="$PWD/.sporades/issue-120/config" npm run docs:check
```

The local Docker drill uses a real generated Capsule, pinned services,
Prometheus rule fixtures, and Alertmanager firing/recovery webhooks. It covers
static replay rejection, protected readiness denial, a finite blocked loop,
out-of-band stop with persistent expectation, runtime absence, and acknowledged
stop removal. [Recorded Docker evidence](./telemetry-120/docker-acceptance.json)
distinguishes its single Docker VM topology from the separate-VM drill.

Combined-branch typecheck and documentation checks passed (53 documentation tests
and a successful VitePress build). Focused external behavior tests passed, including
failed/stale nonce refresh and recovery without removing expectations. The final
Docker drill notified in **96,094 ms**, received recovery, passed five Prometheus
rule scenarios and Alertmanager configuration validation, and removed its own
containers, networks, volumes, and local gateway image.

The packed installed-CLI private-CA Docker acceptance passed. Its optional
pre-descriptor CLI drill was skipped because no legacy CLI path was supplied.
A schema-3 monitoring release archive was generated locally and checked for the
new availability/Blackbox assets; nothing was published.

The full combined-branch `npm test` run passed: **2,732 passed, 207 optional skips,
0 failures** (2,939 tests; 20 minutes 7 seconds). Its pretest rebuilt shipped
artifacts and checked generated-bin parity.

## Browser checks and assumptions

The operator documentation and authenticated Alertmanager UI were checked at
1440×1000 and 390×844. Both fit without horizontal overflow and had no application
console errors. Keyboard navigation reached a focused link. A timed silence was
created for the disposable Host/probe alert, observed active, then expired.
Screenshots: [docs desktop](./telemetry-120/availability-desktop.png),
[docs phone](./telemetry-120/availability-phone.png),
[silence desktop](./telemetry-120/alertmanager-silence-desktop.png), and
[silence phone](./telemetry-120/alertmanager-silence-phone.png).
The docs server, browser sessions, and test tunnel were stopped.

The selected test channel was an isolated Alertmanager-compatible webhook
receiver, with payload receipt checked directly. Operators must select their own
channel and prove firing/recovery delivery before relying on paging. Notification
configuration alone is reported as unverified, or disabled when no URL is set.
A Host is expected while it has an active running/failed Capsule. Profiles using
exports slower than two minutes require an explicitly longer absence window.
Host readiness work is bounded; very large fleets may have incomplete readiness
coverage while public probes and telemetry absence remain independent.
