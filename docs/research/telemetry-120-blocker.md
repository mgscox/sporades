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
