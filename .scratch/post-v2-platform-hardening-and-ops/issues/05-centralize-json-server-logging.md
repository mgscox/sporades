# Centralize JSON server logging

Status: needs-triage
Future target: post-v2, unassigned
Origin: `.scratch/sporades-v2/issues/05-capture-post-v2-platform-hardening-and-ops-markers.md`

## What to plan

Design a centralized JSON server logger that lets agents watch platform and app behavior consistently.

Logs should be emitted as JSON lines for durable append-friendly streaming and
also indexed into SQLite for bounded recent inspection. Docker stdout should
continue to receive JSON log events so existing Container session and Host
server log access remains useful.

App `ctx.log` events and platform runtime events should share one JSON envelope
schema with category-specific event names and metadata. This gives agents one
parser while keeping app, platform, build, auth, storage, host, and security
events distinguishable.

Structured log data should be allowed, but Sporades should apply default
redaction and payload caps. Known-sensitive keys and exact Server env values
must be redacted, and raw request bodies should not be logged by default.

## Acceptance criteria

- [ ] A future PRD defines the JSON log event shape.
- [ ] App logs and platform logs use one shared JSON envelope schema.
- [ ] Log events include category, event name, level, timestamp, message, Capsule identity, release identity when available, request/correlation identity when available, and structured data.
- [ ] The design explains how `ctx.log` writes are captured.
- [ ] Structured log data supports default redaction for sensitive keys such as passwords, tokens, secrets, authorization headers, cookies, and client secrets.
- [ ] Exact Server env values are redacted if they appear in log data.
- [ ] Log events enforce payload size caps.
- [ ] Raw request bodies are not logged by default.
- [ ] JSONL is the primary durable log stream for CLI tailing, Host collection, and crash-adjacent debugging.
- [ ] SQLite stores a bounded recent log index for structured inspection queries.
- [ ] Container sessions and Hosted Capsules emit JSON log events to Docker stdout.
- [ ] The design covers log access from CLI commands and machine-readable output.
- [ ] The design defines how platform logs, app logs, and build/dev-session events relate.
- [ ] v2 does not add centralized logging unless maintainers explicitly promote this marker.

## Notes

The v0 PRD mentions `ctx.log` and `sporades logs`; this marker should reconcile that product language with the current implementation before build work starts.
