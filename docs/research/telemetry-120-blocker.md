# Telemetry 13: availability and missing-target alerts

Issue: [#120](https://github.com/mgscox/sporades/issues/120)
Parent requirements: [#107](https://github.com/mgscox/sporades/issues/107)

## Current blocker

The native GitHub dependency graph checked on 2026-10-02 lists #112 as closed
and [#118: Synchronize lifecycle inventory automatically](https://github.com/mgscox/sporades/issues/118)
as open. Issue #120 cannot proceed under the assigned dependency gate until #118
is closed. This document records the blocked handoff for a draft PR; it does not
implement availability alerts or satisfy their acceptance criteria.

Alerts require the centrally acknowledged, durable expected-target inventory
from #118. A missing Host must retain its alert expectations. Acknowledged stops,
deletions and opt-outs must cease active expectations. Building rules against
sender-only state or hand-maintained targets would not meet that contract.

## Remaining work after #118 closes

- Inspect the shipped inventory interface, persistence and reconciliation tests.
- Add pinned Blackbox exporter and Alertmanager services, operator notification
  settings and Prometheus-owned availability rules.
- Reconcile independent probes from acknowledged inventory, check uncached public
  application content and keep protected readiness tokens on the Host.
- Distinguish sustained probe failure (60 seconds), missing expected telemetry
  (two minutes), scrape failure, intentional stop and stale inventory.
- Verify durable expectations after Host loss and removal after acknowledged
  lifecycle changes with focused external-behavior tests.
- Deliver real alert and recovery messages through a selected test channel with
  target, time-range and dashboard context, grouping and silencing.
- Demonstrate bounded failures across disposable separate VMs, with probe-failure
  notification within two minutes; preserve the minimal Monitoring health route.
- Update operator documentation and affected public/config contracts, regenerate
  shipped artifacts, and run typecheck, the full test suite and available Docker
  telemetry acceptance checks.

## Scope and assumptions

The follow-up request authorizes committing this blocker record and opening a
draft PR despite the usual stop-without-PR dependency gate. It does not waive the
implementation dependency or approve production failure drills. No runtime,
monitoring configuration, credentials, infrastructure or production endpoints
are changed by this handoff. CPU, memory and API performance rules remain owned
by ticket 14.

## QA round 1 follow-up

The draft also repairs two existing test-fixture problems identified by QA:

- Host archive builders disable implicit macOS AppleDouble metadata. Explicitly
  inserted metadata and other unsafe archive entries remain subject to the
  existing rejection tests; production archive validation is unchanged.
- The gateway cancellation test waits for each backend response's close event
  within one second. Receiving a gateway 504 and observing the backend close
  occur asynchronously across processes, so an immediate boolean assertion was
  a race. Client-abort cancellation is checked separately with the same bound.

These test changes do not implement any of #120's alert acceptance criteria.
Native dependencies were rechecked after QA: #118 remains open and #112 closed.
The PR must remain draft until the availability implementation and its required
isolated acceptance work are complete.

## QA round 2 follow-up

Poirot independently verified the fixture fixes at `c439fa90`: the full suite
passed with 2,670 tests passed, zero failed and 204 optional skips. Host archive,
gateway cancellation, Docker telemetry and documentation checks also passed.
This verifies the fixture repairs, not the unimplemented availability slice.

The todo Capsule's **Sign in with Anonymous** action returned
`Unsupported auth provider: anonymous`. Sign-in smoke therefore **failed**.
The scaffold and auth implementation are unchanged from `origin/main`; the
defect is tracked separately in
[#194: Todo scaffold offers unsupported anonymous sign-in](https://github.com/mgscox/sporades/issues/194).
It is not repaired by this telemetry PR.

The native dependency graph was rechecked after round 2: #118 remains open and
#112 closed. Keep #192 draft. Availability configuration, inventory-derived
probes, durable expectations, timed rules and notification/recovery delivery
remain the work listed above, followed by authorized disposable separate-VM
acceptance using an operator-selected test notification channel.
