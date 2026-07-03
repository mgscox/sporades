# Add centralized JSON logging

Status: ready-for-agent

## Parent

.scratch/production-readiness/PRD.md

## What to build

Add centralized JSON logging so agents can observe app and platform behavior
through structured events. Logs should share one envelope schema across app
`ctx.log` events and platform runtime events, emit to a JSONL log stream, index
recent events into SQLite for inspection, and continue to reach Docker stdout in
Container sessions and Hosted Capsules.

This slice should deliver an end-to-end path: runtime log capture, redaction,
JSONL persistence, bounded SQLite indexing, CLI/JSON inspection, Container and
Host visibility, docs, and tests.

## Acceptance criteria

- [ ] App logs and platform logs use one shared JSON envelope schema.
- [ ] Log events include category, event name, level, timestamp, message, Capsule identity, release identity when available, request/correlation identity when available, and structured data.
- [ ] `ctx.log` writes are captured into the same logging pipeline as platform events.
- [ ] Structured log data supports default redaction for sensitive keys such as passwords, tokens, secrets, authorization headers, cookies, and client secrets.
- [ ] Exact Server env values are redacted if they appear in log data.
- [ ] Log events enforce payload size caps.
- [ ] Raw request bodies are not logged by default.
- [ ] JSONL is the primary durable log stream for CLI tailing, Host collection, and crash-adjacent debugging.
- [ ] SQLite stores a bounded recent log index for structured inspection queries.
- [ ] Container sessions and Hosted Capsules emit JSON log events to Docker stdout.
- [ ] CLI commands expose machine-readable log tailing and recent-log inspection.
- [ ] The design clearly distinguishes app logs, platform logs, build/dev-session events, and `sporades dev --json` lifecycle events.
- [ ] Docs cover the log event envelope, redaction behavior, log retention/index bounds, and CLI inspection commands.
- [ ] `docs/ROADMAP.md` is updated to reflect implementation status.

## Blocked by

None - can start immediately
