# Packaged monitoring release acceptance — #131

Status: **blocked; release acceptance has not passed** (2026-10-07).
This record accompanies a draft PR. It does not authorize rollout or claim a
production canary; canary execution belongs to ticket 25 (#132).

## Prerequisite gate

The GitHub native blocker audit for [#131](https://github.com/mgscox/sporades/issues/131)
found #128 open. The other ten native blockers (#113, #115, #121, #122, #123,
#124, #125, #126, #129 and #130) were closed. The separately named dependency
#120 was also closed. Issue closure is a prerequisite state, not evidence that
the assembled release passed this ticket's integration gates.

The latest [#128 scenario 3 checklist](https://github.com/mgscox/sporades/issues/128#issuecomment-6040548665)
explicitly describes pending manager-only separate-VM acceptance. It requires
interrupted activation followed by autonomous recovery with the controller off,
readable Collector config and CA files, independent production trace/metric
delivery, inventory acknowledgement, retained history and applied rollback.
Complete that checklist and obtain manager sign-off before resuming #131.

Desk safety prohibits real Host commands, SSH and cloud operations. Local fakes
and Docker cannot replace real separate-VM final deployment evidence. This draft
records the handoff; it does not change Host behavior or bypass the blocker.

## Candidate and evidence boundaries

The audited checkout is `9e460853588a53144509e9f719b47a534314b5f9`.
Its package declares Sporades `0.9.31` and Node `>=22.13.0 <23 || >=24`.
The local verification runtime is Node `24.19.0`, npm `11.17.0`, macOS.
The Base Dockerfile declares `node:22.14-alpine`, image version
`0.2.0-node22-alpine`. These are source declarations, not an accepted runtime
matrix or deployment result. No monitoring Compose stack or installed generated
Capsule acceptance has been run for this record.

On resumption, pin the final checkout, npm tarball, installed CLI, Host helper,
generated-source manifest and monitoring release archive with SHA-256 hashes.
Record actual image digests, OS/architecture, runtime versions, VM identities,
UTC timestamps and command exits. Run every desk Sporades command with
`SPORADES_CONFIG_DIR` inside its worktree. Use dedicated isolated configuration
on the authorized operator's controller; preserve credentials in protected
files and publish only redacted evidence.

## Remaining acceptance work

Every row below is **pending**. Attach evidence to the final pinned candidate;
earlier prerequisite reports or successful unit tests cannot fill these rows.

| Gate | Required record |
| --- | --- |
| Execution modes and topologies | Installed CLI, actual generated Capsule and monitoring Compose in Dev, local Container and Hosted modes; same-VM and real separate-VM coverage. Run the generated app without app `node_modules`. Record which mode/topology combinations are supported and why any surface is unsupported. |
| Assembled signals | Stored production traces, request/runtime/Host/Caddy metrics, existing-log correlation, default Hosted coverage and opt-out, automatic inventory, authenticated transport, readiness, and actual alert firing and recovery delivery. Inventory or relay acceptance alone is insufficient. |
| Privacy and concurrency | Seed synthetic sensitive values across signal families and inspect stored output for leaks. Repeat concurrent-context isolation against the installed generated app; retain deny/revocation and cross-Host authentication results. |
| Quotas and recovery | Repeat quota/unit/reset, prolonged pipeline outage, credential migration and lifecycle interruption/recovery drills against the same pinned artifacts. Prove preserved application data and backend history, current inventory and fresh stored delivery after recovery. |
| Performance | Apply identical representative load with monitoring off/on, recording workload, warmup, duration and samples. Require p95 latency regression <=5% and throughput loss <=5%; document fixed and load-dependent memory budgets and demonstrate no sustained growth. Resolve failed gates before rollout. |
| Runtime and capacity | Record tested runtime/image matrix, capacity under measured load, trace/metric retention, configured disk caps, observed disk usage and headroom. Source defaults alone do not establish measured capacity or retention safety. |
| Release parity | Build/typecheck, full suite and applicable focused regressions; generated-source and installed-package parity on the final artifacts. Record skips and unsupported surfaces separately from passes. |

Use the prerequisite operator workflows in
[telemetry diagnostics](../reference/telemetry-diagnostics.md),
[monitoring outage recovery](https://github.com/mgscox/sporades/blob/9e460853588a53144509e9f719b47a534314b5f9/monitoring/trace/OUTAGES.md),
[monitoring maintenance](https://github.com/mgscox/sporades/blob/9e460853588a53144509e9f719b47a534314b5f9/monitoring/trace/MAINTENANCE.md) and
[Host provisioning](../agents/host-provisioning.md).
Retain failed attempts and subsequent successful observations separately.

## Draft validation

Local checks establish repository health only. All deployment, alert-delivery,
load, capacity and separate-VM release acceptance gates above remain pending.

- `npm run typecheck`: passed.
- `COPYFILE_DISABLE=1 npm test`: **failed**, exit 1; 3,192 tests, 2,963 passed,
  2 failed, 227 skipped, zero cancelled (3,256,265 ms). Its pretest build and
  generated CLI freshness check passed. Failures were the Apple HTTPS browser
  tracer's raw WebSocket message timeout and the Host helper's read-only
  inspection-during-route-mutation timing assertion.
- Focused rerun:
  `node --test --test-concurrency=1 --test-name-pattern='Apple HTTPS browser tracer completes|keeps read-only Capsule inspection available during a route mutation' test/dev.test.js test/host.test.js`:
  both passed, exit 0. This does not replace the failed full-run result or
  establish its cause. The full-run failures remain unresolved; obtain a green
  full suite on the eventual release candidate before accepting #131.
- `npm run docs:build`: passed (existing chunk-size warning).
- Playwright: the new page rendered at desktop and 390 x 844 phone widths;
  its telemetry-diagnostics link opened the expected operator page. The correct
  page reported zero console errors/warnings. An initial request without the
  site's `/sporades/` base returned 404 and was corrected. Browser and owned
  docs server on port 5218 were stopped.

Checks used `SPORADES_CONFIG_DIR="$PWD/.sporades/issue-131-config"`.
Local logs and screenshots are retained under ignored `logs/issue-131/`.
No runtime, public/config contract or shipped artifact change was needed for
this documentation handoff.
