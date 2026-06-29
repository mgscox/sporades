# Add automatic OpenTelemetry

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design automatic OpenTelemetry instrumentation so agents and developers can monitor running Capsules without hand-wiring observability in app code.

## Acceptance criteria

- [ ] A future PRD defines the default traces, metrics, and logs emitted by dev sessions and container sessions.
- [ ] The design explains how telemetry is configured through CLI and project configuration.
- [ ] The design avoids requiring app code to import OpenTelemetry directly for default platform signals.
- [ ] The design covers local-first behavior when no collector is configured.
- [ ] v2 does not add automatic OpenTelemetry unless maintainers explicitly promote this marker.

## Notes

This marker is separate from JSON logging so each can be scoped and implemented independently.
